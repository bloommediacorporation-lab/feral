import { useEffect, useRef, useState, forwardRef, useImperativeHandle, type ClipboardEvent, type KeyboardEvent } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { ArrowUp, Square, Mic, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AttachedFileChip, type AttachedFile } from './AttachedFileChip';
import { FileAttachButton } from './FileAttachButton';
import { VoicePreview } from './VoicePreview';
import { VoiceProviderCard } from './VoiceProviderCard';
import { VoiceEngineCard } from './VoiceEngineCard';
import { CallOverlay } from './CallOverlay';
import { ModelPill } from './ModelPill';
import { ContextRing } from './ContextRing';
import { MascotPerch } from './mascot/MascotPerch';
import { useMascotState } from './mascot/useMascotState';
import { useModel } from '@/stores/model';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useSendMessage, saveVoiceBlobToDisk, transcribeVoiceBlob, buildUserContent } from '@/hooks/useSendMessage';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';
import { useCallSession } from '@/hooks/useCallSession';
import { useLiveCallSession } from '@/hooks/useLiveCallSession';
import { useLiveKitCallSession } from '@/hooks/useLiveKitCallSession';
import { attachmentFromPath, attachmentsFromClipboard } from '@/lib/attachments';
import { decodeToPcm16k, computePeaks } from '@/lib/audio';
import { ensureWhisperModel } from '@/lib/voiceModel';
import { stopActiveStream } from '@/lib/streamControl';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface ChatInputHandle {
  setText: (text: string) => void;
  focus: () => void;
}

export interface ChatInputProps {
  isEmpty?: boolean;
  /**
   * When provided, overrides the default useSendMessage routing.
   * Used by the Agents tab to route through the Cinderpaw Agent sidecar.
   * `images` carries attachment data URLs for vision-capable models.
   */
  sendFn?: (
    text: string,
    images?: string[],
    opts?: {
      voice?: ChatMessage['voice'];
      existingUserId?: string;
      /** `'voice'` when the answer will be spoken aloud — see `cinderpaw_send_message`. */
      surface?: 'voice' | 'text';
    },
  ) => Promise<void>;
  /**
   * When true, the input is always enabled regardless of whether a local
   * model or cloud key is active. Used by the Agents tab (Cinderpaw Agent
   * provides its own Ollama-backed inference).
   */
  alwaysEnabled?: boolean;
}

