// The far end of a LiveKit call, as its own Node process.
//
// Compiled into the Rust binary with `include_str!` and written to disk at
// start. That is not a trick to save a file — it removes the agent from the
// packaging problem entirely: no bundle entry to forget, no resource path that
// differs between `cargo tauri dev` and an installed .app, and no way for the
// script and the Rust that spawns it to drift apart between releases.
//
// It registers as a worker with NO agent name, which is what makes LiveKit
// dispatch it automatically to every room that opens. The alternative — a named
// agent plus an explicit dispatch call — is the same behaviour with a REST
// client in Rust to maintain.
//
// Two modes, decided by whether a key reached us:
//
//   assistant — the chosen vendor's realtime API hears the microphone directly
//               and answers in audio. Turn detection, interruption and
//               synthesis belong to the model, which is the entire reason for
//               choosing speech-to-speech over an STT → LLM → TTS chain we
//               assemble ourselves.
//   echo      — no key: whatever it hears goes straight back. Not a fallback
//               pretending to be an assistant, and it does not claim to be one.
//               It exists so that a machine with nothing set up can still prove
//               its microphone, its speakers and this whole pipe work.
//
// No vendor is imported at the top of this file. Rust names one in
// CINDERPAW_LIVE_PROVIDER and installs that plugin and no other, so a static
// import of Google's would crash an OpenAI call on `ERR_MODULE_NOT_FOUND`
// before a single line of this ran — and in a forked job process, where the
// error goes to a log nobody has open rather than to the screen.
import {
  AgentSessionEventTypes,
  cli,
  defineAgent,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  stt,
  tts,
  voice,
  WorkerOptions,
} from '@livekit/agents';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RATE = 48000;
const CHANNELS = 1;

/** No key ⇒ echo. Read once, so the mode cannot change mid-call. */
const API_KEY = process.env.CINDERPAW_LIVE_API_KEY ?? '';
/** Which vendor Rust resolved. Empty is echo, and echo needs no plugin. */
const PROVIDER = process.env.CINDERPAW_LIVE_PROVIDER ?? '';
const MODEL = process.env.CINDERPAW_LIVE_MODEL || '';
const VOICE = process.env.CINDERPAW_LIVE_VOICE || '';
const INSTRUCTIONS = process.env.CINDERPAW_LIVE_INSTRUCTIONS || '';
/** Local pipeline only: which on-device engines to use. */
const STT_MODEL = process.env.CINDERPAW_LIVE_STT_MODEL || 'small';
/** `local` (Whisper here) or a cloud id such as `groq`. */
const STT_PROVIDER = process.env.CINDERPAW_LIVE_STT_PROVIDER || 'local';
/** ISO-639-1 the app already knows the user speaks. */
const STT_LANGUAGE = process.env.CINDERPAW_LIVE_STT_LANGUAGE || '';
const TTS_ENGINE = process.env.CINDERPAW_LIVE_TTS_ENGINE || 'piper';
/**
 * Whether this call is the assembled local pipeline rather than a vendor's
 * speech-to-speech session.
 *
 * Sent by Rust as a flag rather than inferred from the provider id here. The id
 * is Rust's to name, and a second file comparing it against a hard-coded string
 * is a second opinion that is free to be wrong — which it was: this read
 * `'local'` while the table said `'pipeline'`, so the whole local mode was
 * unreachable and became an echo with no explanation anywhere.
 */
const PIPELINE = process.env.CINDERPAW_LIVE_PIPELINE === '1';

/**
 * How each vendor's realtime model is constructed.
 *
 * The differences are real and not worth hiding behind an adapter: Google takes
 * `contextWindowCompression`, OpenAI takes `turnDetection`, and the two
 * transcription options are spelled differently on each. One function per
 * vendor says exactly what that vendor is given, which is what somebody
 * debugging a call at 3am actually needs to read.
 *
 * The import is dynamic and inside the function so that only the plugin Rust
 * installed is ever loaded.
 */
/**
 * The local pipeline: this machine hears, this machine thinks, this machine
 * speaks.
 *
 * Speech-to-speech needs a cloud key by definition — one vendor's session does
 * all three parts. That is fine as an option and wrong as the only one: Piper
 * ships five Romanian voices that exist nowhere else, Whisper runs on the CPU,
 * and a local-first product whose voice feature requires an account has quietly
 * stopped being local-first.
 *
 * None of the three pieces live in this process. They live in the Rust binary
 * that spawned it, reached over the same loopback API and the same bearer token
 * the tool calls already use — so this adds no new door, no new port and no
 * second copy of a model.
 */
class LocalSTT extends stt.STT {
  label = 'cinderpaw.LocalSTT';
  constructor() {
    // Not streaming: Whisper transcribes a finished utterance, not a live
    // stream. Declaring it honestly is what makes the SDK wrap this in its own
    // VAD-driven adapter — claiming `streaming: true` would have the framework
    // wait for interim results that never arrive, and the call would hear
    // nothing while looking connected.
    super({ streaming: false, interimResults: false });
  }
  get provider() { return 'cinderpaw'; }
  get model() { return STT_PROVIDER === 'local' ? STT_MODEL : STT_PROVIDER; }

