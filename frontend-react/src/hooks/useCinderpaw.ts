/**
 * useCinderpaw — React integration for the Cinderpaw Agent sidecar.
 *
 * Wraps `cinderpaw_send_message` + `cinderpaw://agent-output` events into the same
 * callback interface that useChatStream uses, so useSendMessage can drop it in
 * as a third inference path without changing the streaming logic.
 */

import { useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChat, type ChatMessage, TOOL_CALL_LINGER_MS } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useAgent } from '@/stores/agent';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { t } from '@/lib/i18n';
import { autoTitle } from '@/lib/autoTitle';
import { voiceToPersisted } from '@/lib/messageMapping';
import { splitThinking, stripStreamingToolCalls } from '@/lib/parseThink';
import { tauri, type CinderpawAgentEvent, type PersistedMessage } from '@/lib/tauri';
import {
  ensureCinderpawListener,
  registerCinderpawStream,
  requestCinderpawStop,
  isCinderpawStreaming,
} from '@/lib/cinderpawAgentStream';
import {
  beginLiveSession,
  updateLiveSession,
  pushLiveToolCall,
  completeLiveToolCall,
  endLiveSession,
  getLiveSession,
  getLiveToolStrip,
} from '@/lib/cinderpawLiveSession';
import { extractMainArg } from '@/components/chat/mascot/extractMainArg';
import { emojiForTool } from '@/components/chat/mascot/emojiForTool';
import type { MascotState } from '@/components/chat/mascot/frames';

interface StreamCallbacks {
  onToken:      (chunk: string) => void;
  onDone:       (finalContent?: string, stopped?: boolean) => void;
  onError:      (err: string) => void;
  onStopped:    () => void;
  onTruncated?: (reason: string) => void;
  onToolStart?: (callId: string, tool: string, args: Record<string, unknown>) => void;
  onToolDone?:  (callId: string, tool: string, result: unknown) => void;
  onUsage?:     (promptTokens: number, completionTokens: number) => void;
  /**
   * React-side id of the assistant message that this stream will populate.
   * Threaded into the inflight stream entry so the ask_user flow can attach
   * the question card to the right message (the card is rendered off
   * `message.askUser`, so without this the card never appears).
   */
  chatMessageId: string;
}

interface MascotStateSink {
  setMascotState(state: MascotState): void;
}

/**
 * Coerce a tool result of unknown shape into an ok/error boolean.
 *
 * The sidecar returns `{ ok: boolean, content: string, error?: string }`
 * for registered tools. Defensive: if `result` is missing or doesn't
 * follow that shape, treat it as success (legacy behaviour — older
 * versions of the sidecar returned the raw tool output as `result`).
 */
function isOkResult(result: unknown): boolean {
  if (result && typeof result === 'object' && 'ok' in (result as object)) {
    return Boolean((result as { ok: unknown }).ok);
  }
  return true;
}

export { type MascotStateSink };

/**
 * Join two answer segments with a blank line. Multi-step agent turns emit
 * prose, call a tool, then emit more prose; without joining, only the segment
 * after the LAST tool call survived (the rest was wiped on tool_start).
 */
const joinSegments = (a: string, b: string): string => (a && b ? a + '\n\n' + b : a + b);

/**
 * `JSON.stringify` that cannot throw.
 *
 * A tool result holding a cycle — a node that references its parent, a handle
 * that references its own registry — threw here, inside a stream callback with
 * nothing to catch it: the tool's preview vanished and the rejection went
 * unhandled. A tool that returns an awkward shape should still show its result.
 */
/** One line of untrusted text, trimmed to something a toast can hold. */
function toastText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return `${String(value)} [could not be shown in full]`;
  }
}

