import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, PhoneOff, Headphones } from 'lucide-react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { tauri } from '@/lib/tauri';
import { events, type LiveKitAgentEvent } from '@/lib/tauri/events';
import { callMark, callTimeline, type CallMark } from '@/lib/callTiming';

/**
 * Does a voice call actually work on this machine?
 *
 * A self-test rather than a voice engine, and the distinction is honest rather
 * than modest: the far end echoes, it does not think. What this proves is the
 * part that is hard to prove any other way — that the app can start a LiveKit
 * server, that a second process joins the call, that the microphone reaches it
 * and that audio comes back — with no API key, no downloaded model and no
 * account. Somebody who has just installed Cinderpaw can run it.
 *
 * It stays useful after the real engine lands, for the same reason a network
 * settings panel has a "test connection" button: when a call fails, the first
 * question is whether the pipe or the brain is broken.
 */
/**
 * Turn a provider's quota refusal into a sentence with a next step in it.
 *
 * Gemini's free tier rate-limits voice, so this is not an edge case — it is
 * what a long conversation runs into. The raw message names an HTTP status and
 * a quota id, which tells a person nothing about what to do, and the failure
 * looks exactly like the app breaking.
 */
function rateLimited(raw: string): string | null {
  return /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(raw)
    ? 'Google cut the call off: the free Gemini tier limits how much voice you get. Wait a few minutes and call again, or add billing to that key.'
    : null;
}