  async _recognize(buffer) {
    const { data, sampleRate } = flatten(buffer);
    const pcm = toFloat32(data, sampleRate, 16000); // what Whisper wants
    const res = await fetch(`${API_URL}/runtime/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        pcm: Array.from(pcm),
        model_size: STT_MODEL,
        provider: STT_PROVIDER,
        language: STT_LANGUAGE || undefined,
      }),
    });
    if (!res.ok) {
      const why = await res.text();
      // Thrown, not returned empty. An empty transcript is indistinguishable
      // from a person who said nothing, and "the model is not downloaded" is
      // exactly the failure somebody can act on if they are told.
      // Each of these is something a person can act on, so each is named.
      // A single "transcription failed" would send somebody looking at their
      // microphone when the real answer is a missing key or a missing file.
      if (why === 'model-missing') {
        throw new Error('The local transcription model is not downloaded yet (Settings → General).');
      }
      if (why === 'stt-no-key') {
        throw new Error(`No ${STT_PROVIDER} key is stored, so this call cannot hear you.`);
      }
      throw new Error(`Transcription failed: ${why}`);
    }
    const { text } = await res.json();
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: text ?? '', language: '', startTime: 0, endTime: 0, confidence: 1 }],
    };
  }
}

/** One utterance of local synthesis, pulled as PCM and pushed as frames. */
class LocalTTSStream extends tts.ChunkedStream {
  label = 'cinderpaw.LocalTTSStream';
  async run() {
    const res = await fetch(`${API_URL}/runtime/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        provider: TTS_ENGINE,
        // `this.tts.voiceName`, not `VOICE`. In a realtime call VOICE names the
        // VENDOR's voice ("Kore", "Charon"), which means nothing to piper and
        // would be sent as a voice id that does not exist.
        voice: this.tts?.voiceName ?? null,
        text: this.inputText,
      }),
      signal: this.abortSignal,
    });
    if (!res.ok) throw new Error(`Local speech failed: ${await res.text()}`);
    // The engine's rate, not a constant. Piper voices are 22.05 kHz and playing
    // those at 24 makes the voice fast and high while looking like it works.
    const rate = Number(res.headers.get('x-sample-rate')) || 24000;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const requestId = String(++nextCallId);
    this.queue.put({
      requestId,
      segmentId: requestId,
      frame: new AudioFrame(samples, rate, 1, samples.length),
      final: true,
    });
    this.queue.close();
  }
}

class LocalTTS extends tts.TTS {
  label = 'cinderpaw.LocalTTS';
  /**
   * `voiceName` is the local engine's voice, or null to let it choose.
   *
   * The pipeline passes the one the person picked. The realtime path passes
   * null, because there the picked voice belongs to the vendor and this engine
   * has never heard of it.
   */
  constructor(voiceName = VOICE || null) {
    // The rate declared here is what the session resamples TO; the frames
    // themselves carry the engine's real rate, which is why the header above
    // is read rather than assumed.
    super(24000, 1, { streaming: false });
    this.voiceName = voiceName;
  }
  get provider() { return 'cinderpaw'; }
  get model() { return TTS_ENGINE; }
  synthesize(text, connOptions, abortSignal) {
    return new LocalTTSStream(text, this, connOptions, abortSignal);
  }
}