export function useCinderpawStream(chatSessionId: string) {
  const send = useCallback(
    async (
      content: string,
      callbacks: StreamCallbacks,
      images?: string[],
      surface?: 'voice' | 'text',
    ) => {
      await ensureCinderpawListener();

      // Parity with `startChatStream`: a fresh send is an implicit interrupt
      // of any stream still in flight for this session. Without this, the
      // previous generation's chunks keep racing the new one into the same
      // chat (stop/retry semantics must match across both paths — audit A2).
      if (isCinderpawStreaming(chatSessionId)) {
        await requestCinderpawStop(chatSessionId);
      }

      let messageId: string;
      try {
        // Controls-panel params (temperature / max tokens) now reach the
        // agent too — previously they only applied to the plain chat tab.
        const { temperature, max_tokens } = useModel.getState().inferParams;
        messageId = await invoke<string>('cinderpaw_send_message', {
          content,
          sessionId: chatSessionId,
          images: images && images.length > 0 ? images : null,
          inferParams: { temperature, max_tokens: max_tokens },
          // Declared per message, not per session: the same conversation is
          // spoken to and typed in alternately, and the format brief has to follow
          // whichever is happening right now.
          surface: surface ?? null,
        });
      } catch (err) {
        callbacks.onError(String(err));
        return;
      }

      registerCinderpawStream(messageId, {
        onChunk: (c) => callbacks.onToken(c),
        onDone: (fc, stopped) => callbacks.onDone(fc, stopped),
        onError: (m) => callbacks.onError(m),
        onStopped: () => callbacks.onStopped(),
        onToolStart: callbacks.onToolStart ? (cid, t, a) => callbacks.onToolStart!(cid, t, a) : undefined,
        onToolDone: callbacks.onToolDone ? (cid, t, r) => callbacks.onToolDone!(cid, t, r) : undefined,
        onUsage: callbacks.onUsage ? (p, c) => callbacks.onUsage!(p, c) : undefined,
        // Ask_user events carry the sidecar's requestId, not a stream
        // messageId — so the stream manager can't tie the question to a
        // specific message on its own. Pass the React-side asstId so the
        // ask_user flow can patch the right message with `askUser` (which
        // is what makes AskUserCard actually appear in the chat list).
        chatMessageId: callbacks.chatMessageId,
        // Lets requestCinderpawStop(sessionId) stop only this session's streams.
        sessionId: chatSessionId,
      });
    },
    [chatSessionId],
  );

  return { send };
}

