// Aliased: the bare name would shadow the DOM `KeyboardEvent` that the Escape
// listener below is typed against.
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Phone, X, Loader2, MessageSquare, ArrowUp, Laptop, Cloud, Settings2,
  AudioLines, ChevronDown, Archive,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { preferredVoice, shortlistVoices } from '@/lib/voices';
import { MessageItem } from './MessageItem';
import { MoltenOrb } from './MoltenOrb';
import { CallToolScreen } from './CallToolScreen';
import { CallArtifacts } from './CallArtifacts';
import { useLiveToolActivity } from '@/hooks/useLiveToolActivity';
import { warmLiveKit } from '@/hooks/useLiveKitCallSession';
import { speechLevel } from '@/hooks/useSpeechPlayer';
import { subscribeArtifacts, artifactsSnapshot } from '@/lib/callArtifacts';
import { tauri, type S2sProviderInfo, type TtsProviderInfo, type TtsVoice } from '@/lib/tauri';
import { useUI } from '@/stores/ui';
import { useChat } from '@/stores/chat';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { CallPhase, CallStage } from '@/hooks/useCallSession';

/**
 * The in-call screen: one orb, one line of state, two buttons.
 *
 * A call has no scrollback and no undo, so what is happening has to be readable
 * from across the room — hence one large indicator instead of a status line, and
 * nothing else competing with it. The mic level drives the orb while listening,
 * which is also the only honest way to show that it is really hearing you.
 *
 * **Rendered through a portal to `document.body`, and that is not cosmetic.**
 * `ChatPage` animates the input strip with `transform: translateY(...)`, and a
 * transformed ancestor becomes the containing block for `position: fixed`. Inside
 * it, `fixed inset-0` resolved to the input strip rather than the viewport: the
 * background painted a bar at the bottom while the flex children spilled out over
 * a chat that was still fully visible. The portal escapes the transform, the
 * z-index stack, and the gradient on that wrapper in one move.
 */

export function compactCallTranscript(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 1) return '…'.slice(0, Math.max(0, maxChars));
  const tail = normalized.slice(-(maxChars - 2));
  const boundary = tail.indexOf(' ');
  if (boundary < 0) return '…';
  const completeTail = tail.slice(boundary + 1).trim();
  return completeTail ? `… ${completeTail}` : '…';
}

/** The transcript itself is synchronous; only the newly appended vendor piece
 * gets a short entrance, so motion never becomes another queue. */
export function CallTranscript({ text, fallback }: { text: string; fallback: string }) {
  const previousRef = useRef('');
  const visible = compactCallTranscript(text);
  const previous = previousRef.current;
  const appended = text.startsWith(previous)
    ? text.slice(previous.length).replace(/\s+/g, ' ').trim()
    : '';
  const fresh = appended && visible.endsWith(appended)
    ? appended
    : previous ? '' : visible;
  const stable = fresh ? visible.slice(0, -fresh.length) : visible;

  useLayoutEffect(() => {
    previousRef.current = text;
  }, [text]);

  return (
    <p
      data-testid="call-transcript"
      aria-label={text || undefined}
      className="line-clamp-3 max-h-[4.5rem] max-w-xl overflow-hidden break-words text-lg font-light leading-6 text-text-muted"
    >
      {text ? (
        <>
          “{stable}
          {fresh && (
            <span
              key={`${text.length}-${fresh}`}
              data-testid="call-transcript-new"
              className="inline-block animate-in fade-in-0 slide-in-from-bottom-1 duration-[20ms] ease-out motion-reduce:animate-none"
            >
              {fresh}
            </span>
          )}
          ”
        </>
      ) : fallback}
    </p>
  );
}

/**
 * Whose key this screen is asking for.
 *
 * One decision, used by both the sentence and the save, because they were
 * making it separately and only one of them was ever corrected. `saveKey`
 * learned to write to the SELECTED vendor; the sentence above it went on
 * naming Google, because it branched on the ENGINE (`live`, i.e. "is this a
 * LiveKit call") rather than on the vendor. Every realtime call is a LiveKit
 * call, so picking OpenAI Realtime asked for a Gemini key, and so did the local
 * pipeline, where the key belongs to whichever TTS engine is selected.
 *
 * A field that names the wrong vendor is worse than one that names none: a
 * person who pastes an OpenAI key under a prompt that says Google has no reason
 * to believe the call that follows.
 */
export function keyOwner(
  s2s: { id: string; label: string; pipeline: boolean } | null,
  ttsEngine: { id: string; label: string } | null,
): { id: string; label: string } | null {
  // In pipeline mode the row itself holds no key: its halves do, and the one
  // that can need a key is the engine that speaks.
  if (s2s?.pipeline) return ttsEngine;
  return s2s ? { id: s2s.id, label: s2s.label } : null;
}

/**
 * Which engine will speak, and whether the person chose it.
 *
 * Mirrors `cinderpaw_core::tts::default_engine()` on purpose: "the first
 * engine this build can run without a key". Rust is what refuses the call, so
 * a different rule here would enable a button whose press Rust then rejects —
 * which is exactly the failure this function exists to end.
 *
 * `'none'` is a FACT, not an unknown. A fresh install has picked nothing, and
 * on a build with no keyless engine (every Linux build and the Vulkan desktop
 * build — ONNX Runtime's glibc floor keeps Piper and Kokoro out) there is
 * genuinely nothing that can speak. Collapsing that into the same `null` the
 * catalogue-read failure produces is what left the Call button enabled: it
 * booted Node, a LiveKit server and an npm install, and only then failed,
 * wrapped in advice about checking the network.
 */
export function chooseSpeechEngine(
  providers: TtsProviderInfo[],
  selectedId: string | null,
): { engine: TtsProviderInfo | null; source: 'explicit' | 'default' | 'none' } {
  const explicit = providers.find((e) => e.id === selectedId) ?? null;
  if (explicit) return { engine: explicit, source: 'explicit' };
  // Local first, because `catalog()` orders on-device engines ahead of hosted
  // ones and a default that quietly picked a hosted engine would be a default
  // that quietly starts uploading somebody's voice.
  const fallback = providers.find((e) => e.available && !e.needsKey) ?? null;
  return fallback
    ? { engine: fallback, source: 'default' }
    : { engine: null, source: 'none' };
}