/** The local model, over the same `/runtime/chat` the rest of the app uses. */
class LocalLLMStream extends llm.LLMStream {
  label = 'cinderpaw.LocalLLMStream';
  async run() {
    // The newest thing the person said, and nothing else.
    //
    // This used to post the whole `chatCtx` as `messages`, which was wrong
    // twice. `/runtime/chat` has no `messages` field: it takes `content` plus a
    // session id and rejects anything else, so every turn of an on-device call
    // came back 422 and the model was never reached. And the history is the
    // sidecar's to keep (it is the same store the typed chat uses, and it
    // compacts), so sending a transcript that grew by two entries a turn was
    // also the reason a long call answered slower and slower.
    const items = this.chatCtx.items.filter((i) => i.type === 'message');
    const last = [...items].reverse().find((i) => i.role !== 'assistant' && i.role !== 'system');
    const content = last
      ? Array.isArray(last.content)
        ? last.content.filter((c) => typeof c === 'string').join(' ')
        : String(last.content ?? '')
      : '';
    // Stream, not wait-for-full: the non-streaming path blocked the turn for
    // the whole generation (10-20s on a local 7B), so the screen stayed on the
    // stale transcript until the answer was complete. Streaming puts the first
    // token on screen in <1s and lets the TTS start while the rest is still
    // being generated, which is the same reason every other surface streams.
    const res = await fetch(`${API_URL}/runtime/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      // One session per call, named after the room. Stable for the whole call,
      // so the sidecar keeps the conversation and compacts it; different for
      // the next one, so two calls do not bleed into each other. The persona is
      // the sidecar's too, which is why no `system` is sent from here.
      // Spoken, and it has to say so: without it the reply is the desktop's
      // full markdown read out loud.
      body: JSON.stringify({ content, session_id: SESSION_ID, stream: true, surface: 'voice' }),
      signal: this.abortSignal,
    });
    if (!res.ok) throw new Error(`Local model failed: ${await res.text()}`);
    // SSE: `data: {"content":"..."}` lines then `data: [DONE]`. Fall back to
    // non-stream JSON if the server ever returns it.
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') && !ctype.includes('event-stream')) {
      const body = await res.json();
      const text = body.content ?? body.text ?? body.message?.content ?? '';
      this.queue.put({ id: String(++nextCallId), delta: { role: 'assistant', content: String(text) } });
      this.queue.close();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawAny = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const ev = JSON.parse(payload);
            // Sidecar emits `{content}` per chunk; be liberal.
            const delta = ev.content ?? ev.text ?? ev.delta?.content ?? ev.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              sawAny = true;
              this.queue.put({ id: String(++nextCallId), delta: { role: 'assistant', content: String(delta) } });
            }
            if (ev.done) break;
          } catch {
            // Not JSON (e.g. keepalive) — ignore.
          }
        }
        if (this.abortSignal?.aborted) break;
      }
    } finally {
      // If the stream produced nothing (e.g. server fell back to non-SSE),
      // try to parse whatever is left as JSON.
      if (!sawAny && buf.trim()) {
        try {
          const ev = JSON.parse(buf);
          const text = ev.content ?? ev.text ?? '';
          if (text) this.queue.put({ id: String(++nextCallId), delta: { role: 'assistant', content: String(text) } });
        } catch {}
      }
      this.queue.close();
    }
  }
}

class LocalLLM extends llm.LLM {
  label() { return 'cinderpaw.LocalLLM'; }
  get provider() { return 'cinderpaw'; }
  chat({ chatCtx, toolCtx, connOptions }) {
    // `connOptions` is optional on `chat` and REQUIRED by the stream. Passing
    // it through undefined compiles and then loses every retry and timeout the
    // framework sets, which shows up as a call that hangs instead of failing.
    return new LocalLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

/** `AudioBuffer` is a frame or a list of them; both have to work. */
function flatten(buffer) {
  const frames = Array.isArray(buffer) ? buffer : [buffer];
  const sampleRate = frames[0]?.sampleRate ?? 48000;
  const total = frames.reduce((n, f) => n + f.data.length, 0);
  const data = new Int16Array(total);
  let at = 0;
  for (const f of frames) { data.set(f.data, at); at += f.data.length; }
  return { data, sampleRate };
}

/**
 * Int16 at one rate → float32 at another.
 *
 * Nearest-sample, deliberately: this feeds a speech recogniser, the ratio is a
 * downsample from 48k to 16k, and the artefacts a proper filter would remove
 * sit above the band Whisper reads. A resampling library here would be a
 * dependency for a difference the model cannot hear.
 */
function toFloat32(data, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = data[Math.floor(i * ratio)] / 32768;
  return out;
}

/**
 * Loading a vendor's plugin, kept separate from constructing its model.
 *
 * The load is the slow half — a module graph plus native bindings, seconds of
 * it — and it is the half that can happen BEFORE anyone is in the room. See
 * `prewarm` at the bottom: it calls these, the module system caches the result,
 * and the `await import` inside `REALTIME` below is then free. Constructing the
 * model early would be the wrong thing to hoist: it may open a session, and a
 * session opened for a call nobody has started yet is a vendor bill for silence.
 */
const PLUGIN = {
  google: () => import('@livekit/agents-plugin-google'),
  openai: () => import('@livekit/agents-plugin-openai'),
  // Not a vendor: the voice activity detector the local pipeline needs.
  pipeline: () => import('@livekit/agents-plugin-silero'),
};

/**
 * When the vendor decides you have stopped talking.
 *
 * This is the single biggest lever on how a call FEELS, and it is a trade,
 * not a win. Longer silence means you can pause mid-thought without being
 * cut off, and every answer arrives that much later. Shorter is snappier and
 * finishes your sentences for you.
 *
 * Gemini Live defaults to END_SENSITIVITY_HIGH, which ends a turn eagerly. On
 * a real call that closed a turn in the middle of a long question, at 46
 * characters, and then answered nothing at all: the caller paused to let it
 * think, and it had already decided the fragment needed no reply. LOW is the
 * fix for that shape. The silence hold is kept short so that a genuine stop
 * is still answered promptly rather than traded away for the same patience.
 *
 * `prefixPaddingMs` is how much speech it takes to count as started. Low
 * enough that "da" registers, high enough that a keyboard does not.
 */
const ENDPOINTING_DEFAULTS = {
  endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
  silenceDurationMs: 700,
  prefixPaddingMs: 300,
};

/**
 * Tuning overrides, read once per call from `~/.cinderpaw/voice-tuning.json`.
 *
 * The defaults above ARE the product: nobody should have to create this file,
 * and a fresh install never has one. It exists because finding the right
 * numbers means hearing them, and every change to the constants above costs a
 * full rebuild of the app. With this, a hang up and a redial is the whole
 * iteration.
 *
 * Unknown keys are ignored rather than merged, so a typo in a hand-edited
 * file cannot send the vendor a field it will reject and kill the call.
 */
/**
 * What each setting has to be for the vendor to accept it.
 *
 * One entry per key in ENDPOINTING_DEFAULTS, and `endpointing()` refuses any
 * key that has no entry. Two parallel objects that must agree is a rule waiting
 * to be half-updated: a fourth setting added to the defaults and forgotten here
 * would otherwise call `undefined(value)` and take the call down at start,
 * which is worse than the unvalidated value this exists to catch.
 */
const ENDPOINTING_RULES = {
  endOfSpeechSensitivity: (v) =>
    typeof v === 'string' && /^END_SENSITIVITY_(LOW|HIGH)$/.test(v),
  // Milliseconds. The upper bounds are not vendor limits, they are sanity: half
  // a minute of silence before a turn closes is a hang, and a person who typed
  // an extra zero should be told rather than left wondering why the call broke.
  silenceDurationMs: (v) => Number.isFinite(v) && v >= 0 && v <= 30_000,
  prefixPaddingMs: (v) => Number.isFinite(v) && v >= 0 && v <= 5_000,
};

function endpointing() {
  const home = (process.env.CINDERPAW_HOME || '').trim() || join(homedir(), '.cinderpaw');
  const path = join(home, 'voice-tuning.json');
  let overrides = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Genuinely no file. This is what almost every machine does forever, and it
    // is the one case that deserves no output at all.
    return { ...ENDPOINTING_DEFAULTS };
  }
  // Past here the person MADE this file, so every way it can fail to take
  // effect is worth a line. The old code caught the read and the parse in one
  // `catch` whose comment said "No file, or an unreadable one. Both mean use
  // the defaults" — which is true of the behaviour and false of the person: one
  // of those two is someone who edited a file and is now watching it do
  // nothing, with no way to find out why. The whole point of the file is that
  // tuning it costs a hang up and a redial rather than a rebuild.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `voice tuning: ${path} is not valid JSON (${e.message}). Using the built-in ` +
        `settings and ignoring the file. Fix the file or delete it.`,
    );
    return { ...ENDPOINTING_DEFAULTS };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(
      `voice tuning: ${path} must contain a JSON object. Using the built-in settings.`,
    );
    return { ...ENDPOINTING_DEFAULTS };
  }
  for (const key of Object.keys(ENDPOINTING_DEFAULTS)) {
    const value = parsed[key];
    if (value === undefined || value === null) continue;
    // Recognised keys used to be copied through on nothing but a null check, so
    // `silenceDurationMs: "700"` or `-5` went straight to the vendor. A rejected
    // field kills the call, and the reason surfaces as the call not starting.
    const rule = ENDPOINTING_RULES[key];
    // A default with no rule is a bug in this file, not in the person's file.
    // Refusing is the safe half of it, and saying so is how it gets fixed
    // instead of silently ignoring a setting somebody set.
    if (typeof rule !== 'function') {
      console.error(
        `voice tuning: ${key} has no validation rule, so it is ignored. ` +
          `This is a Cinderpaw bug; please report it.`,
      );
      continue;
    }
    if (!rule(value)) {
      console.error(
        `voice tuning: ignoring ${key}=${JSON.stringify(value)} from ${path}, ` +
          `it is not a value this setting accepts. Using ${JSON.stringify(ENDPOINTING_DEFAULTS[key])}.`,
      );
      continue;
    }
    overrides[key] = value;
  }
  // Unknown keys are still ignored rather than merged, and now said out loud:
  // a typo is indistinguishable from a setting that does nothing otherwise.
  const unknown = Object.keys(parsed).filter((k) => !(k in ENDPOINTING_DEFAULTS));
  if (unknown.length > 0) {
    console.error(
      `voice tuning: ${path} has ${unknown.length} setting(s) Cinderpaw does not know ` +
        `(${unknown.join(', ')}). They are ignored. Known settings: ` +
        `${Object.keys(ENDPOINTING_DEFAULTS).join(', ')}.`,
    );
  }
  const merged = { ...ENDPOINTING_DEFAULTS, ...overrides };
  if (Object.keys(overrides).length > 0) {
    console.log(`voice tuning: ${JSON.stringify(merged)} (from voice-tuning.json)`);
  }
  return merged;
}

const REALTIME = {
  google: async () => {
    const google = await PLUGIN.google();
    return new google.beta.realtime.RealtimeModel({
      apiKey: API_KEY,
      model: MODEL || 'gemini-2.5-flash-native-audio-latest',
      // Pinned. Left unset the server picks per session, so the same assistant
      // answers in a different voice tomorrow — the exact inconsistency that
      // reads as unfinished software.
      voice: VOICE || 'Kore',
      // A Live session is bounded by its context window, not by the clock: fill
      // it and the server ends the session mid-sentence. A sliding window drops
      // the oldest turns instead, which is what makes "talk for an hour" a thing
      // that can happen at all. Left off, a long conversation has a hard stop
      // nobody warned the person about.
      contextWindowCompression: { slidingWindow: {} },
      // Both sides transcribed. Not decoration: it is the only way to see what
      // the model actually HEARD, and mishearing is the failure that looks like
      // stupidity. Also what a call needs to leave behind a readable trace.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // The single most important line in this file for how a call FEELS.
      //
      // Left on the default, the plugin treats a tool call as blocking, and
      // blocking means two things at once, both of them bad. The model cannot
      // speak until the tool returns — that is the silence. And
      // `pushAudio` drops every microphone frame while a call is pending
      // (`realtime_api.js`, `shouldBlockRealtimeInputForPendingTools`) — that
      // is the app going deaf mid-conversation, which is not a bug report we
      // guessed at: a real call spent 65 seconds in `ask_cinder` with every
      // word the caller said thrown away, and the screen still saying
      // "Listening".
      //
      // NON_BLOCKING keeps the floor and the microphone open. Scheduling is
      // left at its default of WHEN_IDLE so the answer lands in a gap rather
      // than cutting the model off mid-sentence.
      toolBehavior: 'NON_BLOCKING',
      // See `endpointing()`. Left unset the vendor ends turns eagerly, which
      // is what made a pause mid-question read as "it stopped answering".
      realtimeInputConfig: { automaticActivityDetection: endpointing() },
      instructions: INSTRUCTIONS,
    });
  },
  openai: async () => {
    const openai = await PLUGIN.openai();
    return new openai.realtime.RealtimeModel({
      apiKey: API_KEY,
      model: MODEL || 'gpt-realtime',
      voice: VOICE || 'marin',
      // The server-side voice activity detector, asked for explicitly. Left to
      // the default this is still on, but "still on by default" is a thing that
      // changes between API versions and takes barge-in with it when it does.
      turnDetection: { type: 'server_vad' },
      // Google transcribes both directions from one option each; OpenAI only
      // transcribes the INPUT, and the output transcript arrives as part of the
      // response. Asking for the input one is therefore not symmetry — it is
      // the only half that has to be requested.
      inputAudioTranscription: { model: 'whisper-1' },
      instructions: INSTRUCTIONS,
    });
  },
};
/** Declared by Rust, not here. See `live::bridge::declarations`. */
const TOOL_DECLARATIONS = JSON.parse(process.env.CINDERPAW_LIVE_TOOLS || '[]');

/**
 * Tool calls, answered over the app's own loopback API.
 *
 * NOT over the pipe to the parent, which is where this started and where it
 * failed: the Agents SDK forks a supervised child process per call, this file
 * is loaded again inside it, and that child does not own the worker's stdin.
 * Reading stdin there took over the channel the runner uses to start, so every
 * job died with `runner initialization timed out` and the room stayed empty.
 *
 * An HTTP call works from any process, forked or not. It reaches the same agent
 * the bearer token already reaches through `/runtime/chat`, so it grants
 * nothing new.
 */
const API_URL = process.env.CINDERPAW_API_URL || '';
const API_TOKEN = process.env.CINDERPAW_API_TOKEN || '';

/**
 * Which conversation the sidecar files this call under.
 *
 * One per worker process, which is one per call: the SDK forks a child per job
 * and this module is loaded again inside it. Stable for the length of the call
 * so the history and its compaction belong to somebody, and distinct from the
 * desktop's own session so a spoken call does not append itself to whatever
 * chat happens to be open.
 */
const SESSION_ID = `voice-${process.pid}`;

/**
 * Whether the vendor's own model can talk while a tool runs.
 *
 * True for Gemini, where `ask_cinder` is declared NON_BLOCKING and the session
 * keeps both the floor and the microphone. Everywhere else the tool call runs
 * inside the turn: the model is blocked, and the only thing that can fill the
 * gap is this file, with the local engine, in a different voice. That trade is
 * worth making against silence, and not worth making against a model that was
 * about to speak.
 */
const SPEAKS_FOR_ITSELF = PROVIDER === 'google';

/**
 * The language the app is being used in, so anything this file says out loud is
 * said in it. Two letters, or empty when nothing was chosen.
 */
const LANGUAGE = (process.env.CINDERPAW_LIVE_LANGUAGE || '').trim().toLowerCase().slice(0, 2);

/**
 * What the agent says while a tool call is running.
 *
 * Spoken by THIS FILE, not by the model, and that is the whole point. The brief
 * already tells the model at length to keep the line warm, and it cannot: every
 * vendor here runs the tool call inside the turn, so the model is not choosing
 * to stay quiet, it is unable to speak. Thirty seconds of that is
 * indistinguishable from a dropped call, and no amount of prompt fixes
 * something the model cannot do.
 *
 * This used to claim Gemini was exempt because `ask_cinder` is declared
 * NON_BLOCKING. That declaration lives in `live/bridge.rs`, which is the OTHER
 * voice engine, the retired one. Nothing in this file ever sent it, so the
 * exemption was never real, and the sentence stating it outlived the code it
 * described.
 *
 * Short, plain, and varied, because the same sentence twice in twenty seconds
 * sounds more broken than silence. Nothing here claims a result: the model says
 * what was found when the answer arrives, and a second voice announcing "found
 * it" first is exactly the two-voices bug in a smaller coat.
 */
const FILLER = {
  en: {
    start: ['One moment, let me look that up.', "Right, I'm on it.", 'Let me go and find out.'],
    waiting: [
      "Still working on it.",
      "Give me a few more seconds.",
      "Nearly there, still looking.",
      "I'm still here, this one is taking a while.",
    ],
  },
  ro: {
    start: ['O secundă, mă uit acum.', 'Bun, mă ocup.', 'Stai să văd exact.'],
    waiting: [
      'Încă lucrez la asta.',
      'Mai durează puțin.',
      'Aproape gata, încă mă uit.',
      'Sunt aici, asta durează mai mult.',
    ],
  },
};

/** How long a tool call may run before the line needs warming, and how often. */
const FIRST_FILLER_MS = 1200;
const NEXT_FILLER_MS = 12_000;
/**
 * Each wait is longer than the last, up to a ceiling.
 *
 * A fixed 12s cadence is right for the first half minute and wrong for a job
 * that runs three minutes: it produces fifteen interruptions and cycles four
 * lines through the caller four times over, which stops sounding like someone
 * working and starts sounding like a loop. Backing off says the same thing a
 * person says on a long call, less and less often, and the ceiling keeps the
 * gap short enough that the line never feels dropped.
 */
const FILLER_BACKOFF = 1.4;
const MAX_FILLER_MS = 40_000;

/**
 * Keep the line warm for as long as `stop()` has not been called.
 *
 * Best effort in the strictest sense: a session with no way to speak text
 * (which some realtime integrations are) throws here, and a call that works
 * silently is enormously better than a call that dies because it could not say
 * "one moment". Every failure is swallowed after the first, which is also why
 * the first one is logged: a filler that never speaks should be findable.
 */
function keepLineWarm(session) {
  const lines = FILLER[LANGUAGE] ?? FILLER.en;
  let stopped = false;
  let complained = false;
  let n = 0;
  const speak = (text) => {
    if (stopped) return;
    try {
      // `addToChatCtx: false`: this is the app talking over the gap, not a turn
      // the model should later believe it took. Left in the context, the model
      // reads its own filler back as something it already said and answers the
      // next question as if the work were done.
      session.say(text, { allowInterruptions: true, addToChatCtx: false });
    } catch (e) {
      if (!complained) {
        complained = true;
        console.error(`filler could not be spoken (${String(e?.message ?? e)}); the call runs silent while tools work`);
      }
    }
  };
  const first = setTimeout(() => {
    speak(lines.start[Math.floor(Math.random() * lines.start.length)]);
  }, FIRST_FILLER_MS);
  let wait = NEXT_FILLER_MS;
  let later = null;
  const again = () => {
    later = setTimeout(() => {
      speak(lines.waiting[n++ % lines.waiting.length]);
      wait = Math.min(MAX_FILLER_MS, Math.round(wait * FILLER_BACKOFF));
      if (!stopped) again();
    }, wait);
  };
  again();
  return () => {
    stopped = true;
    clearTimeout(first);
    if (later !== null) clearTimeout(later);
  };
}
let nextCallId = 0;

async function askRust(name, args) {
  if (!API_URL) return { ok: false, output: 'Cinderpaw is not reachable from here' };
  try {
    const res = await fetch(`${API_URL}/runtime/voice/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ id: String(++nextCallId), name, args }),
      // A backstop ABOVE Rust's own budget, not a second policy — and for a
      // while it was neither. Rust answers a slow tool at
      // `VOICE_TOOL_DEADLINE` (45s) with a sentence the model can say out
      // loud: "still working on that one, tell the user you are still on it."
      // This abort was 30s, left over from when that budget was 20s, so the
      // client hung up fifteen seconds BEFORE the honest answer was due. In a
      // whole log of real calls that holding reply had never once been sent.
      //
      // What the model got instead was this file's catch branch, i.e. a
      // failure, while the search went on running in the background — and then
      // it talked as though it had searched. The one that has to be bigger is
      // this one.
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return { ok: false, output: `Cinderpaw refused the request (${res.status})` };
    const { response } = await res.json();
    return response;
  } catch (e) {
    // Spoken, not thrown. An exception here ends the turn with nothing said,
    // which the person hears as the assistant simply stopping.
    return {
      ok: false,
      output: `Could not reach Cinderpaw for that (${String(e?.message ?? e)}). Say so out loud.`,
    };
  }
}