export function useCinderpawSendMessage(chatSessionId: string, mascotSink?: MascotStateSink) {
  const { send } = useCinderpawStream(chatSessionId);

  return useCallback(
    async (
      content: string,
      images?: string[],
      opts?: {
        voice?: ChatMessage['voice'];
        existingUserId?: string;
        /** `'voice'` when this answer will be spoken aloud — see `cinderpaw_send_message`. */
        surface?: 'voice' | 'text';
      },
    ) => {
      const chat = useChat.getState();

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content,
        ...(images && images.length > 0 ? { images } : {}),
        ...(opts?.voice ? { voice: opts.voice } : {}),
        createdAt: Date.now(),
      };
      const asstMsg = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: '',
        thinkingComplete: true,
        createdAt: Date.now() + 1,
      };
      if (opts?.existingUserId) {
        // Voice flow: the user bubble was added optimistically before
        // transcription. Fill in the transcript instead of duplicating it.
        chat.patchMessage(opts.existingUserId, {
          content,
          voicePending: false,
          ...(images && images.length > 0 ? { images } : {}),
          ...(opts?.voice ? { voice: opts.voice } : {}),
        });
      } else {
        chat.addMessage(userMsg);
      }
      chat.addMessage(asstMsg);
      chat.setStreamStatus('streaming');

      const sessionId = useChat.getState().sessionId;
      const snapshot  = [...useChat.getState().messages];
      const asstId    = asstMsg.id;
      const agentId   = useAgent.getState().current?.id ?? null;
      const isActive  = () => useChat.getState().sessionId === sessionId;

      // Mirror every streaming update keyed by sessionId — even while the
      // user is on another chat/tab — so re-entering this conversation can
      // rehydrate the live state instead of the stale disk snapshot.
      beginLiveSession(sessionId);
      const syncToolStrip = () => {
        if (!isActive()) return;
        const strip = getLiveToolStrip(sessionId);
        if (strip) useChat.setState({ toolCallStream: strip });
      };

      useConversations.getState().markStreaming(sessionId);
      try {
        await useConversations.getState().saveCurrent(autoTitle(useChat.getState().messages), agentId);
      } catch (err) {
        console.error('[cinderpaw] failed initial save to Recent:', err);
      }

      const state = {
        buffer: '',
        answer: '',
        // Prose from segments BEFORE the current one, joined. A multi-step
        // answer (prose → tool → prose → tool → prose) accumulates here so
        // the whole response survives instead of only the last segment.
        committed: '',
        thinkingStartMs: 0,
        thinkingDurationRecorded: false,
        toolCallCount: 0,
        // What the agent wrote in its own scratchpad this turn. Accumulated
        // here rather than read off the bubble strip because that strip holds
        // four entries and is wiped five seconds after the turn ends — it
        // answers "what is it doing", and this has to answer "what did it do".
        scratch: { edits: 0, added: 0, removed: 0 },
      };

      const persistFinal = async () => {
        const persisted: PersistedMessage[] = snapshot.map((m) => ({
          role: m.role,
          content: m.id === asstId ? joinSegments(state.committed, state.answer) : m.content,
          thinking: m.thinking || undefined,
          voice: voiceToPersisted(m.voice),
          // The turn being finalised has its stats in `state`; earlier messages
          // in the snapshot carry their own from when they were live. Without
          // the first half the line vanished on the very save meant to keep it.
          scratch:
            m.id === asstId && state.scratch.edits > 0 ? { ...state.scratch } : m.scratch,
          created_at: m.createdAt,
        }));
        try {
          await tauri.conversations.save(sessionId, autoTitle(snapshot), persisted, agentId);
          await useConversations.getState().refresh();
        } catch (err) {
          console.error('[cinderpaw] failed final save to Recent:', err);
        }
      };

      await send(content, {
        // Pass the React-side asst message id so the ask_user flow can
        // attach the question card to the right message (the card reads
        // off `message.askUser`; without this the card never renders).
        chatMessageId: asstId,
        onToken: (token) => {
          state.buffer += token;
          const split = splitThinking(state.buffer);
          // Suppress tool-call text anywhere in the stream (prose before a
          // mid-message <tool_call> stays visible; the call itself never does).
          const visibleAnswer = stripStreamingToolCalls(split.answer);
          state.answer = visibleAnswer;
          const display = joinSegments(state.committed, visibleAnswer);
          updateLiveSession(sessionId, {
            content: display,
            ...(split.thinking !== null
              ? { thinking: split.thinking, thinkingComplete: split.thinkingComplete }
              : {}),
            agentPhase: 'thinking',
          });
          if (isActive()) {
            const chat = useChat.getState();
            const patch: Partial<ChatMessage> = { content: display };
            if (split.thinking !== null) {
              if (state.thinkingStartMs === 0) state.thinkingStartMs = Date.now();
              patch.thinking = split.thinking;
              patch.thinkingComplete = split.thinkingComplete;
              if (split.thinkingComplete && !state.thinkingDurationRecorded && state.thinkingStartMs > 0) {
                patch.thinkingDurationMs = Date.now() - state.thinkingStartMs;
                state.thinkingDurationRecorded = true;
              }
            }
            chat.updateLastAssistantMessage(patch);
            if (chat.agentPhase !== 'thinking') chat.setAgentPhase('thinking');
          }
        },
        onToolStart: (_callId, tool, args) => {
          state.toolCallCount += 1;
          // Commit the prose emitted before this tool call so it survives the
          // buffer reset; otherwise only the segment after the LAST tool call
          // reached the bubble (the "only the last sentence" bug).
          if (state.answer.trim()) state.committed = joinSegments(state.committed, state.answer);
          state.buffer = '';
          state.answer = '';
          state.thinkingStartMs = 0;
          state.thinkingDurationRecorded = false;
          // The mirror is authoritative for the tool strip — it accumulates
          // even while the user is on another chat, and `syncToolStrip`
          // copies it into the store only when this session is on screen.
          pushLiveToolCall(sessionId, {
            id: crypto.randomUUID(),
            kind: 'tool',
            name: tool,
            emoji: emojiForTool(tool),
            mainArg: extractMainArg(tool, args),
            status: 'running',
            startedAt: Date.now(),
            endedAt: null,
          });
          updateLiveSession(sessionId, {
            content: state.committed,
            thinking: null,
            agentPhase: 'calling',
            agentTool: tool,
          });
          if (isActive()) {
            useChat.getState().clearStreamingContent();
            // Keep prior segments on screen while the tool runs; clearing to ''
            // is what made earlier prose vanish.
            useChat.getState().updateLastAssistantMessage({ content: state.committed });
            useChat.getState().setAgentPhase('calling', tool);
            syncToolStrip();
          }
        },
        onToolDone: (_callId, tool, result) => {
          // Scratchpad telemetry. `write_file` and `edit_file` report the line
          // delta they already had in hand, so this is a read of an existing
          // field, not a second measurement that could disagree with the first.
          const d = (result as { data?: Record<string, unknown> } | null | undefined)?.data;
          if (d?.scratch === true && isOkResult(result)) {
            state.scratch.edits += 1;
            state.scratch.added += typeof d.linesAdded === 'number' ? d.linesAdded : 0;
            state.scratch.removed += typeof d.linesRemoved === 'number' ? d.linesRemoved : 0;
          }
          // Find the most recent running entry with this tool name and
          // flip it to done/error. The mirror keys by id but we pair by
          // (name, status) so out-of-order events still resolve.
          const live = getLiveSession(sessionId);
          const lastRunning = live
            ? [...live.toolCallStream].reverse().find(
                (e) => e.kind === 'tool' && e.name === tool && e.status === 'running',
              )
            : undefined;
          if (lastRunning) {
            const ok = isOkResult(result);
            // #18: carry a capped output preview (and the error text on
            // failure) into the bubble so the user can expand what the
            // tool actually returned.
            const r = result as { content?: unknown; error?: unknown } | null | undefined;
            const rawPreview =
              typeof r?.content === 'string'
                ? r.content
                : result !== undefined && result !== null
                  ? safeStringify(result)
                  : '';
            completeLiveToolCall(sessionId, lastRunning.id, {
              ok,
              preview: rawPreview ? rawPreview.slice(0, 1500) : undefined,
              error: !ok && typeof r?.error === 'string' ? r.error : undefined,
            });
          }
          updateLiveSession(sessionId, { agentPhase: 'processing', agentTool: null });
          if (isActive()) {
            useChat.getState().setAgentPhase('processing');
            syncToolStrip();
          }
          // Fade-out: the mirror prunes finished bubbles only when it's next
          // touched (pull-based), so a completed bubble lingered forever between
          // tool calls / after the last one. Re-sync once the linger window has
          // passed so the now-expired bubble is pruned from the on-screen strip.
          window.setTimeout(() => syncToolStrip(), TOOL_CALL_LINGER_MS + 100);
        },
        onUsage: (promptTokens, completionTokens) => {
          // Real per-completion token counts from the sidecar router. Mirror
          // them so the context ring rehydrates correctly after a tab switch,
          // and push to the store live when this session is on screen.
          updateLiveSession(sessionId, { promptTokens, completionTokens });
          if (isActive()) {
            useChat.getState().setLiveTokens(promptTokens, completionTokens);
          }
        },
        onDone: async (finalContent?: string, stopped = false) => {
          endLiveSession(sessionId);
          if (joinSegments(state.committed, state.answer).trim().length === 0 && finalContent?.trim()) {
            const cleaned = splitThinking(finalContent).answer.trim();
            if (cleaned) {
              state.answer = cleaned;
              if (isActive()) {
                useChat.getState().updateLastAssistantMessage({ content: joinSegments(state.committed, state.answer) });
              }
            }
          }
          if (isActive()) {
            // Attached to the MESSAGE, which persistFinal() writes to disk, so
            // it is still there tomorrow. The bubble strip below is deliberately
            // left ephemeral — it is the "working now" indicator, and this is
            // the record.
            if (state.scratch.edits > 0) {
              useChat.getState().updateLastAssistantMessage({ scratch: { ...state.scratch } });
            }
            useChat.getState().setStreamStatus('done');
            useChat.setState({ lastCompletionStopped: stopped });
            // 5s post-done window before clearing the bubble strip.
            setTimeout(() => useChat.getState().clearToolCallStream(), 5000);
          }
          if (joinSegments(state.committed, state.answer).trim().length > 0) await persistFinal();
          if (state.toolCallCount > 3 && mascotSink) {
            mascotSink.setMascotState('cool');
          }
          useConversations.getState().unmarkStreaming(sessionId);
        },
        onError: (err) => {
          endLiveSession(sessionId);
          if (isActive()) useChat.getState().setStreamStatus('error', err);
          if (mascotSink) mascotSink.setMascotState('error');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onStopped: () => {
          endLiveSession(sessionId);
          if (isActive()) useChat.getState().setStreamStatus('stopped');
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
        onTruncated: (reason) => {
          endLiveSession(sessionId);
          if (isActive()) {
            useChat.getState().updateLastAssistantMessage({ truncated: true, truncatedReason: reason });
            useChat.getState().setStreamStatus('done');
          }
          void persistFinal().finally(() => {
            useConversations.getState().unmarkStreaming(sessionId);
          });
        },
      }, images, opts?.surface);
    },
    [send, mascotSink],
  );
}