export function LiveKitSelfTest() {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'live' | 'error'>('idle');
  const [detail, setDetail] = useState<string>('');
  // Which far end answered. Unknown until the call starts, and the screen must
  // not guess: an echo introduced as an assistant is a worse lie than silence.
  const [mode, setMode] = useState<'assistant' | 'echo' | null>(null);
  /** The last few lines of the call, newest last. Capped because this is a
   *  settings row, not a transcript viewer — and an unbounded list in a panel
   *  nobody scrolls is a memory leak with a nice name. */
  const [lines, setLines] = useState<LiveKitAgentEvent[]>([]);
  /** How long each stage of the last attempt took. The one question a slow
   *  call raises is WHICH part was slow, and until this was on screen the only
   *  way to answer it was to attach a debugger to somebody else's machine. */
  const [timeline, setTimeline] = useState<{ mark: CallMark; ms: number }[]>([]);
  /** Whether this attempt joined machinery that was already running. */
  const [warm, setWarm] = useState<boolean | null>(null);
  const room = useRef<Room | null>(null);
  /** Every element `track.attach()` handed us, so every one can be taken back
   *  down. Attaching creates a NEW element per subscribed track, so keeping a
   *  single reference leaks one silent, dead `<audio>` into the page per call —
   *  invisible, and enough to make "is anything playing?" unanswerable. */
  const sinks = useRef<HTMLAudioElement[]>([]);
  /**
   * True once the far end has actually published audio.
   *
   * Separate from `phase === 'live'`, which only means the ROOM connected and
   * the microphone opened. Those are the easy half: a worker that died on
   * startup still leaves a room you can join and a microphone you can enable,
   * and the panel said "Connected. Say something, your assistant is listening."
   * over a call with nobody on the other end. A self-test that reports success
   * before the thing it tests is worse than no self-test, because it converts
   * a broken install into a user who believes the install is fine.
   */
  const [agentAudible, setAgentAudible] = useState(false);
  /** Set when the far end never arrived within the grace period below. */
  const [agentSilent, setAgentSilent] = useState(false);
  const agentWait = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSinks = useCallback(() => {
    for (const el of sinks.current) {
      el.srcObject = null;
      el.remove();
    }
    sinks.current = [];
  }, []);

  const hangUp = useCallback(async () => {
    await room.current?.disconnect();
    room.current = null;
    await tauri.raw.endLivekitCall().catch(() => {});
    clearSinks();
    if (agentWait.current) clearTimeout(agentWait.current);
    setPhase('idle');
    setDetail('');
    setAgentAudible(false);
    setAgentSilent(false);
    setMode(null);
  }, [clearSinks]);

  // Subscribed for the panel's whole life rather than per call: the first
  // transcript can land before `connect` resolves, and a listener attached
  // after that has already missed it.
  useEffect(() => {
    const pending = events.liveKitEvent.listen((e) => {
      if (e.kind === 'closed') return;
      if (e.kind === 'error') {
        setDetail(rateLimited(e.text ?? '') ?? e.text ?? 'The call reported an error.');
        // Recoverable errors are the plugin's business — it resumes the session
        // itself. Saying so would be alarming the person about something being
        // handled while they are mid-sentence.
        if (!e.recoverable) setPhase('error');
        return;
      }
      setLines((prev) => [...prev, e].slice(-6));
    });
    return () => { void pending.then((un) => un()); };
  }, []);

  // A call must not outlive the panel that started it. Without this, closing
  // settings mid-test leaves a server, an agent and an open microphone running
  // with nothing on screen that mentions them.
  useEffect(() => () => void hangUp(), [hangUp]);

  const start = useCallback(async () => {
    setPhase('starting');
    setDetail('');
    setAgentAudible(false);
    setAgentSilent(false);
    if (agentWait.current) clearTimeout(agentWait.current);
    setLines([]);
    setTimeline([]);
    setWarm(null);
    callMark('call_requested');
    callMark('call_ui_ready');
    try {
      const call = await tauri.raw.startLivekitCall();
      callMark('room_join_started');
      // Rust already knows whether this reused a chain that was up. Without it
      // on screen, the difference between a four-second start and an instant
      // one looks like the app being randomly slow.
      setWarm(call.warm);
      const r = new Room();
      room.current = r;

      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        // The far end publishing audio is the first moment the call is worth
        // anything, and it lands after everything this function awaits. A
        // timeline that stopped at `connect` was measuring the easy half.
        callMark('agent_session_started');
        setAgentAudible(true);
        setAgentSilent(false);
        if (agentWait.current) clearTimeout(agentWait.current);
        setTimeline(callTimeline());
        const el = track.attach();
        el.autoplay = true;
        sinks.current.push(el);
        document.body.appendChild(el);
      });
      // The far end going away is not an error the user caused, but it is the
      // difference between "nothing is happening" and "it stopped".
      r.on(RoomEvent.Disconnected, () => {
        // It used to `setDetail('')` here, which erased the explanation on the
        // way out: the panel simply reset itself and the person was left with a
        // test that had apparently never run. The far end going away is not an
        // error they caused, but it IS the difference between "nothing is
        // happening" and "it stopped", and that sentence is the whole reason
        // this panel exists.
        setPhase('error');
        setDetail((prev) =>
          prev ||
          'The voice engine disconnected. It started and then went away, which usually means it crashed on the other side; the timings below show how far it got.',
        );
        if (agentWait.current) clearTimeout(agentWait.current);
      });

      await r.connect(call.url, call.token);
      callMark('room_joined');
      await r.localParticipant.setMicrophoneEnabled(true);
      callMark('microphone_ready');
      setMode(call.mode);
      setPhase('live');
      setTimeline(callTimeline());
      // Connected is not working. If the far end never publishes audio, nothing
      // above ever fails and the panel would sit on "Connected" forever, which
      // is the exact reading a broken worker produces. Twelve seconds is past
      // any normal dispatch and well short of a person's patience.
      if (agentWait.current) clearTimeout(agentWait.current);
      agentWait.current = setTimeout(() => setAgentSilent(true), 12_000);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setPhase('error');
      setDetail(
        raw === 'livekit-no-node'
          ? 'This needs Node.js installed, which the voice engine runs on. Install it from nodejs.org and try again.'
          : raw.includes('Permission')
            ? 'The microphone was refused. Allow it for Cinderpaw in your system settings.'
            : raw,
      );
      setTimeline(callTimeline());
      await tauri.raw.endLivekitCall().catch(() => {});
    }
  }, []);

  useEffect(() => clearSinks, [clearSinks]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Voice call</p>
          <p className="text-xs text-text-muted mt-0.5">
            Runs the call on this machine. With a key for one of the voice
            providers you talk to your assistant; without one it echoes you
            back, so the microphone and speakers can still be checked.
          </p>
        </div>
        {phase === 'live' ? (
          <button
            type="button"
            onClick={() => void hangUp()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-primary hover:bg-bg-surface"
          >
            <PhoneOff className="h-3.5 w-3.5" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            disabled={phase === 'starting'}
            onClick={() => void start()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-primary hover:bg-bg-surface disabled:opacity-60"
          >
            {phase === 'starting' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {phase === 'starting' ? 'Starting…' : 'Test'}
          </button>
        )}
      </div>

      {/* Said before the call, not after it howls — and only for the mode that
          howls. An assistant does not repeat you, so warning about feedback
          there is noise that teaches people to ignore the warning. */}
      {phase !== 'error' && mode !== 'assistant' && (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Headphones className="h-3 w-3 shrink-0" />
          Without a key this echoes you, so use headphones or the speakers will squeal.
        </p>
      )}

      {phase === 'starting' && (
        <p className="text-xs text-text-muted">
          First run downloads the voice server and sets it up. This takes a minute.
        </p>
      )}

      {/* Three states, because they need three different answers. Connected and
          waiting is not a failure and must not read as one; connected and
          silent past the grace period is the finding this panel exists to
          produce; connected and audible is the only one that has earned the
          word "listening". */}
      {phase === 'live' && !agentAudible && !agentSilent && (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          Connected. Waiting for the voice engine to come on the line.
        </p>
      )}
      {phase === 'live' && !agentAudible && agentSilent && (
        <p className="text-xs text-[var(--warning)]">
          Connected, but the voice engine never joined. The room and your
          microphone are fine, so the problem is on the engine side. The timings
          below show how far it got. Stop and try again; if it keeps happening,
          this is the failure worth reporting.
        </p>
      )}
      {phase === 'live' && agentAudible && (
        <p className="text-xs text-text-primary">
          {mode === 'assistant'
            ? 'Connected. Say something, your assistant is listening.'
            : 'Connected, with no key: this is an echo, not an assistant. Say something and you should hear it back.'}
        </p>
      )}

      {phase === 'error' && <p className="text-xs text-error">{detail}</p>}

      {/* Where the wait went, in milliseconds from the button press. On screen
          rather than in a log file: the person who can see a call take fifteen
          seconds is not the person with a terminal open, and "it is slow" is
          not a report anybody can act on. Stage names only, never content. */}
      {timeline.length > 0 && (
        <dl className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-xs">
          {warm !== null && (
            <div className="flex justify-between gap-4">
              <dt className="text-text-muted">voice engine</dt>
              <dd className="text-text-primary">{warm ? 'already running' : 'started for this call'}</dd>
            </div>
          )}
          {timeline.map(({ mark, ms }) => (
            <div key={mark} className="flex justify-between gap-4">
              <dt className="text-text-muted">{mark.replace(/_/g, ' ')}</dt>
              <dd className="text-text-primary tabular-nums">{ms} ms</dd>
            </div>
          ))}
        </dl>
      )}

      {/* The readable half of the call. Shown while it runs AND after it ends,
          because the last thing said is usually what you want to check once it
          has stopped. */}
      {lines.length > 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 space-y-1">
          {lines.map((l, i) => (
            <p key={i} className="text-xs leading-relaxed">
              <span className="text-text-muted">{l.kind === 'heard' ? 'You' : 'Assistant'}</span>
              <span className="text-text-muted"> · </span>
              <span className="text-text-primary">{l.text}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