/**
 * One line per event, on stdout, for Rust to forward to the window.
 *
 * A prefix rather than a side channel because the pipe already exists and a
 * second one is a second thing that can be half-connected. Module level rather
 * than inside `assistant`, because tool calls happen there too and they were
 * the events nobody could see.
 */
const emit = (obj) => console.log('CINDERPAW_EVENT ' + JSON.stringify(obj));

/** Build the LiveKit tool set from what Rust declared. */
function toolsFromDeclarations(session) {
  const out = {};
  for (const decl of TOOL_DECLARATIONS) {
    out[decl.name] = llm.tool({
      description: decl.description,
      // The JSON Schema Rust already wrote. Restating it as a zod schema here
      // would be a second definition of the same contract, free to drift.
      parameters: decl.parameters,
      // The agent's turn takes around twenty-five seconds, which is why the
      // declaration tells the model to keep talking while it waits. Nothing
      // here needs a timeout: a call that ends takes the process with it.
      execute: async (args) => {
        // The call screen has a panel that shows what the agent is doing, and
        // for a LiveKit call it was always blank: `ask_cinder` is answered over
        // the loopback API, which the webview never sees. So a person asked for
        // something, watched nothing happen for up to a hundred seconds, and
        // reasonably concluded the tool was broken. These two lines are the
        // only thing that ever told them otherwise.
        emit({ kind: 'toolCall', text: String(args?.request ?? '').trim() });
        // The panel says what is running; this says it out loud, which is the
        // half a person on a phone call actually receives.
        //
        // Not on Gemini. There the tool is NON_BLOCKING, so the model keeps
        // the floor and fills the gap ITSELF, in the voice the caller has been
        // listening to all along. Speaking over that with the local engine
        // would put a second, different voice into the same call — which this
        // product has already shipped once, by accident, and it reads as two
        // people talking at you rather than as one assistant working.
        const done = SPEAKS_FOR_ITSELF ? () => {} : keepLineWarm(session);
        try {
          const out = await askRust(decl.name, args);
          emit({ kind: 'toolResult', text: out?.ok === false ? String(out.output ?? 'failed') : '' });
          return out;
        } finally {
          // On every path. Left running after a failure, the call would go on
          // promising it was nearly there for as long as the room was open.
          done();
        }
      },
    });
  }
  return out;
}