export async function checkCinderpawAgentReady(): Promise<boolean> {
  try {
    return await invoke<boolean>('cinderpaw_agent_status');
  } catch {
    return false;
  }
}

export function useCinderpawGlobal() {
  const setReady      = useCinderpawStore((s) => s.setReady);
  const setModelError = useCinderpawStore((s) => s.setModelError);
  const setOffline    = useCinderpawStore((s) => s.setOffline);
  const fetchConfig   = useCinderpawStore((s) => s.fetchModelConfig);

  useEffect(() => {
    let unlistenReady:  (() => void) | null = null;
    let unlistenExit:   (() => void) | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenRevert: (() => void) | null = null;

    const setup = async () => {
      unlistenReady = await listen('cinderpaw://agent-ready', () => {
        setReady(true);
        void fetchConfig();
      });

      // The event fires once, and only reaches whoever is already listening.
      // The sidecar announces itself about eleven seconds in; a cold webview
      // can still be mounting then, and the announcement goes out to nobody —
      // which left "Cinderpaw is waking up" on screen for the whole session,
      // waiting for a second occurrence that never comes.
      //
      // Asked AFTER the listener is attached, deliberately: an announcement
      // that lands between the two is caught by the listener rather than
      // falling into the gap the other order would open.
      try {
        if (await tauri.raw.agentIsReady()) {
          setReady(true);
          void fetchConfig();
        }
      } catch {
        // An older host without the command. The event path still works.
      }

      // #11: the Rust supervisor emits this when the sidecar dies. While
      // `restarting` is true it will respawn with backoff and agent-ready
      // will clear the banner; when false, the supervisor gave up.
      unlistenExit = await listen<{
        code: number | null;
        restarting: boolean;
        error?: string | null;
      }>(
        'cinderpaw://agent-exit',
        (event) => {
          const reason = event.payload.error?.trim() || null;
          setOffline(true, event.payload.restarting, reason);
          if (!event.payload.restarting) {
            // The reason comes from Rust, which is the only side that knows
            // WHICH failure this was: the sidecar was never found, or it was
            // found and died six times. The hardcoded sentence that used to
            // live here said "crashed repeatedly" for both, which is a
            // confident wrong answer in the case the process never started.
            useNotifications.getState().push(
              'error',
              'Cinderpaw Agent stopped',
              reason ??
                'Agent mode stopped and automatic restarts were suspended. ' +
                  'Restart the app to bring Agent mode back.',
            );
          }
        },
      );

      // Faza 3 watchdog: the Rust supervisor auto-reverted a live-applied
      // code patch that was crashing the agent.
      unlistenRevert = await listen<{ patchId: string }>(
        'cinderpaw://rsi-patch-reverted',
        (event) => {
          useNotifications.getState().push(
            'info',
            'Change rolled back',
            `Cinderpaw undid a self-modification that was causing problems (${event.payload.patchId}).`,
          );
        },
      );

      unlistenOutput = await listen<{ data: string }>('cinderpaw://agent-output', (event) => {
        let parsed: CinderpawAgentEvent;
        try {
          parsed = JSON.parse(event.payload.data) as CinderpawAgentEvent;
        } catch {
          return;
        }

        if (parsed.type === 'model_set') {
          void fetchConfig();
        } else if (parsed.type === 'model_routed') {
          // Only the fallback is worth interrupting for. A successful route
          // is the normal case and must not produce a toast per turn — but
          // a fallback changes which model answered, so it gets said out
          // loud, with the real cause as the "why" underneath.
          if (parsed.reason === 'fallback') {
            useNotifications
              .getState()
              .push('info', t('chat.routed.fallback'), parsed.detail);
          }
        } else if (parsed.type === 'model_error') {
          setModelError(parsed.message);
        } else if (parsed.type === 'cron_fired') {
          // X3: scheduled-job results were previously dropped on the floor.
          // Capped. Both strings are model output — a cron job's answer and the
          // job's own name — so their length is not ours to trust, and a toast
          // rendering a few thousand lines covers the app. (They are rendered as
          // React text, never as HTML, so this is about size, not script.)
          useNotifications.getState().push(
            'success',
            `Scheduled task: ${toastText(parsed.jobName, 80)}`,
            toastText(parsed.content, 2000),
          );
        } else if (parsed.type === 'cron_error') {
          useNotifications.getState().push(
            'error',
            `Scheduled task failed: ${toastText(parsed.jobName, 80)}`,
            toastText(parsed.message, 2000),
          );
        }
      });

      void fetchConfig();
    };

    void setup();

    return () => {
      unlistenReady?.();
      unlistenExit?.();
      unlistenOutput?.();
      unlistenRevert?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