// Mobile UX (deferred): swap to Enter=newline + explicit send button.
export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
function ChatInput({ isEmpty, sendFn, alwaysEnabled }, ref) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const status = useChat((s) => s.streamStatus);
  const inputMode    = useUI((s) => s.inputMode);
  const setInputMode = useUI((s) => s.setInputMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage();
  const t = useT();
  const rec = useVoiceRecorder();
  const [voicePeaks, setVoicePeaks] = useState<number[]>([]);
  const whisperModel = useUI((s) => s.whisperModel);
  const sttProvider = useUI((s) => s.sttProvider);
  const [providerCardOpen, setProviderCardOpen] = useState(false);
  // Long-press detection on the mic: a held press opens the provider card; a
  // normal tap records. `heldRef` suppresses the click that follows a long press.
  const micHoldTimer = useRef<number | null>(null);
  const micHeldRef = useRef(false);

  // A call turn is routed exactly like a typed or recorded one: through the
  // Cinderpaw Agent sidecar in agent mode, the chat pipeline otherwise. Without this
  // the call would hit the (unloaded) local model in agent mode — the same bug
  // the voice path already had.
  const pipelineCall = useCallSession(async (text: string) => {
    // `surface: 'voice'` is what tells the agent this answer gets spoken. Without
    // it a call received the desktop's full markdown answer read out loud.
    if (sendFn) await sendFn(text, undefined, { surface: 'voice' });
    else await send(text, [], { surface: 'voice' });
  });
  // Both loops are mounted, and only one is ever running: an unopened call is a
  // handful of refs. Choosing the hook at call time instead would mean calling a
  // hook conditionally, which React does not allow.
  //
  // They each own a speech player, and both players listen to the same
  // `cinderpaw://tts-chunk` event for the same session — but a player only schedules
  // audio between `beginSpeech` and its stop, and only the loop taking the call
  // ever calls that. The idle one drops every chunk, which is the same guard that
  // already keeps a straggler from an interrupted utterance out.
  const liveCall = useLiveCallSession();
  const liveKitCall = useLiveKitCallSession();
  const callEngine = useUI((s) => s.callEngine);
  // Three engines, one overlay. LiveKit is the only one offered now; the other
  // two are retired rather than deleted and still run if something selects
  // them, which is what keeps the rollback a config change instead of a revert.
  // See `RETIRED_CALL_ENGINES` — a machine that had picked one is moved over on
  // rehydrate, so this branch resolves to LiveKit everywhere in practice.
  const call =
    callEngine === 'livekit' ? liveKitCall : callEngine === 'live' ? liveCall : pipelineCall;
  const ttsProvider = useUI((s) => s.ttsProvider);
  const [engineCardOpen, setEngineCardOpen] = useState(false);

  /**
   * Two first-use choices gate a call, and both are asked before the microphone
   * opens rather than after: which engine transcribes you (existing card), and
   * which one answers you (the voice card). Order matters only in that neither
   * may be skipped — a call that cannot hear or cannot speak wastes the words
   * someone already said.
   */
  const onCallClick = () => {
    // Neither question applies to a speech-to-speech call: it has no transcriber
    // and no synthesiser to choose. Asking anyway would gate it behind two
    // settings it never reads.
    // A realtime vendor has no transcriber and no synthesiser to choose, so
    // asking would gate it behind two settings it never reads. The pipeline
    // does read them — and picking the engine that speaks is not a thing to
    // guess at, because the choice includes whether the audio leaves the
    // machine.
    const pipelineCallChosen =
      callEngine === 'livekit' && useUI.getState().s2sProvider === 'pipeline';
    if ((callEngine === 'live' || callEngine === 'livekit') && !pipelineCallChosen) call.open();
    else if (sttProvider === null) setProviderCardOpen(true);
    else if (ttsProvider === null) setEngineCardOpen(true);
    else call.open();
  };

  // When a recording finishes, compute peaks for the preview and warm the model.
  useEffect(() => {
    if (rec.state === 'preview' && rec.blob) {
      void decodeToPcm16k(rec.blob)
        .then((pcm) => {
          console.log('[voice] decoded for preview', { pcmLength: pcm.length });
          setVoicePeaks(computePeaks(pcm));
        })
        .catch((err) => console.error('[voice] decodeToPcm16k FAILED (preview)', err));
      // Only the local backend needs the 466 MB whisper model on disk; a cloud
      // user should never trigger that download.
      if (sttProvider === 'local') void ensureWhisperModel(whisperModel);
    }
  }, [rec.state, rec.blob, whisperModel, sttProvider]);

  const onMic = async () => {
    if (rec.state === 'recording') { rec.stop(); return; }
    // The RETURNED failure, not `rec.error`. Reading the state here read this
    // render's closure, which `start()` has not updated yet — so a first
    // refusal said nothing at all and the microphone button just went back to
    // idle. Being told nothing is the worst possible answer to "I pressed the
    // microphone and pressed Deny by accident".
    const failure = await rec.start();
    if (failure === 'denied') useNotifications.getState().push('error', t('voice.permissionDenied'));
    if (failure === 'unsupported') useNotifications.getState().push('error', t('voice.unsupported'));
  };

  // Press-and-hold the mic to (re)open the provider chooser; a normal tap
  // records. Holding is disabled while recording so "tap to stop" still works.
  const onMicPointerDown = () => {
    if (rec.state === 'recording') return;
    micHeldRef.current = false;
    micHoldTimer.current = window.setTimeout(() => {
      micHeldRef.current = true;
      setProviderCardOpen(true);
    }, 500);
  };
  const clearMicHold = () => {
    if (micHoldTimer.current !== null) {
      clearTimeout(micHoldTimer.current);
      micHoldTimer.current = null;
    }
  };
  // Also on unmount. Holding the mic button and then navigating away left the
  // 500 ms timer armed against a component that no longer exists, which React
  // reports as a state update on an unmounted component — and the provider card
  // it opens would have appeared over whatever the user moved on to.
  useEffect(() => clearMicHold, []);
  const onMicClick = () => {
    if (micHeldRef.current) { micHeldRef.current = false; return; } // long-press handled it
    if (sttProvider === null) { setProviderCardOpen(true); return; } // force first-use choice
    void onMic();
  };

  useImperativeHandle(ref, () => ({
    setText: (t: string) => {
      setText(t);
      setTimeout(() => taRef.current?.focus(), 0);
    },
    focus: () => taRef.current?.focus(),
  }));

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = (files: AttachedFile[]) =>
    setAttachedFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      return [...prev, ...files.filter((f) => !existing.has(f.path))];
    });

  // Drag & drop: Tauri intercepts native file drops (the webview never sees
  // HTML5 drop events for OS files) and emits drag-drop events with paths.
  useEffect(() => {
    const webview = getCurrentWebview();
    const unlistenPromise = webview.onDragDropEvent((event) => {
      if (event.payload.type === 'over') {
        setDragOver(true);
      } else if (event.payload.type === 'drop') {
        setDragOver(false);
        void Promise.all(event.payload.paths.map(attachmentFromPath)).then(addFiles);
      } else {
        setDragOver(false);
      }
    });
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  // Ctrl+V / ⌘V: attach pasted screenshots and copied files. Keep text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !Array.from(items).some((i) => i.kind === 'file')) return;
    // Don't preventDefault — text+image paste should keep the text in the textarea
    // while also attaching the image. Preventing drops the text.
    void attachmentsFromClipboard(e.clipboardData).then(addFiles);
  };

  const isStreaming = status === 'streaming';
  const agentPhase = useChat((s) => s.agentPhase);
  const mascotState = useMascotState({
    streamStatus: status,
    agentPhase,
    isUserTyping: text.trim().length > 0,
  });
  /**
   * No local model loaded and no cloud key configured.
   *
   * This used to disable the composer outright (and ChatPage replaced the
   * whole screen with a "No model selected" card), so the first thing a new
   * user typed was refused by a dead text box that told them to go
   * configure something. The composer now stays live and `trySend` answers
   * the message instead — see `noModelReply`.
   */
  const noModel = !alwaysEnabled && !loaded && !cloudModel;
  /**
   * Answer a message when there is no model to answer it with.
   *
   * This reply is written by the product, not generated — you cannot ask a
   * model to explain that there is no model. It is deliberately phrased as
   * Cinderpaw speaking, because from the user's side that is what happened:
   * they asked for something and got an answer plus the two real ways
   * forward, instead of a disabled box pointing at Settings.
   */
  const noModelReply = (asked: string | null) => {
    const now = Date.now();
    // `null` means the user's turn is already on screen (the voice path adds
    // its bubble optimistically before transcription finishes).
    if (asked !== null) {
      useChat.getState().addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: asked,
        createdAt: now,
      });
    }
    useChat.getState().addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: t('chat.noModel.reply'),
      createdAt: now + 1,
      completedAt: now + 1,
      actions: [
        { label: t('chat.noModel.download'), route: '/models' },
        { label: t('chat.noModel.addKey'), route: '/settings' },
      ],
    });
  };
  // Kept as a name because several controls read it; nothing sets it from
  // model state any more. Sending is gated by `noModel` in trySend.
  const disabled = false;

  const trySend = async () => {
    // Voice path: a recorded preview is pending — transcribe + send it instead
    // of the (empty) textarea content.
    if (rec.state === 'preview' && rec.blob) {
      if (isStreaming || disabled) return;
      const { blob, durationMs } = rec;
      const peaks = voicePeaks;
      rec.reset();
      setVoicePeaks([]);
      const userId = crypto.randomUUID();
      try {
        // Optimistic bubble: persist the blob (fast) and show the playable
        // voice message instantly, then transcribe in the background. The user
        // no longer waits seconds for whisper before their own message appears.
        const audioPath = await saveVoiceBlobToDisk(blob);
        useChat.getState().addMessage({
          id: userId,
          role: 'user',
          content: '',
          voice: { audioPath, durationMs, transcript: '', peaks },
          voicePending: true,
          createdAt: Date.now(),
        });
        const transcript = await transcribeVoiceBlob(blob, audioPath);
        const body = transcript || '(unintelligible)';
        const voice = { audioPath, durationMs, transcript, peaks };
        // Route the transcript exactly like a typed message: through the Cinderpaw
        // Agent sidecar in agent mode (sendFn), or the local/cloud chat
        // pipeline otherwise. `existingUserId` fills in the optimistic bubble
        // instead of adding a duplicate. Previously voice always used the chat
        // pipeline, so in agent mode it hit the (unloaded) local model → "no
        // model loaded" while the agent's own model sat idle.
        if (noModel) {
          // The recording is transcribed and kept — whisper is local and had
          // nothing to do with the missing chat model — but there is nobody
          // to answer it, so the same reply the typed path gives lands here.
          // Dropping it silently would be the worse dead end: the user speaks
          // and nothing at all happens.
          useChat.getState().patchMessage(userId, { voice, voicePending: false });
          noModelReply(null);
        } else if (sendFn) {
          await sendFn(body, undefined, { voice, existingUserId: userId });
        } else {
          await send(body, [], { voice, existingUserId: userId });
        }
      } catch (err) {
        console.error('[voice] sendVoice FAILED', err);
        // Drop the optimistic bubble — transcription failed before any reply.
        useChat.getState().removeMessage(userId);
        // Tauri's invoke rejects with the raw error *string*, not an Error
        // object, so read both shapes before matching the sentinels.
        const code = err instanceof Error ? err.message : String(err);
        if (code === 'model-missing') useNotifications.getState().push('info', t('voice.modelDownloading'));
        else if (code === 'voice-unavailable') useNotifications.getState().push('error', t('voice.unsupported'));
        else if (code === 'stt-no-key') setProviderCardOpen(true); // cloud chosen but key missing
        else if (code === 'stt-cloud-failed') useNotifications.getState().push('error', t('voice.cloudFailed'));
        else useNotifications.getState().push('error', t('voice.emptyTranscript'));
      }
      return;
    }
    if ((!text.trim() && attachedFiles.length === 0) || isStreaming || disabled) return;
    if (noModel) {
      noModelReply(text);
      setText('');
      setAttachedFiles([]);
      return;
    }
    const content = text;
    const files = attachedFiles;
    // Cleared optimistically, because waiting for the whole turn before the
    // box empties feels broken. That makes what someone typed live nowhere but
    // in these two consts until a bubble carries it — so if the send throws
    // before that bubble exists, the message is simply gone, and until now the
    // rejection was unhandled on top of it: an empty composer and silence.
    const before = useChat.getState().messages.length;
    setText('');
    setAttachedFiles([]);
    try {
      if (sendFn) {
        // Agent path: inline text attachments into the content (same as the
        // chat path) and hand image data URLs over separately so the sidecar
        // can pass real pixels to vision-capable models.
        const images = files
          .filter((f) => f.kind === 'image' && f.dataUrl)
          .map((f) => f.dataUrl!);
        await sendFn(buildUserContent(content, files), images.length > 0 ? images : undefined);
      } else {
        await send(content, files);
      }
    } catch (err) {
      // Put it back only if nothing made it onto the transcript. Once a user
      // bubble exists the words are safe there, and restoring the draft as
      // well would show them twice.
      if (useChat.getState().messages.length === before) {
        setText(content);
        setAttachedFiles(files);
      }
      useNotifications.getState().push(
        'error',
        'Message not sent',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
  };

  const removeFile = (path: string) =>
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path));


  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn(
        isEmpty
          ? 'px-4 py-3 max-w-2xl mx-auto w-full'
          : 'px-4 py-3',
      )}>
        <div
          className={cn(
            'relative rounded-2xl border bg-[var(--surface-typing)] focus-within:border-brand transition-colors',
            // Same material as the rail and the popovers. Without these two it
            // was the only piece of chrome in the app that was merely tinted:
            // a flat rectangle sitting beside a sidebar made of glass.
            'liquid-glass liquid-glass-rim',
            dragOver ? 'border-brand border-dashed' : 'border-border-default',
          )}
        >
          {dragOver && (
            <div className="absolute inset-0 z-10 rounded-2xl bg-brand/10 backdrop-blur-sm border-2 border-dashed border-brand flex items-center justify-center pointer-events-none">
              <span className="text-sm font-medium text-brand">Drop to attach</span>
            </div>
          )}
          {/* Always. The perch is not decoration: it walks the composer's edge
              and carries the tool-call stack, so it is how a person sees WHAT
              is running. Hiding it on Home removed a working feature to fix a
              spacing complaint — the fix was room above the composer, which the
              greeting now leaves. */}
          <MascotPerch baseState={mascotState} />
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pt-2">
              {attachedFiles.map((f) => (
                <AttachedFileChip
                  key={f.path}
                  file={f}
                  onRemove={() => removeFile(f.path)}
                />
              ))}
            </div>
          )}
          {rec.state === 'preview' && rec.blob && (
            <VoicePreview
              blob={rec.blob}
              durationMs={rec.durationMs}
              peaks={voicePeaks}
              onDelete={() => { rec.reset(); setVoicePeaks([]); }}
              onReRecord={() => {
                rec.reset();
                setVoicePeaks([]);
                // Same reason as the microphone button: a refusal here was
                // silent too, and this one happens after the person has already
                // recorded something once.
                void rec.start().then((failure) => {
                  if (failure === 'denied') useNotifications.getState().push('error', t('voice.permissionDenied'));
                  if (failure === 'unsupported') useNotifications.getState().push('error', t('voice.unsupported'));
                });
              }}
            />
          )}
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              alwaysEnabled ? t('chat.placeholder.agent') : t('chat.placeholder')
            }
            disabled={disabled}
            rows={1}
            // Roomier on Home, where the field IS the screen and the reference
            // it is measured against gives the question air. In a running
            // conversation the transcript is the subject, so it stays compact.
            // Measured against assistant-ui rather than guessed: a comfortable
            // single row (min-h-11) that grows, not a tall empty box with the
            // placeholder stranded at the top of it.
            className={cn(
              'resize-none border-0 bg-transparent focus-visible:ring-0 max-h-[200px] px-4 pt-3 text-base min-h-11 thin-scrollbar',
            )}
          />
          {/* The hint answers a question you only have once you are typing, so
              it fades in when there is something to newline. Kept in the layout
              at zero opacity rather than unmounted: appearing would otherwise
              push the composer up under the cursor on the first keystroke. */}
          <div
            className={cn(
              'px-4 pb-1 text-right transition-opacity duration-150',
              text.length > 0 ? 'opacity-100' : 'opacity-0',
            )}
            aria-hidden={text.length === 0}
          >
            <span className="text-2xs text-text-muted select-none">Shift+Enter for newline</span>
          </div>
          <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
            <div className="flex items-center gap-1">
              <ModelPill />
              <FileAttachButton onFilesSelected={addFiles} />
              {!isStreaming && (
                <button
                  type="button"
                  onClick={onMicClick}
                  onPointerDown={onMicPointerDown}
                  onPointerUp={clearMicHold}
                  onPointerLeave={clearMicHold}
                  aria-label={rec.state === 'recording' ? 'Stop recording' : 'Record voice message (hold to choose provider)'}
                  className={cn('p-1.5 rounded hover:bg-bg-hover', rec.state === 'recording' ? 'text-error animate-pulse' : 'text-text-muted')}
                >
                  {rec.state === 'recording' ? <Square size={16} /> : <Mic size={16} />}
                </button>
              )}
              {/* The tools checklist and the reasoning-mode picker used to sit
                  here. Both asked the person to configure something the app
                  already decides better than they can: reasoning is inferred
                  from the model, and in agent mode the tool list comes from the
                  agent, not from these checkboxes. Two controls that were only
                  ever correct at their defaults. */}
            </div>
            <div className="flex items-center gap-2">
              {/* Live context-usage ring, left of the mode toggle */}
              <ContextRing />
              {/* Chat / Agent mode toggle */}
              <div className="flex rounded-lg border border-border-default bg-bg-elevated h-7 overflow-hidden shrink-0">
                <button
                  type="button"
                  onClick={() => setInputMode('agent')}
                  aria-label="Switch to Agent mode"
                  aria-pressed={inputMode === 'agent'}
                  className={cn(
                    'px-2.5 text-2xs font-medium transition-colors',
                    inputMode === 'agent'
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  Agent
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('chat')}
                  aria-label="Switch to Chat mode"
                  aria-pressed={inputMode === 'chat'}
                  className={cn(
                    'px-2.5 text-2xs font-medium transition-colors',
                    inputMode === 'chat'
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  Chat
                </button>
              </div>
              {!isStreaming && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onCallClick}
                  disabled={disabled}
                  aria-label={t('call.aria')}
                  title={t('call.title')}
                  className="h-7 w-7 text-text-muted hover:text-brand"
                >
                  <Phone size={13} />
                </Button>
              )}
              {isStreaming ? (
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => void stopActiveStream(useChat.getState().sessionId)}
                  aria-label="Stop"
                  className="h-7 w-7"
                >
                  <Square size={12} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void trySend()}
                  disabled={(!text.trim() && attachedFiles.length === 0 && rec.state !== 'preview') || disabled}
                  aria-label="Send"
                  className="h-7 w-7"
                >
                  <ArrowUp size={12} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      <VoiceProviderCard open={providerCardOpen} onOpenChange={setProviderCardOpen} />
      {/* Picking a voice flows straight into the call it was blocking. */}
      <VoiceEngineCard
        open={engineCardOpen}
        onOpenChange={setEngineCardOpen}
        onChosen={call.open}
      />
      <CallOverlay
        phase={call.phase}
        // Only the LiveKit engine ever reports a stage; the retired two share the
        // shape and pass none, so this needs no branch on the engine.
        stage={call.stage}
        heard={call.heard}
        level={call.level}
        notice={call.notice}
        onAnswer={() => void call.begin()}
        onHangUp={call.hangUp}
        onInterrupt={call.interrupt}
        // Both modes can be typed into now — the pipeline hands the text to its
        // turn loop, the Live session sends it on its own `clientContent`
        // channel. `call` is whichever hook is driving this overlay.
        onSay={call.say}
        onChangeEngine={() => setEngineCardOpen(true)}
        onChangeStt={() => setProviderCardOpen(true)}
      />
    </TooltipProvider>
  );
});