/**
 * Whatever it hears, straight back out.
 *
 * The track is published before anyone speaks rather than on first audio: a
 * track that appears mid-call renegotiates while the person is already talking,
 * and the first thing they say is the part that gets lost.
 */
async function echo(ctx) {
  const source = new AudioSource(RATE, CHANNELS);
  await ctx.room.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack('cinderpaw-voice', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  console.log('CINDERPAW_AGENT_READY mode=echo');

  ctx.room.on(RoomEvent.TrackSubscribed, async (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    for await (const frame of new AudioStream(track, RATE, CHANNELS)) {
      // AudioStream resamples to the rate we asked for, so the frame goes back
      // out unmodified. If that ever stops being true, this is where the
      // chipmunk voice comes from.
      await source.captureFrame(
        new AudioFrame(frame.data, RATE, CHANNELS, frame.data.length / CHANNELS),
      );
    }
  });
}

/**
 * The chosen vendor's realtime API, driven by the Agents session.
 *
 * `AgentSession` owns the microphone track, the playback track, barge-in and
 * the end-of-turn model that loads locally at startup. None of that is ours any
 * more, which was the point of the migration — and none of it is vendor
 * specific either, which is why swapping the vendor is one line here.
 */
async function assistant(ctx, makeSession) {
  // The local pipeline builds its own session; every cloud vendor builds one
  // from `REALTIME`. Everything AFTER this point — events, tools, the data
  // channel, the greeting — is identical, which is the only reason there is one
  // function here instead of two that drift.
  const build = makeSession ? null : REALTIME[PROVIDER];
  if (!makeSession && !build) {
    // Reachable only if Rust names a vendor this file does not know, i.e. after
    // a half-applied update. Said out loud in the same channel as every other
    // failure rather than thrown, because a throw here ends the job with an
    // empty room and no explanation anywhere the user can see.
    console.log(
      'CINDERPAW_EVENT ' +
        JSON.stringify({
          kind: 'error',
          text: `This build does not know the voice provider "${PROVIDER}".`,
          recoverable: false,
        }),
    );
    return echo(ctx);
  }
  // `tts` on a REALTIME session, which looks wrong and is not.
  //
  // The vendor's own voice still answers: the SDK takes the realtime audio
  // path whenever the llm is a RealtimeModel with audio output
  // (`agent_activity`, the two `capabilities.audioOutput` branches). What the
  // TTS is for is `session.say()`, which is how this file speaks over a tool
  // call — and which threw on every single attempt without one:
  //
  //   filler could not be spoken (trying to generate speech from text without
  //   a TTS model); the call runs silent while tools work
  //
  // Three times in one real call, while `ask_cinder` ran for 14s, 19s, and
  // once for over a minute. The guarantee that a call never goes quiet while a
  // tool works was written, tested, and not true on the only engine anybody
  // uses.
  const session = makeSession
    ? await makeSession(ctx)
    : new voice.AgentSession({ llm: await build(), tts: new LocalTTS(null) });

  // One line per event, on stdout, for Rust to forward to the window. A prefix
  // rather than a side channel because the pipe already exists and a second one
  // is a second thing that can be half-connected.

  session.on(AgentSessionEventTypes.UserInputTranscribed, (e) => {
    // Interim results ARE forwarded, flagged as partial, and this is the whole
    // difference between a call that feels alive and one that reads as broken.
    //
    // This used to drop everything but `isFinal`, reasoning that a flickering
    // half-sentence is worse than a clean one. The reasoning was wrong about
    // WHEN the final arrives: with a native-audio realtime model it lands after
    // the turn is processed, so the screen stayed empty for five to ten seconds
    // while somebody was still talking — and longer as the conversation grew,
    // up to half a minute. A person watching their own words not appear
    // concludes the microphone is dead. The first-run version of that person
    // concludes the product is.
    //
    // The receiver decides what to do with a partial: show it, and write only
    // the final into the conversation, so a sentence is not persisted ten times.
    const text = e.transcript?.trim();
    if (text) emit({ kind: 'heard', text, partial: !e.isFinal });
  });

  session.on(AgentSessionEventTypes.ConversationItemAdded, (e) => {
    const item = e.item;
    if (item?.role !== 'assistant') return;
    const text = Array.isArray(item.content)
      ? item.content.filter((c) => typeof c === 'string').join(' ').trim()
      : String(item.textContent ?? '').trim();
    if (text) emit({ kind: 'said', text });
  });

  // The free Gemini tier rate-limits voice, and a session that dies from quota
  // is indistinguishable from a broken app unless something says so. The plugin
  // resumes a dropped session on its own using a resumption handle, so this
  // reports rather than reconnects — but a quota refusal is not resumable, and
  // that is exactly the case a person needs told.
  // What the call is DOING, so the screen can say so. The overlay has always
  // had four states; without this it would have to guess them from audio
  // energy, which is how a call that is thinking looks identical to one that
  // has died.
  session.on(AgentSessionEventTypes.AgentStateChanged, (e) => {
    emit({ kind: 'state', text: String(e.newState ?? '') });
  });

  session.on(AgentSessionEventTypes.Error, (e) => {
    const message = String(e?.error?.message ?? e?.error ?? 'unknown error');
    emit({ kind: 'error', text: message, recoverable: Boolean(e?.recoverable) });
  });
  session.on(AgentSessionEventTypes.Close, () => emit({ kind: 'closed' }));

  // Commands from the window, over LiveKit's own data channel.
  //
  // The window is IN the room, so this needs no extra socket and no port: it
  // is the same connection the audio already travels on. It carries the two
  // things a person can do to a call that speech alone cannot express — cutting
  // the assistant off mid-sentence, and typing a word dictation keeps mangling
  // (a URL, a name, an error string).
  ctx.room.on(RoomEvent.DataReceived, (payload) => {
    let msg;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return; // not ours
    }
    if (msg.type === 'interrupt') session.interrupt();
    // `userInput`, not `say`: `say` would make the assistant read the text out
    // loud in its own voice, which is the opposite of what typing into a call
    // means.
    if (msg.type === 'text' && msg.text) session.generateReply({ userInput: String(msg.text) });
  });

  await session.start({
    agent: new voice.Agent({ instructions: INSTRUCTIONS, tools: toolsFromDeclarations(session) }),
    room: ctx.room,
  });

  console.log(
    `CINDERPAW_AGENT_READY mode=assistant provider=${PROVIDER} persona=${INSTRUCTIONS.length} tools=${TOOL_DECLARATIONS.length}`,
  );

  // Speaking first is not decoration. A person who has just pressed a button
  // and hears nothing cannot tell a working call from a broken one, and the
  // usual response is to hang up during the pause before the first reply.
  session.generateReply();
}