export function CallOverlay({
  phase,
  stage = null,
  heard,
  level,
  notice,
  onAnswer,
  onHangUp,
  onInterrupt,
  onSay,
  onChangeEngine,
  onChangeStt,
}: {
  phase: CallPhase;
  /** Which wait a `connecting` call is in. See `CallStage`. */
  stage?: CallStage;
  heard: string;
  level: number;
  /** Why the last turn said nothing, when it said nothing. */
  notice: string | null;
  onAnswer: () => void;
  onHangUp: () => void;
  onInterrupt: () => void;
  /** Absent when the running engine has no text channel — see the Live hook. */
  onSay?: (text: string) => void;
  onChangeEngine: () => void;
  onChangeStt: () => void;
  /** Switching mode swaps which loop drives this screen, so the owner does it
   *  rather than the store: the outgoing call has to be hung up and the incoming
   *  one opened, or the overlay would vanish mid-choice. */
}) {
  const t = useT();
  const [chatOpen, setChatOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // Only offered once there is something in it. A drawer that opens on an empty
  // list teaches the user it is empty, and they stop opening it.
  const artifactCount = useSyncExternalStore(subscribeArtifacts, artifactsSnapshot).length;
  const sttProvider = useUI((s) => s.sttProvider);
  const ttsProvider = useUI((s) => s.ttsProvider);
  const setTtsProvider = useUI((s) => s.setTtsProvider);
  const callEngine = useUI((s) => s.callEngine);
  const s2sProvider = useUI((s) => s.s2sProvider);
  const setS2sProvider = useUI((s) => s.setS2sProvider);
  const [s2sList, setS2sList] = useState<S2sProviderInfo[]>([]);
  const refreshS2s = useCallback(async () => {
    try {
      const l = await tauri.raw.listS2sProviders();
      setS2sList(l);
    } catch {
      setS2sList([]);
    }
  }, []);
  useEffect(() => {
    void refreshS2s();
  }, [refreshS2s]);
  // Pasted keys happen BETWEEN two attempts at a call. A list fetched once on
  // mount and never again is how the app keeps saying "no key" after one was
  // added: every later entry into the pre-call screen re-uses the stale value,
  // flips `willEcho` true, shows the key field again and blocks the Call button
  // even though the keychain now holds the key. Re-read whenever the overlay
  // becomes the thing the person is looking at.
  // Also warm the LiveKit machinery so the first `Call` does not pay 10-20s
  // of server boot + npm install while the user watches a spinner.
  useEffect(() => {
    if (phase === 'ready') {
      void refreshS2s();
      // Re-warmed on every change of vendor or voice, not once on entry: a
      // chain is warm FOR what was picked when it started, and Rust discards
      // one warmed for anything else. Without the dependency, changing vendor
      // on the pre-call screen silently put the full boot back on the button.
      warmLiveKit();
    }
  }, [phase, refreshS2s, s2sProvider, ttsProvider, sttProvider]);
  // What will ACTUALLY run. Rust falls back to the first provider with a key
  // when nothing is picked, so the screen has to resolve it the same way or it
  // describes a call that is not the one about to happen.
  const effectiveS2s = s2sProvider ?? s2sList.find((p) => p.connected)?.id ?? null;
  const currentS2s = s2sList.find((p) => p.id === effectiveS2s) ?? null;
  // What THIS call will do. Picking a vendor with no key is an echo even when
  // another vendor is connected, because the host refuses to quietly run the
  // other one — so this cannot be "is anything connected".
  const willEcho = s2sList.length > 0 && !currentS2s?.connected;
  useEffect(() => {
    // Write the resolved default back once it is known. Without this the voice
    // picker below has no provider to file a choice under, and the choice is
    // silently dropped — which is exactly the dead control this replaced.
    if (!s2sProvider && effectiveS2s) setS2sProvider(effectiveS2s);
  }, [s2sProvider, effectiveS2s, setS2sProvider]);
  // True for BOTH speech-to-speech engines: every branch reading this asks
  // "does one model do the whole call", not "which one". LiveKit and the
  // previous engine differ in machinery, not in that answer.
  const live = callEngine === 'live' || callEngine === 'livekit';
  /**
   * Can this call DO anything, or only talk?
   *
   * Agent mode routes every turn through the sidecar, which carries its own
   * tools whatever this store says; chat mode offers exactly `enabledTools`,
   * and that list is empty until someone turns one on. A call with none is a
   * perfectly good call — but it must not be mistaken for one that searched and
   * found nothing, which is what an empty tool panel looks like.
   */
  const inputMode = useUI((s) => s.inputMode);
  const toolCount = useUI((s) => s.enabledTools.length);
  const hasTools = live || inputMode === 'agent' || toolCount > 0;
  // Both call modes end up asking the same agent, and the agent reports its
  // tools on one channel, so one listener serves both. Only while the call is
  // actually up — a listener attached at `idle` would collect the tool calls of
  // whatever the user is doing in the chat behind the overlay.
  const toolActivity = useLiveToolActivity(phase !== 'idle' && phase !== 'ready');
  /** A tool is running right now. Its own signal rather than a sixth phase,
   *  because it is orthogonal: Cinderpaw can be answering out loud WHILE a search
   *  is still running, and the sphere should be able to say both at once. */
  const workingNow = toolActivity.some((a) => a.status === 'running');
  /** Which Gemini voice is answering — the sphere is tinted to match, so the
   *  choice is visible from across the room rather than only in a dropdown. */
  // The orb tints itself from the voice. Read under the PROVIDER now — under
  // the retired engine's key it would take its colour from a choice made for
  // an engine that no longer runs, and never change when the voice does.
  const s2sVoice = useUI((s) => (effectiveS2s ? s.ttsVoice[effectiveS2s] : undefined));
  const [voice, setVoice] = useState<TtsProviderInfo | null>(null);
  /** Can the chosen engine actually speak? `null` until known — the Call button
   *  must not be blocked by a check that has not answered yet, nor allowed by one
   *  that failed. */
  const [ready, setReady] = useState<boolean | null>(null);
  /**
   * True when this build has no speech engine that works without a key AND
   * none is configured. Separate from `ready === false` because the remedy is
   * different: `ready === false` means a chosen engine is not finished (a voice
   * to download, a key to paste, both of which this screen offers inline),
   * while this means there is nothing to finish and the person has to choose
   * something first.
   */
  const [noEngine, setNoEngine] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [mic, setMic] = useState<string | null>(null);

  /**
   * The actual input device, named.
   *
   * It was missing entirely, and its absence made the engine rows read as if they
   * were the hardware — "Groq" appeared where someone reasonably expected to see
   * their microphone. Device labels are only exposed once microphone permission
   * has been granted at least once, so an empty label is normal on a first run and
   * falls back to saying "system default" rather than to nothing.
   */
  useEffect(() => {
    if (phase !== 'ready' || !navigator.mediaDevices?.enumerateDevices) return;
    let current = true;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!current) return;
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        const preferred = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
        setMic(preferred?.label?.trim() || null);
      })
      .catch(() => { if (current) setMic(null); });
    return () => { current = false; };
  }, [phase]);

  // The engine the user picked, and whether it can actually speak. Asked of Rust
  // rather than hardcoded here: `isLocal` is a property of the engine, and this
  // notice is the reason the catalog carries it.
  useEffect(() => {
    if (phase !== 'ready') return;
    setKey('');
    // Branch on WHAT IS SELECTED, not on which engine drives the call. Both
    // arms run on LiveKit now, so testing `live` here sent the pipeline down
    // the speech-to-speech path: it never loaded the TTS engine it is made of,
    // which is why the voice pill showed a voice while the line under it said
    // no engine was chosen. It also checked the Google key for every call, on a
    // screen where the vendor is the user's choice.
    if (!currentS2s?.pipeline) {
      // A realtime vendor has no TTS engine to be ready — its one requirement
      // is a key, and the provider list already reports whether that is stored.
      setVoice(null);
      setReady(currentS2s ? currentS2s.connected : null);
      return;
    }
    tauri.voice
      .ttsProviders()
      .then(async (providers) => {
        // Nothing picked is the state EVERY fresh install is in, so it cannot be
        // left as "no engine". Fall back to the first engine this build can
        // actually run without a key — the same rule as
        // `cinderpaw_core::tts::default_engine()`, deliberately, because the two
        // must agree: Rust is what refuses the call, and disagreeing here would
        // enable a button whose press Rust then rejects.
        //
        // The picked engine is persisted, so the rest of the app (the voice pill,
        // the settings screen) sees the same answer instead of quietly disagreeing
        // with the call that just worked.
        const { engine: chosen, source } = chooseSpeechEngine(providers, ttsProvider);
        if (source === 'default' && chosen) setTtsProvider(chosen.id);

        setVoice(chosen);
        if (!chosen) {
          // Genuinely nothing: no engine was chosen and this build has none that
          // speaks without a key. That is a FACT, not an unknown, and the two
          // used to collapse into the same `null` — which left the Call button
          // enabled, booted Node, a LiveKit server and an npm install, and only
          // then failed, wrapped in advice about checking the network.
          setNoEngine(true);
          setReady(false);
          return;
        }
        setNoEngine(false);
        // "Ready", not "has a key": Piper needs no key and would pass a key check
        // with no voice downloaded, which is a call that listens, thinks, and then
        // cannot answer.
        setReady(await tauri.voice.ttsReady(chosen.id));
      })
      .catch(() => {
        // The catalogue could not be read. Unknown, not empty: leave the button
        // alone and let the engine report the truth.
        setVoice(null);
        setNoEngine(false);
        setReady(null);
      });
  }, [phase, ttsProvider, currentS2s, setTtsProvider]);

  const saveKey = async () => {
    // The vendor that is SELECTED, not a constant. This said `google` for every
    // realtime call, so pasting an OpenAI key here wrote it into the Google
    // keychain entry — a key stored under the wrong name is worse than one that
    // failed to store, because nothing reports it and the real entry is now
    // wrong too.
    const target = keyOwner(currentS2s, voice)?.id;
    if (!target || !key.trim()) return;
    setSaving(true);
    try {
      // Straight to the OS keychain, the same path every other provider key
      // takes. It is never written to a file and never echoed back.
      await tauri.voice.saveTtsKey(target, key.trim());
      // ponytail: no base URL / model field here — the picker owns those. An
      // engine that needs a region cannot be fixed from this panel; the "change
      // voice engine" link goes where it can.
      setKey('');
      // Re-read so `connected` reflects the just-stored key. The optimistic
      // `setReady(true)` alone left `s2sList` stale, so the next entry into
      // `ready` flipped `willEcho` true and `ready` false again — the exact
      // "asks for Gemini key every time" loop the user reported.
      try {
        const fresh = await tauri.raw.listS2sProviders();
        setS2sList(fresh);
      } catch {
        // Keep optimistic true: the key is at least in the keychain now, even
        // if the list could not be re-read.
      }
      setReady(true);
    } catch {
      useNotifications.getState().push('error', t('voice.keySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Escape hangs up. A screen this opaque needs the standard way out — but not
  // while a dialog is open on top of it: there, Escape belongs to the dialog, and
  // handling it here too would close the settings AND drop the call in one press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Any dialog EXCEPT this overlay. The overlay is itself a dialog now, so
      // a bare `[role="dialog"]` query matches itself and Escape would stop
      // hanging up entirely.
      if (document.querySelector('[role="dialog"]:not([data-call-overlay])')) return;
      onHangUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onHangUp]);

  if (phase === 'idle') return null;

  const speaking = phase === 'speaking';
  const listening = phase === 'listening';

  const title =
    listening ? t('call.listening')
    // In a Live call nothing local ever "thinks" — the model's own thinking shows
    // up as its answer arriving. This phase is only ever the socket opening.
    : phase === 'thinking' ? t(live ? 'call.liveConnecting' : 'call.thinking')
    : speaking ? t('call.speaking')
    // Which wait it is, not just that there is one. The stage is known at the
    // point it is being waited on, and a person who can see the engine start
    // and then the room join is watching progress rather than a frozen screen.
    : phase === 'connecting'
      ? stage === 'joining' ? t('call.stage.joining')
      : stage === 'mic' ? t('call.stage.mic')
      : t('call.stage.starting')
    : phase === 'reconnecting' ? t('call.reconnecting')
    : t('call.title');

  return createPortal(
    // `z-40`, deliberately BELOW the app's z-50 layer.
    //
    // At z-[100] this overlay sat above every Radix portal — dialogs, dropdowns,
    // image zoom all render at z-50 — so anything opened from inside the call
    // appeared behind it while Radix froze the page for modality. That produced
    // the same bug three times: an invisible engine picker, an invisible STT
    // card, and a voice dropdown that would not drop. Sitting under that layer
    // fixes the whole class instead of patching each popover's z-index.
    //
    // Window chrome and toasts live at z-200 and stay above everything.
    // A dialog, and declared as one. It covers the whole window and takes
    // every key, but without these a screen reader announced nothing when it
    // opened and Tab kept walking the chat underneath it — the caller's focus
    // was in a room they could no longer see.
    <div
      data-call-overlay=""
      role="dialog"
      aria-modal="true"
      aria-label={t('call.title')}
      className="fixed inset-0 z-40 flex"
      style={{ backgroundColor: 'var(--bg-primary, #100E09)' }}
    >
      {/* The frameless window still has to be movable while a call covers the
          screen. This strip spans the top and does nothing else. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-10 h-8" />

      <div
        className="call-stage relative flex flex-1 flex-col items-center justify-center gap-10 overflow-hidden px-6"
        style={{
          // The overlay carries its own text scale, and it has to.
          //
          // Everything in here uses the app's `--text-*` tokens, which are
          // tuned against the app's SURFACES — and this screen is not one. On
          // a warm near-black field, `--text-muted` (#8C7E6A in the dark
          // theme) is within a few points of the background it sits on: the
          // microphone line and the device button were effectively invisible,
          // which is how a caller loses the one place that tells them which
          // microphone is about to be used.
          //
          // Warm rather than pure white, so the type belongs to the same room
          // as the sphere, and stepped far enough apart that the hierarchy
          // still reads once the contrast is fixed.
          ['--text-primary' as string]: '#FFF3E4',
          ['--text-secondary' as string]: '#E4D2BC',
          ['--text-muted' as string]: '#B9A48C',
          background: [
    // The reference read properly this time: it is not pools of light, it is one
    // broad diagonal BEAM crossing the surface from lower left to upper right,
    // with the corners falling into deep red. Beam plus vignette. Earlier passes
    // kept adding soft pools, which averages to an even field — the exact thing
    // the reference is not. Layers paint first-on-top, so the corner darkening is
    // listed first and the base last.
    //
    // A dark room, so the sphere is the only light in it.
    //
    // This field used to be brand orange, and every choice inside the sphere
    // bent around that: a cool anchor so the silhouette survived, exactly one
    // warm region, a white glass shell. All of it was compensation for a ball
    // sitting on a background the same temperature as itself. Going dark is
    // what buys the molten look — contrast is free here, so the sphere can be
    // as hot as it likes.
    //
    // Still five hues rather than five greys, for the same reason as before: a
    // single colour at three brightnesses reads as a flat wash however many
    // layers build it. These are just all near-black now.
    // Warm bloom directly behind the ball — the light it throws into the room.
    // Sized and placed to sit under the sphere, so the glow belongs to it.
    'radial-gradient(ellipse 46% 52% at 50% 46%, rgba(196, 74, 22, 0.30) 0%, rgba(150, 52, 16, 0.14) 34%, rgba(90, 30, 12, 0.05) 54%, transparent 74%)',
    // Cool plum in the top-left, the one thing keeping the dark from going
    // muddy brown where the bloom falls off.
    'radial-gradient(ellipse 62% 56% at 4% 2%, rgba(52, 26, 64, 0.55) 0%, rgba(34, 20, 46, 0.28) 38%, transparent 70%)',
    // A colder blue-grey in the opposite corner, so the two tinted corners
    // frame the sphere instead of stacking on one side.
    'radial-gradient(ellipse 70% 60% at 100% 100%, rgba(26, 34, 52, 0.60) 0%, rgba(18, 22, 34, 0.30) 40%, transparent 72%)',
    // A very faint warm floor, so the ball looks like it is above a surface
    // rather than floating in a void.
    'radial-gradient(ellipse 60% 22% at 50% 100%, rgba(120, 48, 18, 0.22) 0%, transparent 70%)',
    // The base. Charcoal that leans warm in the middle and cold at the edges.
    'linear-gradient(160deg, #14100F 0%, #1A1513 26%, #221A17 52%, #191413 76%, #100D0D 100%)',
          ].join(', '),
        }}
      >
        {/* The slow warp. Two wide, weak washes that lean on the beam from
            either side and turn over about once a minute — far too slow and too
            faint to watch, which is the point: the objection to a moving
            background is that it becomes wallpaper, and that only applies to
            motion you can see. What this removes is the stillness that makes a
            gradient read as a painted surface. The layer that actually says
            "something is happening" is still the speech-tied one below. */}
        <div
          aria-hidden
          className="orb-motion pointer-events-none absolute -inset-[12%]"
          style={{
            background: [
              // Two washes that are two different colours, so the warp is a
              // colour SHIFT and not a brightness wobble. At one hue the slow
              // turn was invisible, which made the whole layer pointless.
              // Dimmed hard for the dark room. At the old strengths these were
              // two pink clouds on charcoal; the job is to keep the background
              // from reading as painted, not to be seen.
              'radial-gradient(ellipse 58% 50% at 20% 76%, rgba(120, 40, 96, 0.16) 0%, rgba(110, 46, 54, 0.07) 44%, transparent 72%)',
              'radial-gradient(ellipse 64% 46% at 84% 30%, rgba(150, 96, 48, 0.14) 0%, rgba(130, 74, 34, 0.05) 46%, transparent 74%)',
            ].join(', '),
            // 64s was slower than anyone stays on one screen. At 34 it is still
            // below "look, it's moving" and above "nothing ever changes".
            animation: 'stage-flow 34s ease-in-out infinite',
          }}
        />

        {/* The field's one moving part you are meant to notice, and it moves
            only while a voice is in the room: listening or speaking, never
            thinking and never at rest.
            A background that drifts continuously becomes wallpaper within
            thirty seconds — tying it to speech makes the screen answer the one
            question a caller actually has, which is whether anything is
            happening. While listening it also swells with the measured mic
            level, so it is reacting to YOU rather than performing. */}
        {(phase === 'listening' || phase === 'speaking') && (
          <div
            aria-hidden
            className="orb-motion pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{
              background:
                'radial-gradient(ellipse 58% 46% at 62% 28%, rgba(224,132,56,0.22) 0%, rgba(198,104,44,0.11) 34%, rgba(150,72,30,0.04) 52%, transparent 70%)',
              // Listening tracks the microphone; speaking has no measured
              // loudness (the audio is scheduled, never read back), so it
              // breathes on the clock instead of faking a level.
              opacity: phase === 'listening' ? 0.45 + level * 0.55 : 0.75,
              animation: `stage-drift ${phase === 'listening' ? '7s' : '5s'} ease-in-out infinite`,
            }}
          />
        )}

        {/* The close glow that seats the sphere in the field — kept, because
            without it the ball floats a centimetre off the surface. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-700"
          style={{
            background:
              // The sphere's own light spilling onto the room. Bigger and
              // warmer than before, because on a dark field this is the layer
              // that makes the ball look like a source instead of a decal.
              'radial-gradient(circle, rgba(255,146,64,0.20) 0%, rgba(236,116,44,0.13) 22%, rgba(196,86,30,0.07) 40%, rgba(140,58,22,0.03) 56%, transparent 72%)',
            opacity: phase === 'ready' ? 0.55 : 0.95,
          }}
        />

        <Orb phase={phase} level={level} working={workingNow} voice={s2sVoice ?? currentS2s?.default_voice} />

        {/* Voice picker, live for the whole call. Deliberately not buried in the
            pre-call panel: which voice is talking is the one setting you want to
            change WHILE hearing it, and the next thing said picks it up. */}
        {/* No language selector anywhere, by product decision: the transcriber
            identifies the spoken language per request, which is what makes
            switching language mid-call work at all. */}
        {/* Nothing to pick in a Live call: the voice belongs to the model, not to
            a synthesiser we choose. */}
        {currentS2s?.pipeline && ttsProvider && <VoicePicker engineId={ttsProvider} />}
        {/* A Live call has a voice too, and it is the one thing that must not be
            re-rolled per session — left unpinned, the server picks, and the same
            assistant answers in a different voice tomorrow. Eight fixed names,
            so all of them are offered rather than a shortlist. */}
        {currentS2s && !currentS2s.pipeline && (
          <VoicePicker
            // Keyed by PROVIDER, not by "the live engine". A voice id is only
            // meaningful to the vendor that issued it, and this used to list
            // Gemini's eight names whatever was running — so picking one on an
            // OpenAI call chose a voice that vendor has never heard of.
            key={currentS2s.id}
            engineId={currentS2s.id}
            limit={99}
            defaultVoiceId={currentS2s.default_voice}
            load={async () =>
              currentS2s.voices.map((v) => ({ id: v, label: v, locale: '' }))
            }
          />
        )}

        <div className="relative flex max-w-xl flex-col items-center gap-2 text-center">
          {/* The phase line is the whole state of the call: listening,
              thinking, speaking, reconnecting. On screen it changes in place,
              so a sighted caller always knows. Announced politely, a caller
              who cannot see it knows too, and that is the person most likely
              to be using their voice in the first place. */}
          <p
            aria-live="polite"
            aria-atomic="true"
            className="text-2xl font-light tracking-tight text-text-primary"
          >
            {title}
          </p>
          {/* What it heard, or the invitation when it has heard nothing yet. */}
          <CallTranscript
            text={phase !== 'ready' ? heard : ''}
            fallback={t('call.prompt')}
          />
          {/* Said out loud on screen when nothing was said out loud in audio. */}
          {notice && <p className="text-sm text-[var(--warning)]">{notice}</p>}
        </div>

        {phase === 'ready' && (
          <div className="relative flex flex-col items-center gap-3">
            {/* Who answers, chosen before the microphone opens. It runs on the
                user's own key, so this is a connection they made — not
                something the call has built into it. */}
            <ProviderToggle providers={s2sList} effective={effectiveS2s} willEcho={willEcho} onChange={setS2sProvider} t={t} />

            {/* The disclosure, as two quiet lines rather than a boxed table: it has
                to be read before the microphone opens, not filled in. */}
            <div className="flex flex-col items-center gap-1.5 text-sm">
              {/* The hardware first, so nothing below it can be mistaken for it. */}
              <span className="flex items-center gap-2">
                <span className="text-text-muted">{t('call.mic')}</span>
                <span className="text-text-secondary">{mic ?? t('call.micDefault')}</span>
              </span>
              {!currentS2s?.pipeline ? (
                // One line, because a realtime vendor IS the engine. Listing
                // "speech → text" and "text → speech" here would describe steps
                // that do not happen inside one session.
                <EngineLine
                  label={t('call.provider')}
                  name={currentS2s?.label ?? t('call.providerNoneShort')}
                  // This row only renders for a NON-pipeline provider, i.e. a
                  // cloud realtime vendor. So the honest answer is fixed: when
                  // this call runs, the audio goes to Google or OpenAI.
                  //
                  // `!connected` printed the green "on device" badge for a
                  // vendor whose key is merely MISSING — which is the state a
                  // fresh install is in, on the one line of this screen that
                  // exists to be trusted about exactly that. A privacy promise
                  // must never be made by a keychain lookup failing.
                  //
                  // The echo state is a separate fact and is already disclosed
                  // twice: "(no key)" on the provider button and the willEcho
                  // line under it. `null` still hides the badge when no
                  // provider is known, rather than guessing.
                  local={currentS2s ? false : null}
                  t={t}
                />
              ) : (
                // The pipeline is three choices, so it discloses three. These
                // two rows and their pickers already existed and went dark when
                // the old `pipeline` engine was retired — the row brings them
                // back rather than growing a second set.
                <>
                  <EngineLine
                    label={t('call.stt')}
                    name={sttProvider === 'groq' ? 'Groq · whisper-large-v3' : 'Whisper'}
                    local={sttProvider === 'local' ? true : sttProvider === 'groq' ? false : null}
                    t={t}
                    // Both halves of the call are configurable from here. Only the
                    // speaking half had a way in, so the engine that hears you — and
                    // its key — could not be reached from the screen that names it.
                    onChange={onChangeStt}
                  />
                  <EngineLine
                    label={t('call.tts')}
                    name={voice?.label ?? t('call.engineUnset')}
                    local={
                      voice
                        ? ((voice as unknown as { isLocal?: boolean; is_local?: boolean }).isLocal ??
                          (voice as unknown as { isLocal?: boolean; is_local?: boolean }).is_local ??
                          false)
                        : null
                    }
                    t={t}
                    onChange={onChangeEngine}
                  />
                </>
              )}
            </div>

            {/* Only the case worth interrupting for. A call that CANNOT act is
                a different product from one that can, and the tool panel it
                would normally fill stays empty — which reads as broken rather
                than as "nothing to do". The opposite line (tools are on, here
                is what that means) was noise on a screen the user reads once
                and then never again, and it is gone. */}
            {!hasTools && (
              <span className="flex items-center gap-2">
                <span className="text-text-muted">{t('call.tools')}</span>
                <span className="text-[var(--warning)]">{t('call.toolsOff')}</span>
              </span>
            )}

            {/*
              Nothing on this machine can speak yet. Said HERE, before the press,
              rather than after twenty seconds of booting Node, a LiveKit server
              and an npm install — which is what the person used to sit through
              before being told to check whether they were online.
            */}
            {noEngine && (
              <p className="max-w-sm text-center text-xs text-[var(--warning)]">
                {t('call.noEngine')}
              </p>
            )}
            {ready === false && !noEngine && voice?.needsDownload && (
              <p className="max-w-sm text-center text-xs text-[var(--warning)]">{t('call.voiceMissing')}</p>
            )}
            {ready === false && !noEngine && (live || voice?.needsKey) && (
              <div className="w-full max-w-sm">
                <p className="mb-2 text-center text-xs text-text-muted">
                  {keyOwner(currentS2s, voice)
                    ? t('call.keyNeededFor').replace(
                        '{provider}',
                        keyOwner(currentS2s, voice)!.label,
                      )
                    : t('call.keyNeeded')}
                </p>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
                    placeholder={t('call.keyPlaceholder')}
                    className="h-9 text-sm"
                  />
                  <Button size="sm" onClick={() => void saveKey()} disabled={!key.trim() || saving}>
                    {saving ? <Loader2 size={14} className="animate-spin" /> : t('call.keySave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Controls: one pill, round buttons, nothing labelled. A call is the one
            screen where the two things you can do are obvious from the icons. */}
        {/* Opaque surface and the stronger border, not a 70% wash over the page.
            In dark that translucency read as a pill; in light it put #F5EBE0 at
            70% over #FFF5EE, which is the same colour — the two most important
            controls on the screen sat in a container nobody could see. A shadow
            does the lifting that the transparency was pretending to do. */}
        <div className="relative flex items-center gap-2 rounded-full border border-border-default bg-bg-surface p-2 shadow-lg">
          <RoundButton onClick={onHangUp} label={t('call.hangUp')} tone="danger">
            <X size={20} />
          </RoundButton>

          {phase === 'ready' && noEngine ? (
            /*
              A disabled circle is a dead end with no instructions, and this is
              the first screen a stranger reaches. So the control keeps its place
              and its prominence and changes its JOB: it takes them to the one
              screen where the choice can be made. One press forward instead of
              one press into a failure.
            */
            <RoundButton
              // `onChangeEngine`, not a route: the engine picker already exists
              // and ChatInput already wires it to reopen the call as soon as a
              // choice is made ("Picking a voice flows straight into the call it
              // was blocking"). Sending them to Settings instead would drop them
              // out of the call they were trying to make, and the settings rail
              // has no voice category to land on.
              onClick={onChangeEngine}
              label={t('call.setUpVoice')}
              tone="brand"
            >
              <Settings2 size={20} />
            </RoundButton>
          ) : phase === 'ready' ? (
            <RoundButton
              onClick={onAnswer}
              label={t('call.answer')}
              tone="brand"
              // Opening the microphone for a call that cannot answer wastes the
              // words someone already said. `null` (the check failed) still allows
              // it: refusing on an unknown is worse than letting the engine report
              // the truth.
              disabled={ready === false}
            >
              <Phone size={20} />
            </RoundButton>
          ) : (
            <RoundButton
              onClick={onInterrupt}
              label={t('call.interrupt')}
              // Only meaningful while it is talking; the rest of the time it is a
              // state light, which is why it dims instead of disappearing.
              disabled={!speaking}
              active={listening}
            >
              {speaking ? <MicOff size={20} /> : <Mic size={20} />}
            </RoundButton>
          )}
        </div>

        {/* What Cinderpaw is doing, while it does it. The one thing that separates a
            call that is working from one that has hung — and, on a call that
            runs tools, the only visible evidence the agent is real. */}
        <CallToolScreen activity={toolActivity} />

        {/* The way back to text, for what dictation mangles — a URL, a name, an
            error string. Closed by default so the call stays a call. */}
        {/* The sources, kept. Sits above the chat button and appears only once
            a lookup has produced something to return to. */}
        {artifactCount > 0 && !artifactsOpen && (
          <button
            type="button"
            onClick={() => setArtifactsOpen(true)}
            aria-label={t('call.artifacts')}
            title={t('call.artifacts')}
            className="absolute bottom-24 right-6 flex items-center gap-1.5 rounded-full border border-border-default bg-bg-elevated px-3 py-2 text-xs text-text-secondary shadow-lg transition-colors hover:border-brand hover:text-brand"
          >
            <Archive size={15} />
            {artifactCount}
          </button>
        )}

        {phase !== 'ready' && !chatOpen && onSay && (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            aria-label={t('call.chat')}
            title={t('call.chat')}
            className="absolute bottom-6 right-6 rounded-full border border-border-default bg-bg-elevated p-3 text-text-secondary shadow-lg transition-colors hover:border-brand hover:text-brand"
          >
            <MessageSquare size={18} />
          </button>
        )}
      </div>

      {artifactsOpen && <CallArtifacts onClose={() => setArtifactsOpen(false)} />}
      {chatOpen && onSay && <CallChatPanel onClose={() => setChatOpen(false)} onSay={onSay} />}
    </div>,
    document.body,
  );
}

/**
/**
/**
 * A palette per Gemini voice, so the sphere says who is talking.
 *
 * Eight voices that are otherwise only a name in a dropdown; the ball is the
 * one thing on the screen big enough to carry the difference. `anchor` is the
 * cool mass that keeps the sphere off the orange field, `cool` is the note that
 * makes the anchor read as a colour rather than as grey, and `warm` is the
 * single warm region — one, never two, or the edge dissolves into the
 * background.
 *
 * Unknown names fall back to Kore's, which is also what Rust pins by default,
 * so a voice added by the vendor tomorrow looks deliberate rather than broken.
 */
const VOICE_PALETTE: Record<
  string,
  { deep: string; mid: string; hot: string; glow: string; rim: string; base: string }
> = {
  // Eight MOLTEN metals, not eight tinted glass balls.
  //
  // The sphere used to be pale glass with colour suspended inside it, sitting on
  // a bright orange field. That composition had one hard constraint — exactly
  // one warm region, or the ball dissolved into the background it matched. The
  // field is dark now, which removes that constraint entirely: on charcoal, the
  // hottest possible sphere has the MOST separation, not the least.
  //
  // So each row is a temperature ramp through one metal rather than a set of
  // contrasting hues:
  //   `deep` — the dark veins where the melt has cooled. This is what makes it
  //            read as marbled liquid instead of a glowing ball; without a dark
  //            end the swirl has nothing to be a swirl against.
  //   `mid`  — the body, the colour you would name if asked.
  //   `hot`  — the bright core, near the top of the ramp.
  //   `glow` — what it throws onto the room around it.
  //   `base` — three stops for the mass underneath, dark to mid. Dark, always:
  //            a pale base is what turned the old sphere into a pearl.
  /** Molten iron — the default, and the one the Rust side pins. */
  Kore:    { deep: '104, 26, 8',   mid: '226, 88, 22',  hot: '255, 194, 92',  glow: '255, 122, 40',  rim: '54, 14, 4',  base: '#3A0E04,#8C2A0A,#C2470F' },
  /** Molten copper, cooled towards green in the veins. */
  Puck:    { deep: '10, 62, 58',   mid: '30, 168, 138', hot: '176, 255, 206', glow: '40, 200, 160',  rim: '4, 34, 32',  base: '#04211F,#0B5B50,#12897A' },
  /** Molten steel — the coldest of the eight. */
  Charon:  { deep: '18, 26, 70',   mid: '72, 104, 200', hot: '178, 214, 255', glow: '96, 140, 235',  rim: '8, 12, 40',  base: '#070B24,#1B2A6B,#2E47A0' },
  /** Molten ruby. */
  Fenrir:  { deep: '96, 6, 34',    mid: '214, 32, 82',  hot: '255, 158, 190', glow: '236, 60, 110',  rim: '48, 2, 18',  base: '#2C0212,#770A2A,#AE1444' },
  /** Molten jade. */
  Aoede:   { deep: '10, 58, 30',   mid: '46, 166, 84',  hot: '190, 255, 158', glow: '70, 200, 110',  rim: '4, 30, 16',  base: '#04200F,#0E5A2A,#177F3C' },
  /** Molten rose gold. */
  Leda:    { deep: '72, 10, 30',   mid: '232, 76, 92',   hot: '255, 172, 120', glow: '246, 110, 108', rim: '34, 4, 16',  base: '#1E030C,#7A1830,#C43C50' },
  /** Molten bronze — the closest sibling to the default. */
  Orus:    { deep: '86, 40, 4',    mid: '198, 128, 24',  hot: '255, 224, 140', glow: '236, 168, 52',  rim: '42, 18, 2',  base: '#2A1301,#6E3F06,#9C6410' },
  /** Molten glacier — pale, and the only one whose deep end is still blue. */
  Zephyr:  { deep: '10, 54, 90',   mid: '58, 152, 214',  hot: '206, 246, 255', glow: '96, 190, 245',  rim: '4, 26, 46',  base: '#031A2E,#0D4A76,#1670A6' },
};

/**
 * How fast the colour inside the sphere drifts, per call state. One set of
 * motions at four tempos, so it stays recognisably the same object while
 * telling you what it is doing.
 *
 * `ready` is slow enough to read as at rest without being frozen; `thinking` is
 * the fastest, because that is the state where the user is waiting and needs to
 * see that something is happening.
 */
const ORB_TEMPO: Record<CallPhase, { a: string; b: string; c: string; breathe: string }> = {
  // At rest it should look alive, not busy. In the three states where something
  // is HAPPENING it has to look like something is happening, and it did not:
  // listening ran a blob across the sphere in thirteen seconds, which at any
  // glance shorter than that is a still image. The rule of thumb these follow is
  // that a state you watch for a couple of seconds needs a cycle of about that
  // long, or the eye cannot tell it from paint.
  // Two clocks, and they are not the same clock. The COLOUR inside may move
  // quickly — that is the fluid, and it is what says the thing is awake. The
  // BREATH is the whole ball changing size, and it must stay slow whatever the
  // state: a sphere breathing twice a second does not read as alive, it reads
  // as agitated. The first pass drove both together and the result was a
  // hummingbird.
  idle:      { a: '30s', b: '38s', c: '24s', breathe: '7s' },
  ready:     { a: '26s', b: '34s', c: '20s', breathe: '6s' },
  // Connecting and reconnecting are both waits, and a wait has to look like
  // work or it looks like a hang. Faster than `ready` and slower than
  // `thinking`: something is happening, and it is not an answer arriving.
  connecting:   { a: '8s',  b: '11s', c: '6s',  breathe: '3s' },
  reconnecting: { a: '8s',  b: '11s', c: '6s',  breathe: '3s' },
  listening: { a: '13s', b: '17s', c: '10s', breathe: '5s' },
  thinking:  { a: '6s',  b: '8s',  c: '5s',  breathe: '2.4s' },
  speaking:  { a: '9s',  b: '12s', c: '7s',  breathe: '3.2s' },
};

/**
 * The living part of the screen — a swirl sphere.
 *
 * Glass with a few broad regions of colour suspended INSIDE it, meeting and
 * bleeding into one another. Not ribbons and not relief: the previous version
 * chased twisted foil through repeating conic gradients and hard-stopped
 * ridges, which is a different object entirely.
 *
 * Four rules make it read as one solid ball rather than as stacked circles:
 *
 *  1. **Few blobs, and big.** Four regions, each wide enough to own a quarter of
 *     the sphere. A longer list at smaller radius reads as spots.
 *  2. **No edge anywhere.** Every blob is blurred far past its own radius, so
 *     colour meets colour in a wide transition. An edge inside glass reads as a
 *     decal stuck on the surface.
 *  3. **A pale base, not white.** Colour needs something to be brighter than;
 *     paper-white leaves nothing for it to lift off, which is how this ends up
 *     a beige pearl.
 *  4. **The coat is separate from the colour.** Rim, travelling glint and sheen
 *     sit ON TOP of the clip, never inside it — that separation is what makes
 *     the ball look wet rather than lit.
 *
 * Listening scales it with the measured mic level, so it reacts to *you*. The
 * other states drift on their own, because the reply's loudness is never
 * measured — the audio is scheduled on the Web Audio clock, not read back, and
 * faking a waveform from nothing would be a lie in the one place the user is
 * looking for feedback. Tempo carries the state instead.
 */
function Orb({
  phase,
  level,
  working,
  voice,
}: {
  phase: CallPhase;
  level: number;
  working: boolean;
  /** The Live voice answering, when there is one. Only tints the sphere. */
  voice?: string;
}) {
  const tempo = ORB_TEMPO[phase];
  const hue = (voice && VOICE_PALETTE[voice]) || VOICE_PALETTE.Kore!;
  // The mic only scales the sphere while listening; elsewhere the breathing
  // keyframe owns the scale and the two would fight over the same property.
  /**
   * The sphere answers BOTH voices, and neither through React.
   *
   * While the user talks it follows the microphone; while the agent talks it
   * follows the reply's own loudness, measured off the audio being played
   * (`speechLevel`). That second half never existed: the reply's volume was
   * never read back, so through an entire answer the sphere ran at one fixed
   * tempo and looked switched off at exactly the moment the caller is watching
   * it hardest.
   *
   * Written to a CSS variable from a frame loop rather than to state. Sixty
   * `setState` calls a second would re-render this overlay, the chat input that
   * owns it and everything under them, for something the compositor can do by
   * itself — and re-render storms are the reason the rest of this screen
   * already lags behind the conversation.
   */
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Read inside the loop, never depended on. `level` arrives as a prop several
  // times a second, and listing it as a dependency tore the loop down and built
  // a new one on every reading — with `shown` and `voice` starting from zero
  // again each time. The smoothing could never accumulate, so the sphere jumped
  // from nothing to something and back on every syllable, which is the "full
  // auto" everyone saw. One loop for the component's life, reading the latest
  // values through refs, is the whole fix.
  const levelRef = useRef(level);
  levelRef.current = level;
  /** The smoothed value the shader reads. Same number the CSS variable gets. */
  const smoothedRef = useRef(0);
  /**
   * Does this machine have WebGL2?
   *
   * Starts optimistic and flips once if the shader cannot run, which puts the
   * CSS sphere back. Keeping that path alive is the whole reason it is still
   * in this file: a blocklisted GPU, a driver reset that never recovers, or a
   * WebView built without WebGL must all end at a working call screen, not at
   * a hole where the sphere was.
   */
  const [shaderOk, setShaderOk] = useState(true);
  const dropShader = useCallback(() => setShaderOk(false), []);
  /**
   * Give the shader another chance whenever a new call starts.
   *
   * The fallback used to be permanent for the life of the component: one lost
   * context — a driver reset, the GPU process being recycled, waking from
   * sleep — and every call for the rest of the session ran on the CSS sphere,
   * with nothing on screen saying why. A graphics stack that failed once is
   * usually fine a minute later, so the only sensible scope for "this machine
   * cannot do it" is a single call.
   */
  useEffect(() => {
    if (phase === 'ready') setShaderOk(true);
  }, [phase]);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const at = phaseRef.current;
      const target = at === 'listening' ? levelRef.current : at === 'speaking' ? speechLevel() : 0;
      // Ease towards it, slowly. At a quarter per frame the sphere tracked
      // individual syllables and twitched; what should show through is the
      // ENVELOPE of a voice — the swell of a phrase, not every consonant in it.
      shown += (target - shown) * 0.06;
      shellRef.current?.style.setProperty('--orb-level', shown.toFixed(3));
      // The shader reads the same smoothed number, straight from a ref. Going
      // back through `getComputedStyle` for it would force a style resolve on
      // every frame to fetch a value we are already holding.
      smoothedRef.current = shown;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /**
   * Tool work reads as CHURN, not as another speed.
   *
   * Spinning the whole ball faster is what it already does while thinking, so
   * reusing that would say the same thing twice and mean neither. Only the
   * colour INSIDE takes it, while the breathing and the glint keep the phase's
   * tempo — so it composes: Cinderpaw can be speaking and searching at once, and
   * the sphere shows both.
   */
  const churn = (d: string) => (working ? `${(parseFloat(d) / 2.6).toFixed(1)}s` : d);

  /** Pull one blob off the shared tempo without inventing a fifth clock. */
  const scale = (d: string, by: number) => `${(parseFloat(d) * by).toFixed(1)}s`;

  /**
   * One region of suspended colour.
   *
   * Oversized and blurred well beyond its radius: the blur is what turns four
   * discs into one continuous swirl, so it is structural rather than
   * decorative. `alternate` on the drift keeps a blob from ever completing a
   * lap — a colour that returns to where it started reads as a rotating
   * texture, which is the thing this is not.
   */
  const blob = (
    /** `r, g, b` — the alpha is applied here, at two strengths. */
    rgb: string,
    alpha: number,
    at: string,
    size: string,
    blur: string,
    duration: string,
    delay = '0s',
    /** How elliptical this region is. A circle blurred is still a circle; an
     *  ellipse that turns is what stretches and slims as it goes. */
    shape = '58% 42%',
    /**
     * Fixed angle for this band, before the drift turns it further.
     *
     * This is what makes the sphere marbled rather than mottled. Every region
     * used to be a near-circular puff on the same axis, and a pile of puffs is
     * a cloud — soft patches of colour with no direction, which is exactly how
     * the first attempt read. Marble is made of long streaks that CROSS each
     * other, so each band is stretched thin and laid at its own angle; where
     * two of them overlap at different angles you get the seam that says
     * "flow" instead of "blur".
     */
    tilt = '0deg',
  ) => (
    // The tilt has to live on a wrapper: `orb-flow` animates `transform` on
    // the element below, so a rotation set there would be overwritten on the
    // first frame.
    <div
      aria-hidden
      className="absolute"
      style={{
        width: size,
        height: size,
        left: `calc(${at.split(' ')[0]} - ${size} / 2)`,
        top: `calc(${at.split(' ')[1]} - ${size} / 2)`,
        transform: `rotate(${tilt})`,
      }}
    >
    <div
      aria-hidden
      className="orb-motion absolute inset-0 rounded-full"
      style={{
        // Three stops, not two. A single stop to `transparent` fades along a
        // straight ramp, and a straight ramp is what makes overlapping colours
        // average into mud instead of marbling: the midpoint holds most of the
        // colour, then it lets go fast, so two regions meet in a visible seam
        // of the mixed hue rather than in a grey plateau.
        background:
          `radial-gradient(ellipse ${shape} at 50% 50%, ` +
          `rgba(${rgb}, ${alpha}) 0%, ` +
          `rgba(${rgb}, ${(alpha * 0.6).toFixed(2)}) 38%, ` +
          `transparent 74%)`,
        filter: `blur(${blur})`,
        // The duration rides a CSS variable instead of sitting in the shorthand,
        // and that is the whole reason the colour stopped jumping back to where
        // it started every time the agent began to answer. Each phase has its
        // own tempo, so the shorthand string changed on every phase change —
        // and a changed `animation` property RESTARTS the animation, snapping
        // all four regions home at once. Changing only `animation-duration`
        // retimes a running animation instead of beginning a new one.
        ['--flow' as string]: duration,
        animationName: 'orb-flow',
        animationDuration: 'var(--flow)',
        animationTimingFunction: 'cubic-bezier(0.45, 0, 0.55, 1)',
        animationDelay: delay,
        animationIterationCount: 'infinite',
        animationDirection: 'alternate',
      }}
    />
    </div>
  );

  // The molten mass under the veins, dark → bright, per voice.
  const [baseDark, baseMid, baseBright] = hue.base.split(',');

  return (
    <div ref={shellRef} className="orb-shell relative flex h-60 w-60 items-center justify-center">
      {/* Halo — tracks the sphere one step behind, so loud speech pushes light
          outward instead of only stretching the disc. Kept faint: at 32% it was a
          second glowing ring around a glowing ball, which is what made the screen
          look cheap. */}
      <div
        aria-hidden
        className="orb-halo absolute inset-0 rounded-full"
        style={{
          background:
            // A molten object throws light. On the old orange field a warm halo
            // erased the silhouette, so this had to be the cool anchor; on
            // charcoal the opposite is true — the bloom is the thing that says
            // the sphere is a source rather than a sticker.
            `radial-gradient(circle, rgba(${hue.glow}, 0.34) 0%, rgba(${hue.glow}, 0.20) 38%, rgba(${hue.glow}, 0.07) 58%, transparent 74%)`,
        }}
      />

      {/* Tools are running. Sits between the halo and the body, outside the
          clip, so the arc travels the silhouette rather than the fluid.
          Mounted only while working — an always-present element at zero opacity
          would still cost a compositor layer for the whole call. */}
      {working && (
        <div
          aria-hidden
          className="orb-motion pointer-events-none absolute -inset-[7%] rounded-full"
          style={{ animation: 'orb-sweep-pulse 2.1s ease-in-out infinite' }}
        >
          <div
            className="orb-motion absolute inset-0 rounded-full"
            style={{
              background:
                // One bright arc, the rest transparent. The trailing stops are
                // what give it a comet tail instead of a hard spoke.
                `conic-gradient(from 0deg, transparent 0deg, transparent 250deg, rgba(${hue.hot},0.10) 285deg, rgba(${hue.hot},0.55) 330deg, rgba(255,255,255,0.92) 352deg, rgba(${hue.hot},0.55) 358deg, transparent 360deg)`,
              // Cut to a ring. Without the mask this is a filled pie slice
              // rotating over the ball, which looks like a loading spinner
              // someone dropped on top of the artwork.
              WebkitMaskImage:
                'radial-gradient(closest-side, transparent 84%, #000 88%, #000 97%, transparent 100%)',
              maskImage:
                'radial-gradient(closest-side, transparent 84%, #000 88%, #000 97%, transparent 100%)',
              animation: 'orb-sweep 2.1s linear infinite',
              filter: `drop-shadow(0 0 8px rgba(${hue.glow},0.85))`,
            }}
          />
        </div>
      )}

      {/* Scaled by the frame loop through `--orb-level`, never by a React state
          update per microphone reading. */}
      <div className="orb-body relative h-44 w-44">
        {shaderOk ? (
          /* The shader does its own lighting — fresnel, specular, falloff — so
             none of the CSS coat below is layered on top of it. Two lighting
             models on one object is what makes a render look like a sticker on
             a photograph. All that stays outside is the halo and the tool ring,
             which belong to the room rather than to the surface. */
          <div
            className="absolute inset-0 overflow-hidden rounded-full"
            style={{
              boxShadow:
                `0 0 40px rgba(${hue.glow}, 0.55), 0 0 110px rgba(${hue.glow}, 0.28), 0 22px 60px rgba(0, 0, 0, 0.55)`,
              animation: `orb-breathe ${tempo.breathe} ease-in-out infinite`,
            }}
          >
            <MoltenOrb
              levelRef={smoothedRef}
              phase={phase}
              working={working}
              palette={{ deep: hue.deep, mid: hue.mid, hot: hue.hot }}
              onUnavailable={dropShader}
            />
          </div>
        ) : (
          <>
        <div
          className="orb-motion orb-fluid absolute inset-0 overflow-hidden rounded-full"
          style={{
            // The molten mass the veins move through. Lit from upper left and
            // falling away to near-black at the lower right, so the ball has
            // a light direction before a single blob is drawn.
            background:
              `radial-gradient(circle at 36% 28%, ${baseBright} 0%, ${baseMid} 44%, ${baseMid} 58%, ${baseDark} 100%)`,
            // Its own light, thrown outward. Two radii: a tight hot one that
            // reads as heat coming off the surface, and a wide soft one that
            // lifts the charcoal behind it.
            boxShadow:
              `0 0 40px rgba(${hue.glow}, 0.55), 0 0 110px rgba(${hue.glow}, 0.28), 0 22px 60px rgba(0, 0, 0, 0.55)`,
            // Breathing lives on the clipping layer, not on the wrapper, so it
            // composes with the voice scale instead of overwriting it. Exactly
            // where it was before this file was touched today.
            animation: `orb-breathe ${tempo.breathe} ease-in-out infinite`,
          }}
        >
          {/* Four regions, and no two of them on the same clock. Sharing a
              duration is what made this read as a texture: two blobs on
              `tempo.b` reach their extremes together every cycle, the eye finds
              the beat, and a beat is the opposite of liquid. The multipliers
              below are deliberately not simple ratios of each other, so the
              four never line up twice in the same way. */}
          {/* The dark veins, and they are the whole trick.
              A ball of hot colours is a glowing ball; hot colours with COLD
              ones cutting through them is molten marble.

              The blur here is the single most important number on the sphere,
              and the first pass had it at 18-30px on a 176px ball — which is
              wide enough that every region averaged into its neighbours and
              the whole thing came out a smooth pearl with a gradient. Blur has
              to be big enough that no region shows an edge and small enough
              that two regions still MEET somewhere visible. That window is
              narrow, and it is around 10-13px at this size. */}
          {blob(hue.deep, 0.98, '30% 62%', '132%', '11px', churn(tempo.a), '0s', '92% 20%', '-24deg')}
          {/* A second dark band crossing the first at a wide angle. One vein
              reads as a shadow; two that cross read as flow. */}
          {blob(hue.deep, 0.86, '66% 34%', '116%', '10px', churn(scale(tempo.a, 1.43)), '-11s', '88% 18%', '38deg')}
          {/* A third, short and steep, breaking up the lower mass. */}
          {blob(hue.deep, 0.66, '56% 86%', '92%', '9px', churn(scale(tempo.c, 1.77)), '-6s', '80% 24%', '74deg')}
          {/* The body colour, the widest band, nearly level. */}
          {blob(hue.mid, 0.94, '52% 50%', '126%', '12px', churn(scale(tempo.b, 1.0)), '-4s', '94% 26%', '8deg')}
          {/* The hot core, upper-left where the light is, laid across the
              body band so the two make a seam rather than a halo. */}
          {blob(hue.hot, 0.90, '38% 32%', '96%', '10px', churn(scale(tempo.c, 1.31)), '-9s', '86% 22%', '-52deg')}
          {/* The brightest flare, thinnest and fastest — the highlight inside a
              liquid always moves quicker than the mass carrying it. */}
          {blob(hue.hot, 0.76, '64% 58%', '72%', '8px', churn(scale(tempo.b, 0.73)), '-14s', '90% 16%', '20deg')}
        </div>

        {/* The glass, in three parts, all on top of the clip.
            1. The rim: a bright hairline where the sphere's edge bends the light
               back at you, and a dark inner floor so the bottom recedes. Without
               these the colour reads as a flat disc.
            2. The travelling glint: a real specular moves as a sphere turns, and
               a fixed one is the clearest tell that this is a circle with a
               gradient on it.
            3. The broad sheen, which is what makes it look wet rather than lit. */}
        {/* 1. The shell. A glass ball is not a lit ball: what says "glass" is a
               hard bright hairline at the top edge, a DARK containing line all
               the way round, and a floor that recedes. The dark ring is the one
               most often left out, and without it the sphere has no boundary —
               it just fades into whatever is behind it, which is what made this
               read as painted plastic. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            boxShadow: [
              // Warm, not white. Every one of these was pure white when the
              // ball was pale glass, and on a molten surface white is not a
              // highlight — it is bleach. It flattened the hottest part of the
              // ramp into paper and was the single biggest reason the first
              // attempt at this looked like a marble instead of a melt.
              `inset 0 2px 3px rgba(${hue.hot},0.75)`,
              `inset 0 0 0 1px rgba(${hue.hot},0.28)`,
              // The containing edge: darker than anything inside, so the
              // silhouette holds against the charcoal behind it.
              `inset 0 0 0 2.5px rgba(${hue.rim},0.55)`,
              // The far side falls off to nearly cold. A molten ball is lit by
              // ITSELF, so the shading is steeper than a lit object's.
              `inset -10px -16px 40px rgba(${hue.rim},0.80)`,
              `inset 0 -34px 52px rgba(${hue.rim},0.62)`,
              `inset 0 14px 26px rgba(${hue.hot},0.09)`,
            ].join(', '),
          }}
        />

        {/* 1b. Fresnel. Glass reflects almost nothing head-on and almost
               everything at a grazing angle, which is why a real sphere has a
               bright band hugging its silhouette and a comparatively dull
               middle. Painting the highlight evenly is the difference between
               "sphere with a gradient" and "glass". The band is pushed right to
               the edge (92%+) because that is where the grazing angles are. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              `radial-gradient(circle at 50% 50%, transparent 88%, rgba(${hue.hot},0.06) 94%, rgba(${hue.hot},0.20) 99%, transparent 100%)`,
          }}
        />

        {/* 1c. Refraction, in the only way a flat element can honestly show it:
               the field BEHIND the ball is bent inward at the rim, so the ring
               just inside the silhouette carries the room's colour — here the
               orange field — rather than the fluid's. Without it the ball reads
               as opaque, because an opaque object is exactly one that shows you
               nothing of what is behind it. Multiply keeps it as tinted glass
               instead of a painted orange ring. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background: [
              // The terminator. This layer used to show the ORANGE FIELD bent
              // through the rim, which was honest when the room behind the ball
              // was orange; the room is charcoal now, so what a real melt shows
              // at its edge is its own cooling crust. Multiply keeps it as a
              // darkening of the fluid rather than a ring painted over it.
              `radial-gradient(circle at 50% 50%, transparent 74%, rgba(${hue.rim},0.55) 93%, rgba(${hue.rim},0.85) 100%)`,
              // Weighted low and right, away from the light.
              `radial-gradient(ellipse 78% 70% at 70% 82%, transparent 52%, rgba(${hue.rim},0.42) 96%)`,
            ].join(', '),
            mixBlendMode: 'multiply',
            opacity: 0.85,
          }}
        />

        {/* 2. The caustic — light focused through the ball onto its own far
               side. Small, bright, low and off-centre; it is what separates a
               transparent sphere from an opaque one with a highlight. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              // Was a white caustic — light focused through a transparent ball
              // onto its own far wall. This one is opaque, so that cue is a lie
              // here; what a melt actually has low and off-centre is a pool
              // where the hot fluid gathers.
              `radial-gradient(ellipse 30% 18% at 62% 82%, rgba(${hue.hot},0.34) 0%, transparent 72%)`,
            mixBlendMode: 'screen',
          }}
        />
        <div
          aria-hidden
          className="orb-motion pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              // Tighter and brighter than a sheen: a specular is a REFLECTION of
              // the light source, so it has an edge. Spread soft and wide, it
              // reads as a matte surface catching light instead of a wet one.
              // Kept white only at its very centre — a molten surface is glossy,
              // and gloss reflects the room's white light even when the body
              // underneath is glowing orange. Wider than the centre it goes
              // straight to the hot colour, or the ball turns pearlescent.
              `radial-gradient(circle at 33% 23%, rgba(255,255,255,0.46) 0%, rgba(${hue.hot},0.44) 5%, rgba(${hue.hot},0.10) 14%, transparent 27%)`,
            // Off the blobs' clocks too: a specular that peaks with the colour
            // underneath it turns the whole ball into one pulsing thing.
            // Same reason as the blobs: duration through a variable, so a
            // phase change retimes the glint instead of teleporting it.
            ['--glint' as string]: scale(tempo.b, 1.17),
            animationName: 'orb-glint',
            animationDuration: 'var(--glint)',
            animationTimingFunction: 'ease-in-out',
            animationIterationCount: 'infinite',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            // A sheen should suggest a wet surface, not repaint it: at 0.30
            // across the top third this was the layer washing the colour out.
            background:
              `radial-gradient(ellipse 52% 30% at 40% 14%, rgba(${hue.hot},0.10) 0%, transparent 72%)`,
          }}
        />

        {/* 4. The back-surface reflection. Light hitting glass reflects TWICE —
               off the front face and again off the inside of the back face — so
               a real ball shows the same light source a second time, dimmer,
               smaller, and on the opposite side. It is the cue that says the
               object has a far wall, i.e. that it is transparent, and leaving
               it out is why a single highlight always reads as a sticker.
               Travels with the glint, half a beat behind. */}
        <div
          aria-hidden
          className="orb-motion pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              `radial-gradient(circle at 71% 76%, rgba(${hue.hot},0.50) 0%, rgba(${hue.hot},0.16) 8%, transparent 20%)`,
            ['--glint' as string]: scale(tempo.b, 1.17),
            animationName: 'orb-glint',
            animationDuration: 'var(--glint)',
            animationTimingFunction: 'ease-in-out',
            animationDelay: '-1.2s',
            animationIterationCount: 'infinite',
            animationDirection: 'reverse',
            opacity: 0.7,
          }}
        />

        {/* 5. The room, seen in the glass. The ball sits on a bright orange
               field, and a reflective sphere shows that field back — a soft
               warm band low on the surface, brightest where the surface faces
               the ground. Without it the sphere is lit by nothing in
               particular, which is the quiet reason it can look pasted on. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              `radial-gradient(ellipse 78% 34% at 50% 96%, rgba(${hue.mid},0.30) 0%, rgba(${hue.mid},0.10) 44%, transparent 72%)`,
            mixBlendMode: 'screen',
          }}
        />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Which voice answers, switchable mid-call.
 *
 * The list comes from the vendor on open, never from a constant in this file: a
 * Fish voice can be cloned this afternoon and an Azure locale added next month.
 * An engine that publishes no list (a self-hosted gateway) returns an empty one,
 * and then this shows a text field instead of pretending there is no choice.
 *
 * Pinning a voice is also what fixed replies arriving in two different voices —
 * see the split in `useCallSession`.
 */
function VoicePicker({
  engineId,
  load,
  limit,
  defaultVoiceId,
}: {
  engineId: string;
  /** Where the list comes from. Defaults to the TTS catalog; a Live call passes
   *  its own, because its voices are the model's, not a synthesiser's. */
  load?: () => Promise<TtsVoice[]>;
  /** How many rows to offer. A fixed, short vendor list wants all of them. */
  limit?: number;
  /** Which voice to pin when none is chosen yet. Without it the first row wins,
   *  which for a fixed list means alphabetical order picks the default — and
   *  the vendor's recommended voice is rarely the alphabetical one. */
  defaultVoiceId?: string;
}) {
  const t = useT();
  const chosen = useUI((s) => s.ttsVoice[engineId]);
  const setTtsVoice = useUI((s) => s.setTtsVoice);
  // Ranked by the INTERFACE language, which is a safe hint here and was not one
  // for the transcriber: this only decides which five voices are shown first,
  // and every other voice stays reachable by id. Being wrong costs a scroll,
  // not a mistranscribed sentence.
  const spokenLocale = useUI((s) => s.language);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let current = true;
    setVoices(null);
    (load ? load() : tauri.voice.ttsVoices(engineId))
      .then((list) => {
        if (!current) return;
        setVoices(list);
        // Pin one immediately if nothing is chosen. Leaving it unset used to mean
        // "let the vendor decide", and Fish decides PER REQUEST — so one reply came
        // back in one voice and the next in another. A voice is always explicit
        // from here on; the user can change it, but not to "unspecified".
        if (!chosen && list.length > 0) {
          const pick =
            list.find((v) => v.id === defaultVoiceId) ?? preferredVoice(list, spokenLocale);
          if (pick) setTtsVoice(engineId, pick.id);
        }
      })
      .catch(() => {
        if (!current) return;
        setVoices([]);
        // The list is how a person picks a voice, and it is also how the app
        // learns the vendor's default. With it gone, pin the default we were
        // given rather than leaving the call with no voice at all: Fish, for
        // one, then chooses a different voice per request and the assistant
        // changes voice between sentences.
        if (!chosen && defaultVoiceId) setTtsVoice(engineId, defaultVoiceId);
      });
    return () => { current = false; };
    // `chosen` is read but deliberately not a dependency: this runs per engine, and
    // re-running it on every voice change would fight the user's own selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineId]);

  if (voices === null) {
    return (
      <span className="flex items-center gap-2 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t('call.voicesLoading')}
      </span>
    );
  }

  // No list to choose from.
  //
  // This used to put an empty field on the call screen with "Couldn't list
  // voices. Paste a voice id" in it. That is a developer's escape hatch
  // wearing the product's clothes: the person is standing in front of a phone
  // call, has no idea what a voice id is, and the one thing that could have
  // told them is the list that just failed. Nobody is going to go hunting for
  // a vendor's identifier to hear a sentence.
  //
  // So: say which voice is being used, or what is missing. Whichever it is,
  // the call still works, and the id field lives on in Settings, where
  // somebody with a cloned voice can go looking for it on purpose.
  if (voices.length === 0) {
    const using = chosen || defaultVoiceId;
    return (
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        {using ? (
          <>
            {t('call.voicesUsingDefault')} <span className="text-text-secondary">{using}</span>
          </>
        ) : (
          t('call.voicesNeedKey')
        )}
      </span>
    );
  }

  const shortlist = shortlistVoices(voices, spokenLocale, chosen, limit);
  const current = voices.find((v) => v.id === chosen);

  return (
    // A themed dropdown, not a native `<select>`: the native one draws its list
    // with the operating system's colours, which on a dark theme came out as dark
    // text on a dark popup — unreadable exactly where the choice is made.
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('call.voice')}
          className="flex items-center gap-2 rounded-full border border-border-default bg-bg-surface/70 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-brand hover:text-text-primary"
        >
          <AudioLines size={13} className="text-brand" />
          {current?.label ?? t('call.voicesLoading')}
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="bottom" className="w-72">
        <DropdownMenuLabel className="text-xs text-text-muted">
          {t('call.voice')} · {voices.length} {t('call.voicesAvailable')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={chosen ?? ''}
          onValueChange={(id) => setTtsVoice(engineId, id)}
        >
          {/* No "vendor default" row. It was the cause of a reply arriving in one
              voice and the next in another: the vendor resolves its default per
              request, so "unspecified" is not a stable choice, it is a lottery. */}
          {shortlist.map((v) => (
            <DropdownMenuRadioItem key={v.id} value={v.id} className="text-sm">
              <span className="truncate">{v.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {voices.length > shortlist.length && (
          <>
            <DropdownMenuSeparator />
            {/* The shortlist is a cut, and saying so is cheaper than a hundred rows
                — the id field below stays the way to reach any of the rest. */}
            <div className="px-2 py-1.5">
              <p className="mb-1.5 text-micro text-text-muted">{t('call.voiceMore')}</p>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typed.trim()) setTtsVoice(engineId, typed.trim());
                }}
                placeholder={t('call.voiceIdPlaceholder')}
                className="h-7 text-xs"
              />
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RoundButton({
  onClick,
  label,
  children,
  tone = 'neutral',
  disabled,
  active,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'danger';
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        // A border on every tone. `bg-bg-elevated` is #252119 on dark, which
        // reads as a button against the surface, and #FFFFFF on light, which
        // reads as nothing against #FFF5EE — so the shape has to be drawn
        // rather than implied by a fill that only contrasts in one theme.
        'flex h-14 w-14 items-center justify-center rounded-full border transition-colors',
        // Themed tokens rather than Tailwind's palette: `--error` is tuned per
        // theme (#C0472A dark, #A03820 light) while `rose-400` is a single
        // value picked to sit on black and washes out on cream.
        tone === 'danger' &&
          'border-border-default bg-bg-elevated text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]',
        tone === 'brand' && 'border-transparent bg-brand text-bg-primary hover:bg-brand-hover',
        tone === 'neutral' && 'border-border-default bg-bg-elevated text-text-secondary hover:bg-bg-hover',
        active && 'text-brand',
        disabled && 'cursor-default opacity-40 hover:bg-bg-elevated',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Which vendor answers, before anything else on the pre-call screen.
 *
 * This replaced an engine toggle. There is one engine now, so a control that
 * asked "which engine" was asking a question with one answer while the question
 * a person actually has — who am I about to talk to, and is it even set up —
 * had no control at all.
 *
 * The list comes from Rust because the same table decides which npm plugin gets
 * installed for the call. A list written here would be free to offer a vendor
 * the agent cannot load, and that failure lands inside a forked job process
 * where nobody sees it.
 */
function ProviderToggle({
  providers,
  effective,
  willEcho,
  onChange,
  t,
}: {
  providers: S2sProviderInfo[];
  /** What will run — the pick, or the fallback the host would resolve to. */
  effective: string | null;
  /** True when that provider has no key, so the far end will only echo. */
  willEcho: boolean;
  onChange: (id: string) => void;
  t: (key: 'call.providerNoKey' | 'call.providerNone') => string;
}) {
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-1 rounded-full border border-border-subtle bg-bg-surface/70 p-1">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => { if (p.id !== effective) onChange(p.id); }}
            aria-pressed={p.id === effective}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
              p.id === effective
                ? 'bg-brand text-on-brand'
                : 'text-text-muted hover:text-text-primary',
            )}
          >
            {p.label}
            {/* Said on the button itself, not only in a tooltip or a log: a
                vendor with no key produces an echo, and "why did it just repeat
                me" is not a question the app should make somebody research. */}
            {!p.connected && (
              <span className={cn('text-micro', p.id === effective ? 'opacity-80' : 'text-text-disabled')}>
                ({t('call.providerNoKey')})
              </span>
            )}
          </button>
        ))}
      </div>
      {willEcho && (
        <p className="max-w-sm text-center text-xs text-text-muted">
          {t('call.providerNone').replace(
            '{provider}',
            providers.find((p) => p.id === effective)?.label ?? '',
          )}
        </p>
      )}
    </div>
  );
}

function EngineLine({
  label,
  name,
  local,
  t,
  onChange,
}: {
  label: string;
  name: string;
  /**
   * Where this engine's audio goes — or `null` when no engine is chosen yet.
   *
   * `null` is not `false`. An unchosen engine printed "leaves device", which is
   * a claim about traffic that has no destination, on the one line of this
   * screen whose whole job is to be trustworthy about exactly that.
   */
  local: boolean | null;
  t: (key: 'call.onDevice' | 'call.leavesDevice' | 'engine.change') => string;
  /** Omitted for an engine with nothing to configure from here. */
  onChange?: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary">{name}</span>
      {/* A border as well as a fill, and a foreground picked per theme rather
          than shared with the base palette. This badge is the one line on the
          pre-call screen that tells the user their voice leaves the machine, and
          at 10px the shared `--warning` gives about 2.9:1 on cream — readable
          only if you already know what it says. A tinted fill with no edge also
          vanishes on a light background; the edge is what keeps it a badge. */}
      {local !== null && (
      <span
        className={cn(
          'flex items-center gap-1 rounded border px-1.5 py-0.5 text-micro font-medium',
          local
            ? 'border-[var(--badge-ok-br)] bg-[var(--badge-ok-bg)] text-[var(--badge-ok-fg)]'
            : 'border-[var(--badge-warn-br)] bg-[var(--badge-warn-bg)] text-[var(--badge-warn-fg)]',
        )}
      >
        {local ? <Laptop size={10} /> : <Cloud size={10} />}
        {local ? t('call.onDevice') : t('call.leavesDevice')}
      </span>
      )}
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          aria-label={t('engine.change')}
          title={t('engine.change')}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-brand"
        >
          <Settings2 size={13} />
        </button>
      )}
    </span>
  );
}

/**
 * The conversation, beside the call rather than behind it.
 *
 * Typed messages do not send themselves — they are handed to the call loop
 * (`onSay`), which is the only thing that takes turns. Sending straight from here
 * would put a second question to the model while the first was still in flight,
 * and the answer spoken aloud would be whichever came back first.
 */
function CallChatPanel({ onClose, onSay }: { onClose: () => void; onSay: (text: string) => void }) {
  const t = useT();
  const messages = useChat((s) => s.messages);
  const status = useChat((s) => s.streamStatus);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the conversation. Without this the panel opens showing the top of a
  // long call with the newest turn off screen.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const submit = () => {
    if (!text.trim()) return;
    onSay(text);
    setText('');
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    // `pt-8` clears the window controls, which are fixed to the top-right corner
    // above everything. Without it this panel's own close button sat directly
    // under the application's close button — two X's in a column, and the wrong
    // one is the one that quits.
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-border-default bg-bg-surface pt-8">
      <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        {/* Close on the LEFT, for the same reason: the top-right corner of the
            window belongs to the window, not to a panel inside it. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('call.chatClose')}
          title={t('call.chatClose')}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={16} />
        </button>
        <span className="text-sm font-medium text-text-primary">{t('call.chat')}</span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            streaming={status === 'streaming' && m.id === lastAssistantId}
          />
        ))}
        <div ref={endRef} />
      </div>

      <div className="border-t border-border-subtle p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('call.chatPlaceholder')}
            rows={1}
            // Its own colour, explicitly. `Textarea` declares none and inherits,
            // which is fine in the chat page and wrong inside this portal: the
            // overlay's ancestry gave typed text the brand orange, so what the
            // user was writing came out looking like a link rather than like
            // their own words. An input that depends on where it is mounted for
            // whether it is readable is a bug waiting for the next portal.
            className="max-h-32 resize-none text-sm text-text-primary placeholder:text-text-muted"
          />
          <Button size="icon" onClick={submit} disabled={!text.trim()} aria-label={t('chat.send')} className="h-8 w-8 shrink-0">
            <ArrowUp size={13} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