/**
 * A call that never leaves this machine.
 *
 * Same `AgentSession` as the realtime path — same barge-in, same turn
 * detection, same transcripts, same tools — assembled from three local parts
 * instead of one remote session. That symmetry is the point: the overlay, the
 * event stream and the tool bridge below do not know which mode is running.
 *
 * The VAD is not optional here. A non-streaming recogniser has no idea when a
 * sentence ended, so without it the session would either never submit audio or
 * submit all of it at once.
 */
async function pipeline(ctx) {
  // Loaded during prewarm when there was one, which is the whole point of
  // prewarm: `VAD.load()` reads a model off disk and costs seconds, and paying
  // that after the room opens is seconds of a person waiting in silence. The
  // fallback is not dead code — a job can land on a process that was never
  // idled, and a call that works slowly beats a call that throws.
  const loadVAD = async () => {
    const silero = await PLUGIN.pipeline();
    // Tune for snappy turn-taking: default minSilence ~500ms felt like the
    // transcript was stuck; 300ms is still above breath noise and makes the
    // partial → final transition visibly faster without cutting words.
    try {
      return await silero.VAD.load({ minSpeechDuration: 0.25, minSilenceDuration: 0.35 });
    } catch {
      return await silero.VAD.load();
    }
  };
  const vad = ctx.proc?.userData?.vad ?? (await loadVAD());
  const session = new voice.AgentSession({
    stt: new LocalSTT(),
    llm: new LocalLLM(),
    tts: new LocalTTS(),
    vad,
  });
  return session;
}

export default defineAgent({
  /**
   * Everything slow that can happen before anybody is in the room.
   *
   * The Agents SDK runs each call in a forked child, and with idle processes
   * configured (see `WorkerOptions` below) that child is started and prewarmed
   * while the app is still showing the call button. Without this the fork was
   * cold: it started only once the room opened, then loaded the SDK, the vendor
   * plugin and — for the pipeline — the VAD model, all while the person stared
   * at a connecting screen. That was the five to ten seconds.
   *
   * Failure here is logged and swallowed on purpose. A prewarm that throws
   * takes the whole process down and the call never happens; a prewarm that
   * gives up leaves the load to `entry`, which is exactly the old behaviour.
   */
  prewarm: async (proc) => {
    try {
      if (PIPELINE) {
        const silero = await PLUGIN.pipeline();
        try {
          proc.userData.vad = await silero.VAD.load({ minSpeechDuration: 0.25, minSilenceDuration: 0.35 });
        } catch {
          proc.userData.vad = await silero.VAD.load();
        }
      } else if (API_KEY && PLUGIN[PROVIDER]) {
        await PLUGIN[PROVIDER]();
      }
    } catch (e) {
      console.error(`prewarm did not finish (${String(e?.message ?? e)}); loading on first call`);
    }
  },
  entry: async (ctx) => {
    await ctx.connect();
    // A flag from Rust, not a provider id compared against a literal. The id
    // lived in two files and they disagreed — Rust sends `pipeline`, this read
    // `local` — so every local call silently fell through to echo: no
    // assistant, no tools, no ask_cinder, and nothing on screen saying why.
    if (PIPELINE) {
      await assistant(ctx, pipeline);
    } else if (API_KEY && PROVIDER) {
      // Both halves have to be present. A provider with no key authenticates
      // nothing, and a key with no provider has no plugin to hand it to; either
      // one alone used to be enough to take the assistant branch and then fail
      // somewhere further in, which is a call that connects and never speaks.
      await assistant(ctx);
    } else {
      await echo(ctx);
    }
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    // No `agentName`: that is what makes LiveKit dispatch this worker into any
    // room that opens, with no dispatch call from our side.
    wsURL: process.env.LIVEKIT_URL,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,

    // Everything below is what the SDK would otherwise decide from the CLI verb,
    // and every one of those defaults is wrong for an app that hosts its own
    // server for one person on one machine.
    //
    // One warm child, waiting. Rust runs this with `start` (production) rather
    // than `dev` for exactly this: `dev` sets idle processes to ZERO, so the
    // fork that runs the call began at the moment the room opened and had to
    // load the SDK, the vendor plugin and the VAD before it could join. One is
    // enough — this is a single call for a single person, and each idle child
    // is a whole Node process sitting in RAM.
    numIdleProcesses: 1,
    // Prewarm now does real work — for the pipeline it loads a VAD model from
    // disk, which on a cold machine is not a ten-second job. The default would
    // kill the child mid-load and then keep retrying it.
    initializeProcessTimeout: 60_000,
    // Production mode otherwise refuses jobs once the machine is 70% busy. That
    // is right for a fleet of workers with a queue behind them and wrong here:
    // this machine is ALSO running the local model and Whisper, so the one
    // moment a call is most wanted is the moment the worker would decline it —
    // and a declined job is a call where nobody ever joins and nothing says why.
    loadThreshold: Infinity,
    // The worker's own health endpoint, which Rust polls to know the far end is
    // registered. Given a port Rust picked from what the OS said was free, and
    // bound to loopback: production's defaults are 0.0.0.0:8081, i.e. a fixed
    // port anything else can already hold, listening on somebody's home network.
    host: '127.0.0.1',
    port: Number(process.env.CINDERPAW_WORKER_PORT) || undefined,
  }),
);
