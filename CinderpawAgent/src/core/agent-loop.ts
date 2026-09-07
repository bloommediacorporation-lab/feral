/**
 * Agent loop — the core reasoning cycle.
 *
 *   build prompt → inference (via router) → parse tool calls
 *     → if tool calls: execute each through the sandboxed registry, feed
 *       results back, loop
 *     → else: final answer, persist, done
 *
 * Constraints honored here:
 *   - every LLM call goes through the InferenceRouter (never a provider direct)
 *   - every tool call goes through the ToolRegistry (the sandbox choke point)
 *   - all errors are caught and surfaced as structured events, never crashes
 *   - budget exhaustion triggers compression or a clean stop, per config
 */

import { createHash } from "node:crypto";
import { stripThinking } from "./strip-thinking.ts";
import type { InferenceRouter } from "../egress/inference-router.ts";
import { stripToolsFromSystemPrompt } from "../egress/inference-providers.ts";
import { isBackgroundSession } from "../egress/inference-router.ts";
import { log } from "../runtime-meta.ts";
import {
  BudgetExhaustedError,
  InferenceError,
} from "../egress/inference-router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { cfgInt, readEnv } from "../config.ts";
import { SESSION_RESET_MARK, type EpisodicMemory } from "../memory/episodic.ts";
import { memoryScope } from "../memory/semantic.ts";
import type { RecallResult } from "../memory/recall.ts";

/**
 * Either the legacy synchronous `RecallEngine` or the async `FractalMemory`
 * facade — both answer `recall()` with a `RecallResult`. The loop `await`s
 * either (awaiting a sync value is a no-op), so the semantic path can do its
 * single-query embedding without changing this call site again.
 *
 * `noteWrite` is optional and only the fractal facade implements it: the
 * organism needs a per-memory-write pulse so a single +1 leaf on top of
 * 2700 isn't invisible until the next 1.2× rebuild threshold. The legacy
 * engine (and any test double) can omit it.
 */
export interface Recaller {
  recall(query: string, sessionId: string): RecallResult | Promise<RecallResult>;
  noteWrite?(leaf: { id: number; sessionId: string; ts: number }): void;
}
import type { MemoryExtractor } from "../memory/extractor.ts";
import { WorkingMemory } from "../memory/working.ts";
import { countTokens } from "./tokenizer.ts";
import { claimedPath, unsourcedWarning, withOpenFirst } from "./unsourced.ts";
import { daemonNotice, daemonPrompt, unkeptWriteClaims } from "./daemon.ts";
import { stripPrivate, redactSecrets } from "../memory/privacy.ts";
import { isRestrictedSession, markSessionRestricted } from "./session-visibility.ts";
import type { BrainStack } from "../brain/brain-stack.ts";
import type { ModelTarget } from "../types.ts";
import type {
  AnthropicToolDef,
  ChatMessage,
  OpenAIToolDef,
  InferenceConfig,
  InferenceResponse,
  OutboundEvent,
  ParsedResponse,
  ParsedToolCall,
  SkillMeta,
} from "../types.ts";
import type { HookRegistry } from "./hook-registry.ts";
import type { SoulConfig } from "./soul-loader.ts";
import type { UserConfig } from "./user-loader.ts";
import { buildUserPromptBlock } from "./user-loader.ts";
import {
  CINDERPAW_AGENT_BASE_PROMPT,
} from "./cinderpaw-prompt.ts";
import { buildToolCallGrammar, TOOL_CALL_TRIGGERS } from "./tool-grammar.ts";
import { createToolDrawerTools } from "../tools/builtin/tool-drawer.ts";
import { NOTEBOOK_TOOL_NAME } from "../tools/builtin/notebook.ts";
import { buildNotebookSection, WORKER_BRIEF } from "../rlm/prompt.ts";
import { toIdentifier } from "../rlm/repl.ts";
import { isConnectorTool, isCoreTool, isOwnerOnlyTool } from "../tools/tiers.ts";
import { selectTools } from "../tools/tool-intent.ts";
// Vendored from OpenClaw (MIT) — see src/vendor/tool-call-repair/README.md.
import {
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
} from "../vendor/tool-call-repair/payload.ts";

export interface AgentLoopConfig {
  /** Soft token cap passed to each completion. */
  maxTokensPerCall: number;
  /** Behavior when a budget is exhausted (mirrors InferenceConfig). */
  onBudgetExhausted: InferenceConfig["tokenBudget"]["onExhausted"];
  /**
   * Grammar-constrained tool calls. When true, every main-loop completion
   * carries a GBNF grammar (lazy, triggered on a tool-call fence) so the local
   * engine can only emit a valid tool-call JSON once the model opens one —
   * prose answers stay unconstrained. Off by default: it requires the bundled
   * llama.cpp engine (the grammar field is a no-op on other backends) and the
   * text parser remains the proven fallback. Enable with CINDERPAW_TOOL_GRAMMAR=true.
   */
  useToolGrammar: boolean;
  /**
   * P2 (memory leaks): cap on simultaneously-retained session states.
   * When the cap is reached, the LRU session is evicted on the next
   * access. Default 64 — generous for normal use (most users have <5
   * active sessions), strict enough that a runaway or abusive client
   * cannot exhaust RAM by creating millions of unique sessionIds.
   * Tunable via constructor; tests and high-fanout deployments can
   * raise it, low-memory deployments can lower it.
   */
  maxRetainedSessions: number;
  /**
   * P2 (memory leaks): session WorkingMemory entries that haven't been
   * accessed in this many ms are evicted on the next access to the
   * session map. Default 30 minutes — long enough that a user who
   * walks away and comes back doesn't lose their conversation, short
   * enough that forgotten sessions don't accumulate. Combined with the
   * LRU cap, this is belt-and-suspenders: LRU bounds the worst case
   * (always at most `maxRetainedSessions`), TTL bounds the typical
   * case (idle sessions cleared within `sessionIdleEvictMs`).
   */
  sessionIdleEvictMs: number;
}

/**
 * How many past episodic events a cold session replays into its fresh
 * WorkingMemory (see `#memoryFor`). Bounded so a long-running session can't
 * blow the context budget on rehydration alone — the compactor handles the
 * rest, and `recall` reaches anything older on demand.
 */
const REHYDRATE_TURNS = 40;

/**
 * Whether a session's transcript should be replayed when it comes back cold.
 *
 * True for real conversations (desktop/TUI chat, connector surfaces). False for
 * machine sessions, which reuse a stable synthetic sessionId across runs and are
 * designed to start fresh: the RSI/dream/extractor family (`isBackgroundSession`)
 * plus cron jobs, whose `cron:${jobId}` id is stable per job but whose runs are
 * independent of each other.
 */
function isReplayableSession(sessionId: string): boolean {
  return !isBackgroundSession(sessionId) && !sessionId.startsWith("cron:");
}

/**
 * Whether the runtime looks memory up for the agent each turn.
 *
 * ON by default, and that is the point: the opposite default is what shipped
 * for months. Memory was written on every turn and read only when the model
 * chose to call the `recall` tool, which on a coding run it never does — so a
 * fresh install got a memory system that accumulated and never once answered.
 * A capability that only works when someone knows to ask for it is not a
 * default anybody set.
 *
 * `CINDERPAW_RECALL_INJECTION=false` turns it off for a run that wants the
 * old behaviour (a strict A/B, or a token-starved endpoint).
 */
function recallInjectionEnabled(): boolean {
  return readEnv("CINDERPAW_RECALL_INJECTION") !== "false";
}

/** Char cap on the injected block. Bounded because a similarity search has
 *  no natural upper bound on how much it can match. */
function recallInjectionMaxChars(): number {
  return cfgInt("CINDERPAW_RECALL_INJECTION_MAX_CHARS");
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  // Raised from 4096 → 16384: Qwen3 and other thinking models (DeepSeek, QwQ)
  // consume a large share of the budget on chain-of-thought tokens before the
  // visible answer starts. 4096 left too little room for the actual reply,
  // cutting responses mid-sentence on anything but the shortest exchanges.
  // 16384 gives enough headroom for thinking + a full multi-paragraph reply.
  // The router's per-conversation and per-day budgets still cap total usage.
  maxTokensPerCall: 16384,
  onBudgetExhausted: "compress_and_continue",
  // Grammar-constrained decoding is on by default. The grammar fields are
  // Cinderpaw extension fields honored by the bundled llama.cpp engine; standard
  // OpenAI-compatible servers and Anthropic silently ignore unknown body fields.
  // Set CINDERPAW_TOOL_GRAMMAR=false to disable (e.g. when targeting a strict
  // server that rejects unknown JSON fields).
  useToolGrammar: readEnv("CINDERPAW_TOOL_GRAMMAR") !== "false",
  // P2: see the docstrings above for the rationale. 64 sessions × ~8KB
  // compressed transcript each ≈ 500KB worst case — trivial, but the
  // cap is a hard backstop against pathological clients. 30 min idle
  // matches a "user walked away" mental model without losing short
  // breaks (user closes laptop, opens 5 min later).
  maxRetainedSessions: 64,
  sessionIdleEvictMs: 30 * 60 * 1000,
};

export type EventSink = (event: OutboundEvent) => void;

/**
 * P3: per-session mutable flags for one handle() invocation. Isolating these
 * from the class prevents concurrent sessions from overwriting each other's
 * stopped state or emit sink — the two bugs that existed when #lastStopped and
 * #lastEmitSink were class-level fields shared across all sessions.
 */
interface SessionRunContext {
  stopped: boolean;
  readonly emit: EventSink;
  /** Decisions ask_user made without a human this turn (walk-away audit). */
  autoDecisions?: string[];
}

/**
 * P2: per-session entry held in the LRU/TTL-retained session map. Bundles
 * the WorkingMemory with the last-access timestamp so the eviction policy
 * can make its decision from a single map lookup. Mutating `lastAccess`
 * is allowed (we touch it on every access to keep the LRU order correct);
 * the field is read-only through the public surface.
 */
interface SessionEntry {
  memory: WorkingMemory;
  lastAccess: number;
  /**
   * C-02 no-progress counts, keyed by call+result digest. Lives on the session
   * rather than the turn because an unattended run is many turns: a per-turn
   * map reset on every continuation, so an agent stuck in a loop looked fresh
   * at the top of each one and could burn its whole budget while every
   * individual turn read as reasonable. Cleared whenever a turn ends
   * `completed` — reaching a real answer proves the repeats before it were not
   * a stuck loop, which keeps ordinary chat behaving exactly as before.
   */
  noProgress: Map<string, number>;
  /**
   * Tool calls made so far toward the answer being written — not this turn's.
   * Same reasoning as `noProgress` above, for the same reason: a run that reads
   * a file in turn 3 and summarises it in turn 5 did the work, and a per-turn
   * count would call turn 5 unsourced. Reset when a turn reaches an answer.
   */
  answerToolCalls: number;
}

/**
 * A constrained operating profile for a session. The default (owner) session
 * uses the full system prompt + full tool registry; a registered profile
 * swaps in its OWN system prompt and restricts the model to a named subset of
 * tools. Used by the connector surface so a public WhatsApp lead talks to a
 * sales/support persona with a read-only toolset instead of the owner's full
 * agent (filesystem, shell, desktop control). Compiled once at registration.
 */
interface CompiledProfile {
  /** The system prompt this profile's sessions run with. */
  systemPrompt: string;
  /** Tools the model is allowed to call — enforced in the exec loop.
   *  `null` = unrestricted (persona-only profile: owner toolset, new voice). */
  allowed: Set<string> | null;
}

/**
 * How a turn ended.
 *
 * This distinction existed inside `#run` all along and was thrown away at the
 * boundary: every exit path flattened to a string, so a caller could not tell
 * "here is your answer" from "I got halfway and the clock ran out". A cron job
 * therefore recorded a half-finished task as a success, reset its retry streak,
 * and delivered the partial result — with the only offered remedy being a
 * sentence asking a human who was not there to type "continue".
 */
export type TurnOutcome =
  /** The model produced a final answer. */
  | "completed"
  /** The wall-clock turn budget expired with work still in progress. */
  | "out_of_time"
  /** A proven no-progress loop was cut short (C-02). */
  | "stuck"
  /** The absolute iteration backstop fired. */
  | "ceiling"
  /** The user pressed stop. */
  | "stopped"
  /** The model returned nothing usable. */
  | "no_answer";

/**
 * Outcomes worth re-invoking the session for.
 *
 * `stuck` is excluded on purpose: it means the same call returned the same
 * result repeatedly, so another turn buys nothing but tokens. `stopped` is a
 * human decision. `no_answer` already exhausted `MAX_CONTINUATIONS` inside the
 * turn — a second outer attempt would just repeat that.
 */
const CONTINUABLE: ReadonlySet<TurnOutcome> = new Set<TurnOutcome>(["out_of_time", "ceiling"]);

/** A turn's full result. `handle()` returns only `.text`; see `handleTurn`. */
export interface TurnResult {
  text: string;
  outcome: TurnOutcome;
  toolCallCount: number;
  /** True when work remains and continuing the session is meaningful. */
  incomplete: boolean;
  /**
   * Why the turn failed, in the operator's language — token budgets, model
   * names, files worth checking. NEVER part of `text`.
   *
   * These two used to be one string, and the string was the answer. So a turn
   * that died on its token budget replied to whoever was on the other end with
   * "Try a shorter prompt or a larger model" — fine on the desktop, where the
   * reader owns the machine, and wrong everywhere else: a customer on a
   * connector was being handed the internals of a runtime they have no idea
   * exists, phrased as advice they cannot act on. Observed as an agent telling
   * a tau2 airline customer exactly that, twice, mid-booking.
   *
   * Splitting them is not hiding the reason — dropping it into a log the person
   * does not have open would be. `text` says, plainly and without jargon, that
   * the turn did not finish; `diagnostic` rides alongside on the `done` event so
   * the desktop can show the actionable version, and surfaces where a stranger
   * is reading simply do not render it.
   */
  diagnostic?: string;
}

/** Whether an outcome should be re-invoked rather than reported as done. */
export function isContinuable(outcome: TurnOutcome): boolean {
  return CONTINUABLE.has(outcome);
}

/** What one completion cost and how it ended. */
export interface CompletionOutcome {
  content: string;
  finishReason?: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  freshPromptTokens?: number;
}

/**
 * Narrow a provider response to what the loop needs, in ONE place.
 *
 * There are two return paths out of `#complete` — the ordinary one and the
 * compress-and-retry one — and they used to build this object by hand, twice.
 * That is how the cache counters came to be read by every provider and then
 * dropped at this seam: they were added to the response type and to neither
 * projection. A copy that has to be kept in sync is a copy that will not be.
 */
function projectCompletion(res: InferenceResponse): CompletionOutcome {
  return {
    content: res.content,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    ...(res.finishReason ? { finishReason: res.finishReason } : {}),
    ...(res.cacheReadTokens !== undefined ? { cacheReadTokens: res.cacheReadTokens } : {}),
    ...(res.cacheWriteTokens !== undefined ? { cacheWriteTokens: res.cacheWriteTokens } : {}),
    ...(res.freshPromptTokens !== undefined ? { freshPromptTokens: res.freshPromptTokens } : {}),
  };
}

/** Options for {@link AgentLoop.registerProfile}. */
export interface ProfileOptions {
  /** Full system prompt for this profile's sessions (persona + any KB). */
  systemPrompt: string;
  /** Whitelist of tool names the profile may use. Unknown names are ignored.
   *  Omit for a persona-only profile that keeps the owner's full toolset. */
  allowedTools?: string[];
}

export class AgentLoop {
  // ponytail: 4096 = pre-raise default; keeps cloud reasoning models from burning
  // the full 16384 budget on chain-of-thought. User Controls override takes priority.
  /**
   * Fallback max_tokens for Anthropic (required by their API, returns 400
   * without it). 128K covers all current Claude models — Opus 4.7/4.8
   * support 128K output, Sonnet supports 8K (server enforces its own cap).
   * The model stops naturally when done; this is just the ceiling.
   * OpenAI-compatible providers omit max_tokens entirely when unset.
   */
  static readonly ANTHROPIC_REQUIRED_MAX_TOKENS = 128_000;

  // Cloud models have huge contexts (Kimi 128K, Claude 200K, MiniMax 1M);
  // bound the transcript only to control cost and latency, not to avoid a
  // crash. Default is conservative for Claude-class 200K models; users on
  // 1M models (or anyone wanting zero compression) override with
  // CINDERPAW_CLOUD_TRANSCRIPT_BUDGET=900000 (or higher).
  static readonly CLOUD_TRANSCRIPT_BUDGET = 200_000;

  readonly #router: InferenceRouter;
  readonly #registry: ToolRegistry;
  readonly #episodic: EpisodicMemory;
  readonly #recall: Recaller | null;
  readonly #extractor: MemoryExtractor | null;
  /**
   * S5: optional Brain Stack. When non-null, #handle() routes per turn
   * through this.#brain and calls router.completeWith() with the chosen
   * {primary, fallback} targets. When null, today's path is preserved
   * (router.complete() with #primary/#fallback) — no behavior change.
   */
  /** Not readonly: `setBrain` swaps it when the host switches models — a
   *  brain left pointing at the previous provider routes turns to an endpoint
   *  the router no longer trusts. */
  #brain: BrainStack | null;
  readonly #config: AgentLoopConfig;
  /** Owner system prompt. Rebuilt by `#syncTools()` when the registry changes. */
  #systemPrompt!: string;
  // SOUL.md and USER are retained because the system prompt is no longer built
  // once: a late tool registration (MCP) changes the "Available tools" block,
  // so `#syncTools()` re-runs buildSystemPrompt with them.
  readonly #soul: SoulConfig | null;
  readonly #user: UserConfig | null;
  /** P0-4: optional hook registry. `agent_start` / `agent_end` /
   *  `before_prompt_build` / `before_compaction` events fire into it.
   *  Null in unit tests; in production index.ts wires the shared registry. */
  readonly #hooks: HookRegistry | null;
  /**
   * P2: one working-memory transcript per retained session, keyed by
   * sessionId. Bounded by `#maxRetainedSessions` (LRU eviction) and
   * `#sessionIdleEvictMs` (TTL eviction on access). Without these bounds
   * the map grew unboundedly for any long-running sidecar — every
   * distinct sessionId ever used kept a WorkingMemory alive in RAM
   * forever. See `#memoryFor` for the eviction logic.
   */
  readonly #sessions = new Map<string, SessionEntry>();
  /**
   * Set of sessionIds currently in the middle of `handle()`. The stop handler
   * iterates this and aborts the corresponding router call so the loop
   * exits cleanly between turns.
   */
  readonly #activeSessions = new Set<string>();
  /** Wall-clock ms when each active session started — useful for diagnostics. */
  readonly #sessionStartedAt = new Map<string, number>();
  /**
   * Per-session AbortController threaded into every `registry.call()` for
   * this session (P0-#3). `stop()` aborts this controller, which makes
   * the in-flight tool's `ctx.signal` aborted AND causes the registry's
   * race to fire, so a hung tool can no longer block a user-initiated stop.
   * Created in `#handle()` and cleared in `finally` (or when the session
   * has no in-flight tool call — the controller is still safe to abort).
   */
  readonly #sessionToolSignals = new Map<string, AbortController>();
  /**
   * Per-session mutex chain (P0-#4). Each `handle(sessionId, …)` awaits
   * the previous handle's promise for the same sessionId before starting,
   * so two messages dispatched back-to-back don't race on the same
   * `WorkingMemory.messages` array. Different sessionIds run in parallel.
   * The chain is a `Map<sessionId, Promise<void>>` where the value is THIS
   * handle's `next` promise — it resolves when this handle's `finally`
   * block runs, so the next handle's `prev` resolves after this one
   * completes. Appending a new handle overwrites the entry with the new
   * handle's own `next`; the previous handle's finally block is the one
   * that owns the cleanup decision for its own entry.
   *
   * P2 fix: the old code stored `safePrev.then(() => next)` in the map
   * and compared against the same `.then()` call in the cleanup branch.
   * Because `.then()` allocates a fresh Promise every time it runs, the
   * comparison was always against a different object identity, the
   * cleanup never fired, and the map grew unboundedly with every new
   * sessionId. Storing `next` directly and comparing against the local
   * `next` variable gives us a stable identity check; the entry is
   * actually evicted when the tail handle finishes.
   */
  readonly #sessionLocks = new Map<string, Promise<void>>();
  /**
   * P3: per-session run contexts keyed by sessionId. Created at the top of
   * handle() and cleared in its finally block. Replaces the old class-level
   * #lastStopped and #lastEmitSink fields so concurrent sessions never share
   * mutable state. The budget warning listener routes via this map so warnings
   * go to the correct session's emit sink rather than the last-registered one.
   */
  readonly #sessionContexts = new Map<string, SessionRunContext>();
  /**
   * Per-session inference overrides (temperature / max_tokens) from the host
   * UI's Controls panel, refreshed on every inbound message. Read by
   * `#complete` for the MAIN loop completions only.
   */
  readonly #sessionInferParams = new Map<
    string,
    { temperature?: number; maxTokens?: number }
  >();
  /**
   * RSI champion params — the ratcheted-best genome config, mapped onto
   * the live agent (temperature today). Applied to EVERY session as a
   * default, below the per-session UI Controls override but above the
   * provider default. This is how the passive evolutionary engine
   * actually improves the agent the user talks to: a non-technical user
   * gets a better-tuned agent over time without touching any config.
   * Set by `applyChampionParams` (on RSI ratchet + at boot).
   */
  #championParams: { temperature?: number; maxTokens?: number; systemPromptAddendum?: string } = {};
  /**
   * Cached GBNF tool-call grammar, built once from the registry's tool names.
   * Null when grammar is disabled or there are no tools. See `tool-grammar.ts`.
   */
  #toolGrammar: string | null = null;
  /**
   * A3: Cached Anthropic native tool definitions, passed to every main-loop
   * `router.complete()` call so `AnthropicProvider` can send them as the API
   * `tools` field instead of relying on text-injected schema.
   */
  #nativeTools: AnthropicToolDef[] = [];
  /**
   * A3 regression fix: cached OpenAI-compatible native tool definitions, so
   * `OpenAICompatibleProvider` / `OllamaProvider` send real `tools` instead of
   * the text-injected schema.
   */
  #openAITools: OpenAIToolDef[] = [];
  /**
   * The `registry.version` the four cached views above were built from. -1 =
   * never built. These used to be built once in the constructor on the premise
   * that "tool registration is complete before the loop runs" — false: boot
   * fires `mcpManager.connectAll()` without awaiting it, so MCP tools land in
   * the registry AFTER the AgentLoop exists. They were therefore never in the
   * advertised schemas, and `load_tool` could mark one "enabled" while the
   * model had no function to call. Rebuild whenever the registry moves.
   */
  #toolsVersion = -1;
  /**
   * Connector-surface operating profiles, keyed by profile id. Empty by
   * default (every session is the full-trust owner). A profile carries its
   * own system prompt + restricted tool set; see {@link CompiledProfile}.
   */
  readonly #profiles = new Map<string, CompiledProfile>();
  /**
   * Per-session profile assignment. A sessionId present here runs under the
   * named profile (restricted prompt + tools); absent = the default owner
   * session. Set by `setSessionProfile`, consumed by `#memoryFor`,
   * `#complete`, and the tool-exec gate in `#run`.
   */
  readonly #sessionProfile = new Map<string, string>();

  /**
   * Per-session set of extended tools the model pulled in via `load_tool`
   * (the tool drawer). Unioned with the core set when building each owner
   * turn's advertised tool schemas; profiled sessions ignore it (they carry
   * their own explicit tool list). Shared by reference with the drawer tools
   * registered in the constructor.
   */
  readonly #loadedTools = new Map<string, Set<string>>();

  /**
   * Tool-intent selection pinned on the first real message of a session.
   * `null` = no narrowing (full core set, today's behaviour). Non-null =
   * the subset `selectTools` chose for this session's lifetime. Kept here
   * and NOT in #syncTools so the tool prefix stays cache-stable: selecting
   * once per session keeps the cached prompt prefix byte-identical across
   * turns. Selecting per turn would invalidate the 41.9% cache measured in
   * OPUS_CHECKPOINT_20260826_TOKENS.md on every iteration.
   * Evicted together with the session (LRU/TTL and /new).
   */
  readonly #toolIntentSelection = new Map<string, Set<string> | null>();

  /**
   * Called with the cleaned text of each owner user turn. Set by boot to
   * persist Memory Resume state (`current_task` / `last_active_at`), which the
   * WelcomeBack banner and the TUI last-task row read back. Optional — the loop
   * works without it, and tests leave it unset.
   */
  #onUserTurn: ((sessionId: string, userText: string) => void) | null = null;

  /** @see #onUserTurn */
  /**
   * Attach the durable todo store. Its open items are re-rendered into every
   * turn's dynamic block, so the task list survives compaction — the fix for
   * "I already did this" followed by doing it again.
   *
   * Structural type on purpose: the loop needs `list()`, not a dependency on
   * the tools layer.
   */
  setTodoStore(store: { list(): Array<{ id: string; content: string; status: string }> }): void {
    this.#todos = store;
  }
  #todos: { list(): Array<{ id: string; content: string; status: string }> } | null = null;

  /**
   * The notebook read side. Structural, like `setTodoStore`: the loop must not
   * grow a dependency on SemanticMemory just to render a drawer.
   */
  setNotebookStore(store: { notes(scope: string): Array<{ key: string; value: string }> }): void {
    this.#notebook = store;
  }
  #notebook: { notes(scope: string): Array<{ key: string; value: string }> } | null = null;

  /**
   * Write side of the notebook, for the compaction safety net ONLY. Deliberately
   * narrower than the read store: it takes no key, because there is exactly one
   * key anything other than the agent is allowed to write.
   */
  setNotebookWriter(write: (sessionId: string, position: string) => void): void {
    this.#notebookWriter = write;
  }
  #notebookWriter: ((sessionId: string, position: string) => void) | null = null;

  /**
   * Attach the crash-resume checkpoint store. When present, the loop snapshots
   * the full transcript after each tool call and rehydrates a `running`
   * checkpoint when a session's working memory is (re)built — so a sidecar
   * that died mid-turn continues instead of starting over. Structural type:
   * the loop needs the three methods, not the memory layer.
   */
  setCheckpointStore(store: {
    save(a: { sessionId: string; messageId: string; iteration: number; messages: ChatMessage[] }): void;
    markDone(sessionId: string): void;
    loadRunning(sessionId: string): { messages: ChatMessage[]; iteration: number } | null;
  }): void {
    this.#checkpoints = store;
  }
  #checkpoints: {
    save(a: { sessionId: string; messageId: string; iteration: number; messages: ChatMessage[] }): void;
    markDone(sessionId: string): void;
    loadRunning(sessionId: string): { messages: ChatMessage[]; iteration: number } | null;
  } | null = null;

  setUserTurnObserver(fn: (sessionId: string, userText: string) => void): void {
    this.#onUserTurn = fn;
  }

  constructor(
    router: InferenceRouter,
    registry: ToolRegistry,
    episodic: EpisodicMemory,
    config: Partial<AgentLoopConfig> = {},
    recall: Recaller | null = null,
    extractor: MemoryExtractor | null = null,
    soul: SoulConfig | null = null,
    user: UserConfig | null = null,
    hooks: HookRegistry | null = null,
    brain: BrainStack | null = null,
  ) {
    this.#router = router;
    this.#registry = registry;
    this.#episodic = episodic;
    this.#recall = recall;
    this.#extractor = extractor;
    if (this.#extractor) {
      this.#extractor.setIdleChecker(() => this.activeSessionCount === 0);
    }
    // S5: Brain Stack is opt-in. When provided, #handle() routes per turn
    // via this.#brain and calls router.completeWith(); when null, the
    // existing path (router.complete()) is used unchanged. See #handle
    // and #complete for the dispatch logic.
    this.#brain = brain;
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#hooks = hooks;
    // Tool drawer: register list_tools/load_tool BEFORE the snapshots below so
    // they appear in the grammar + native tool lists (they're core, always
    // advertised). They share #loadedTools by reference so load_tool's effect
    // is visible when #complete builds the owner's per-turn tool set.
    const [listTools, loadTool] = createToolDrawerTools(registry, this.#loadedTools);
    registry.register(listTools);
    registry.register(loadTool);
    this.#soul = soul;
    this.#user = user;
    // Prompt, grammar and both schema arrays are derived from the registry and
    // rebuilt on demand — see #syncTools. Called once here so #systemPrompt is
    // populated for any caller that reads it before the first turn.
    this.#syncTools();

    // P1-#1: wire the router's soft-warning listener to the agent loop's
    // default emit sink. The loop's per-handle `emit` is the only sink
    // that knows the messageId / sessionId, but the warning doesn't need
    // a messageId (it's session-scoped, not turn-scoped), so we emit
    // directly to the last-known sink or fall back to a no-op.
    this.#router.setBudgetWarningListener((info) => {
      const payload = {
        type: "budget_warning" as const,
        sessionId: info.sessionId,
        kind: info.kind,
        usage: info.usage,
        limit: info.limit,
        percent: info.percent,
      };
      const sink = this.#sessionContexts.get(info.sessionId)?.emit;
      if (sink) sink(payload);
    });

    // Same shape for the rate-limit gate: when a request is held back to stay
    // under the provider's requests-per-minute cap, say so. Without this the
    // agent just goes quiet for a few seconds mid-task and looks stuck.
    this.#router.setThrottleListener((info) => {
      const sink = this.#sessionContexts.get(info.sessionId)?.emit;
      if (!sink) return;
      sink({
        type: "rate_limited",
        sessionId: info.sessionId,
        waitMs: info.waitMs,
        limitRpm: info.limitRpm,
        baseUrl: info.baseUrl,
      });
    });
  }

  /**
   * Swap the Brain Stack after the host switches models.
   *
   * The registry the brain routes over is derived from the router's targets at
   * boot. When `set_model` repoints the router, a brain still holding the old
   * targets routes to a provider the user has left — which the router's trust
   * check then refuses, ending every turn until restart. The brain has to
   * follow the router.
   */
  setBrain(brain: BrainStack | null): void {
    this.#brain = brain;
  }

  /**
   * Register (or replace) a constrained operating profile. The tool defs are
   * compiled once here by filtering the registry to `allowedTools`, so per-turn
   * cost is a single map lookup. Sessions are bound to a profile via
   * {@link setSessionProfile}. Idempotent — re-registering an id overwrites it.
   */
  registerProfile(id: string, opts: ProfileOptions): void {
    // Only the allow-list is stored. The filtered schema arrays used to be
    // compiled here, which froze them at registration time — a profile
    // registered before the MCP servers connected could never see their tools
    // even when its allow-list named them. #complete filters the live arrays.
    this.#profiles.set(id, {
      systemPrompt: opts.systemPrompt,
      allowed: opts.allowedTools ? new Set(opts.allowedTools) : null,
    });
  }

  /**
   * Bind a session to a registered profile (sticky until cleared). Must be
   * called BEFORE the session's first `handle()`, since the WorkingMemory —
   * and thus the system prompt — is created on first use. A no-op (and a
   * silent fallback to the owner profile) if the id was never registered.
   */
  setSessionProfile(sessionId: string, profileId: string): void {
    const profile = this.#profiles.get(profileId);
    if (profile) {
      this.#sessionProfile.set(sessionId, profileId);
      // Publish "not the owner" for the subsystems that write durable memory
      // (extractor, episodic, and through it the fractal tree). A profile with
      // no tool whitelist is persona-only — still the owner, in a different
      // voice — and is deliberately not restricted. See session-visibility.ts.
      markSessionRestricted(sessionId, profile.allowed !== null);
    }
  }

  /**
   * Tell a session what surface it is answering on (see `chatStyleBrief`).
   *
   * Safe to call on every inbound message — it overwrites a string. Unlike
   * `setSessionProfile` this does NOT have to precede the first `handle()`,
   * because the brief is a per-turn drawer rather than part of the frozen
   * system prompt, and unlike a profile it leaves the owner's full prompt and
   * toolset intact.
   */
  setSessionSurface(sessionId: string, brief: string, opts?: { spoken?: boolean }): void {
    this.#memoryFor(sessionId).setSurfaceBrief(brief);
    // `spoken` is not a synonym for "has a brief": it says the answer is going to
    // be HEARD, which changes which drawers make sense at all. See `#spokenSurface`.
    if (opts?.spoken) this.#spokenSurface.add(sessionId);
    else this.#spokenSurface.delete(sessionId);
  }

  /**
   * Sessions whose answers are spoken out loud.
   *
   * The notebook drawer is skipped for these. Rendering it in full every turn is
   * right for a long autonomous run — the notes are why the agent does not redo
   * work it already did — but in a spoken conversation it hijacked the reply: it is
   * the most concrete block in the prompt, so "hello" came back as a status report
   * about whatever the notes were about, and a user asked twice why he was being
   * told how many files were in an inventory he never mentioned.
   *
   * The notes stay reachable: `recall` fetches them on demand, so asking "what did
   * you note?" still works. What stops is volunteering them unprompted.
   */
  readonly #spokenSurface = new Set<string>();

  /** Clear a session's profile binding (reverts to the owner profile). */
  clearSessionProfile(sessionId: string): void {
    this.#sessionProfile.delete(sessionId);
    markSessionRestricted(sessionId, false);
  }

  /**
   * Rebuild every view derived from the tool registry — system prompt, tool-call
   * grammar, and the two native-schema arrays — if the registry has changed
   * since they were last built.
   *
   * The registry is NOT static: `boot` starts the MCP servers with a
   * fire-and-forget `connectAll()`, so their tools register seconds after the
   * AgentLoop is constructed. Building these once in the constructor meant MCP
   * tools were listed by `list_tools` (which reads the registry live) and
   * accepted by `load_tool`, yet never appeared in the schemas sent to the
   * model — "enabled" but with no function to call.
   *
   * Cheap: an integer compare on every turn, a rebuild only when a tool was
   * actually added or removed (boot, MCP connect/teardown — a handful of times
   * per process, never in steady state).
   */
  #syncTools(): void {
    if (this.#registry.version === this.#toolsVersion) return;
    this.#systemPrompt = buildSystemPrompt(this.#registry, this.#soul, this.#user);
    const toolNames = this.#registry.list().map((t) => t.manifest.name);
    this.#toolGrammar =
      this.#config.useToolGrammar && toolNames.length > 0
        ? buildToolCallGrammar(toolNames)
        : null;
    this.#nativeTools = buildNativeTools(this.#registry);
    this.#openAITools = buildOpenAITools(this.#registry);
    this.#toolsVersion = this.#registry.version;
    // What the fixed part of every completion actually costs. Both halves are
    // re-sent on every iteration of every turn, so this number is multiplied by
    // the number of tool calls a task makes — the difference between a cheap
    // agent and a surprise invoice is decided here, not in the answer. Logged
    // at sync time (boot, and whenever a tool registers) rather than per turn:
    // it only changes when the tool set does, and a per-turn line would be
    // noise that hides the one thing worth reading.
    const advertised = this.#openAITools.filter((t) => isCoreTool(t.function.name));
    // The system prompt is measured AFTER the strip a native-tool provider
    // applies, because that is what leaves the machine. Reporting the unstripped
    // one overstates the bill by more than half — an instrument that is wrong in
    // the expensive direction is worse than no instrument.
    const schema = countTokens(JSON.stringify(advertised));
    const prompt = countTokens(stripToolsFromSystemPrompt(this.#systemPrompt));
    // The notebook doctrine is added per session, so it is NOT in
    // `#systemPrompt` and this line under-reported the bill the moment the
    // notebook shipped — understating it by ~1,100 tokens on every completion.
    // Wrong in the cheap direction is the worse failure: an instrument that
    // never alarms is one nobody checks. Measured at depth 0, which is the
    // expensive case (the recursion clause is roughly half of it).
    const doctrine = countTokens(buildNotebookAddendum(this.#registry, ""));
    log(
      `tools: ${advertised.length} of ${this.#openAITools.length} advertised by default — ` +
        `${schema} tokens of schema + ${prompt} tokens of system prompt` +
        (doctrine > 0 ? ` + ${doctrine} tokens of notebook doctrine` : "") +
        ` = ${schema + prompt + doctrine} re-sent on every completion`,
    );
  }

  /**
   * Apply the RSI champion's inference params to every session as a
   * default (the passive evolutionary engine's output reaching the live
   * agent). Called on each ratchet and once at boot from the persisted
   * champion. A per-session UI Controls override still wins; absent
   * that, these win over the provider default. Pass `{}` to clear.
   */
  applyChampionParams(params: {
    temperature?: number;
    maxTokens?: number;
    systemPromptAddendum?: string;
  }): void {
    this.#championParams = { ...params };
  }

  /** Resolve the compiled profile for a session, or null for the owner default. */
  #profileFor(sessionId: string): CompiledProfile | null {
    const id = this.#sessionProfile.get(sessionId);
    return id ? (this.#profiles.get(id) ?? null) : null;
  }

  /**
   * Process one user message end-to-end. Emits chunk/tool/done/error events to
   * the sink and returns the final assistant text. Never throws.
   *
   * `skillsContext`, when provided, is rendered as a short "Available skills"
   * menu in the system prompt for THIS turn only (Claude Code-style: metadata
   * menu + on-demand `read_skill` tool body). It is refreshed every turn from
   * Rust, so installing or removing a skill mid-conversation is reflected in
   * the very next message without resetting the session.
   */
  async handle(
    sessionId: string,
    userText: string,
    messageId: string,
    emit: EventSink,
    skillsContext?: SkillMeta[],
    images?: string[],
    inferParams?: { temperature?: number; max_tokens?: number },
  ): Promise<string> {
    const result = await this.handleTurn(
      sessionId, userText, messageId, emit, skillsContext, images, inferParams,
    );
    return result.text;
  }

  /**
   * One turn, with how it ended.
   *
   * Identical to `handle()` except that the caller learns whether the task is
   * actually finished. Anything unattended — a cron job, a connector, the
   * walk-away digest — must use this: `handle()` alone cannot distinguish a
   * completed task from one the clock cut in half, and treating the second as
   * the first is how a scheduled job reports success on work it never did.
   */
  async handleTurn(
    sessionId: string,
    userText: string,
    messageId: string,
    emit: EventSink,
    skillsContext?: SkillMeta[],
    images?: string[],
    inferParams?: { temperature?: number; max_tokens?: number },
  ): Promise<TurnResult> {
    // Per-session inference overrides from the host UI's Controls panel.
    // Refreshed on every message so a Controls change applies from the very
    // next turn; cleared when the host stops sending them.
    if (inferParams) {
      this.#sessionInferParams.set(sessionId, sanitizeInferParams(inferParams));
    } else {
      this.#sessionInferParams.delete(sessionId);
    }
    const prev = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const safePrev = prev.catch(() => undefined);
    this.#sessionLocks.set(sessionId, next);

    const abortController = new AbortController();
    const ctx: SessionRunContext = { stopped: false, emit };

    try {
      await safePrev;
      this.#activeSessions.add(sessionId);
      this.#sessionStartedAt.set(sessionId, Date.now());
      this.#sessionToolSignals.set(sessionId, abortController);
      this.#sessionContexts.set(sessionId, ctx);
      return await this.#handle(sessionId, userText, messageId, ctx, skillsContext, images);
    } catch (err) {
      // `#handle` is documented as never throwing, but a throw here must not
      // look like a completed turn to an unattended caller.
      return {
        text: "Something went wrong on my side and I couldn't finish that.",
        diagnostic: `turn failed: ${String(err)}`,
        outcome: "no_answer",
        toolCallCount: 0,
        incomplete: false,
      };
    } finally {
      release();
      this.#activeSessions.delete(sessionId);
      this.#sessionStartedAt.delete(sessionId);
      if (this.#sessionToolSignals.get(sessionId) === abortController) {
        this.#sessionToolSignals.delete(sessionId);
      }
      if (this.#sessionContexts.get(sessionId) === ctx) {
        this.#sessionContexts.delete(sessionId);
      }
      if (this.#sessionLocks.get(sessionId) === next) {
        this.#sessionLocks.delete(sessionId);
      }
      this.#extractor?.runPending();
    }
  }

  /**
   * Stop an in-flight generation. Aborts the router call AND the in-flight
   * tool (P0-#3) for the given session, if any. The router throws
   * AbortError on the next token; the tool registry returns a structured
   * `{ok:false, error:"cancelled"}` to the loop. Both paths converge into
   * a `done` event with `stopped: true` semantics upstream.
   *
   * Safe to call when no generation is in flight (no-op).
   */
  /**
   * File an exchange that happened somewhere else, without answering it.
   *
   * A speech-to-speech call is conducted by Gemini, not by this loop: by the
   * time it ends, the user has been heard and answered, and both halves exist
   * only as the transcripts the far end produced. Sending them through
   * `handleTurn` would make the agent reply to a question already answered —
   * so the memory writes are separated from the thinking, and this does only
   * the writes.
   *
   * It is the difference between a call that leaves a trace and one that never
   * happened. Ten minutes of conversation, closed, and nothing in the session:
   * the next call opens knowing nothing, and `recall` cannot find a word of it.
   *
   * Takes the session lock like a real turn, because the same session can be
   * typed in while a call runs, and interleaving two writers into one
   * WorkingMemory reorders the conversation.
   */
  async recordTurn(sessionId: string, userText: string, assistantText: string): Promise<void> {
    const user = userText.trim();
    const assistant = assistantText.trim();
    // Nothing to file is not an error: a call can end after a greeting with no
    // transcript worth keeping, and an empty pair would be a turn that reads as
    // the agent having said nothing when asked nothing.
    if (!user && !assistant) return;

    const prev = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    this.#sessionLocks.set(sessionId, new Promise<void>((resolve) => { release = resolve; }));
    try {
      await prev.catch(() => undefined);
      const memory = this.#memoryFor(sessionId);
      if (user) {
        memory.addUser(user);
        // The same two side effects a lived turn has: the resume row, so
        // "what was I doing" knows about the call, and the episodic write that
        // `recall` and the fractal tree read from. Skipping either would leave
        // the turn visible on screen and invisible to memory, which is the
        // worse half of not recording it at all.
        if (isReplayableSession(sessionId) && !this.#profileFor(sessionId)) {
          this.#onUserTurn?.(sessionId, user);
        }
        const ts = Date.now();
        const leaf = this.#episodic.record(sessionId, "user", user);
        if (leaf !== null) this.#recall?.noteWrite?.({ id: leaf, sessionId, ts });
      }
      if (assistant) {
        memory.addAssistant(assistant);
        const ts = Date.now();
        const leaf = this.#episodic.record(sessionId, "assistant", assistant);
        if (leaf !== null) this.#recall?.noteWrite?.({ id: leaf, sessionId, ts });
      }
    } finally {
      release();
    }
  }

  stop(sessionId: string): void {
    // Latch the stop on the session context FIRST. Aborting is edge-triggered:
    // the router deletes a session's controller once its call settles, so
    // between two model calls `router.abort()` is a no-op, and the tool signal
    // has no in-flight tool observing it. A stop landing in that window (during
    // a tool, or during the episodic/memory writes that follow one) was
    // therefore dropped and the loop went on to make the next model call —
    // "stop doesn't stop it". The loop reads this flag, so the latch survives
    // whether or not there is something abortable in flight right now.
    const ctx = this.#sessionContexts.get(sessionId);
    if (ctx) ctx.stopped = true;
    this.#router.abort(sessionId);
    this.#sessionToolSignals.get(sessionId)?.abort("user stop");
  }

  /**
   * Count of currently active sessions (P2-#1, exposed for heartbeat).
   * Public so the HeartbeatLoop can read it without breaking the
   * private-field encapsulation. Cheap (Set.size).
   */
  get activeSessionCount(): number {
    return this.#activeSessions.size;
  }

  /**
   * P2: number of session WorkingMemory instances currently retained
   * in the LRU cache (sum of active + idle). Exposed for tests and
   * ops dashboards. Bounded by `maxRetainedSessions` and by the
   * TTL eviction on access.
   */
  get retainedSessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * `/new` — start this session over from nothing.
   *
   * The escape hatch for a conversation that has drifted past the point
   * compaction can save. Three things have to happen together or the reset
   * does not stick:
   *
   *   1. the live WorkingMemory goes,
   *   2. any `running` crash checkpoint is marked done — otherwise the next
   *      message rehydrates the exact transcript we just dropped
   *      (`#memoryFor` prefers a checkpoint over episodic replay), and
   *   3. an episodic barrier is written, so the 40-turn replay in `#memoryFor`
   *      starts after this point instead of restoring the conversation.
   *
   * Nothing is deleted. Past turns stay in episodic and stay searchable by
   * recall — this cuts the thread, it does not burn the history.
   *
   * The session's connector profile is deliberately left alone: resetting a
   * conversation must not change which persona is answering it.
   *
   * ponytail: no interlock with an in-flight turn. `/new` sent while the agent
   * is mid-answer lets that turn finish against the old transcript and the
   * reply still lands; the next message starts clean. Add a session-lock wait
   * if that ordering ever actually confuses someone.
   */
  /** Where the tokens went, for `!cost`. The router owns the ledger. */
  costReport(): string {
    return this.#router.costReport();
  }

  resetSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#toolIntentSelection.delete(sessionId);
    this.#checkpoints?.markDone(sessionId);
    this.#episodic.record(sessionId, "system", SESSION_RESET_MARK);
  }

  /**
   * Manual `/compact` (OpenClaw slash parity): summarize the older portion
   * of one session's transcript NOW, not just when over budget. Targets
   * half the current estimate (capped at the normal transcript budget) so
   * a long transcript always has something to fold; a short one reports
   * "not needed". Reuses the same summarizer + compression path the
   * automatic pre-send compaction runs, so behavior can't drift.
   */
  async compactSession(sessionId: string): Promise<"compacted" | "not needed"> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return "not needed";
    const memory = entry.memory;
    // Size the target from the TRANSCRIPT, not estimatedTokens() — the
    // latter counts the (large) system prompt, which would make a 2-line
    // chat look compactable. A short transcript answers "not needed".
    const transcriptTokens = memory.turns.reduce((n, m) => n + countTokens(m.content), 0);
    if (memory.turns.length < 4 || transcriptTokens < 1024) return "not needed";
    // Fold roughly the older half of the transcript (cap at the normal
    // pre-send budget so /compact never targets LOOSER than automatic
    // compaction would).
    const target = Math.min(
      this.#transcriptBudget(),
      memory.estimatedTokens() - Math.floor(transcriptTokens / 2),
    );
    const compressed = await memory.maybeCompress(
      (msgs) => this.#summarize(sessionId, msgs),
      target,
    );
    return compressed ? "compacted" : "not needed";
  }

  /**
   * P2: number of session mutex chains currently held in `#sessionLocks`.
   * Exposed for tests so they can verify the cleanup path actually fires
   * (was always non-zero after the bug fix landed; should be 0 in a
   * quiescent state when no handle() is in flight). Cheap (Map.size).
   */
  get activeLockCount(): number {
    return this.#sessionLocks.size;
  }

  /**
   * Stop every active generation. Used on shutdown so no `handle()` is
   * left mid-await when the process exits.
   */
  stopAll(): void {
    for (const sessionId of [...this.#activeSessions]) {
      this.stop(sessionId);
    }
  }

  async #handle(
    sessionId: string,
    userText: string,
    messageId: string,
    ctx: SessionRunContext,
    skillsContext?: SkillMeta[],
    images?: string[],
  ): Promise<TurnResult> {
    // P0-4: agent_start hook. Informational — fires once at the top
    // of every turn. Errors are swallowed inside the hook registry.
    if (this.#hooks) {
      try {
        await this.#hooks.fire("agent_start", { sessionId, userText });
      } catch (err) {
        process.stderr.write(
          `[agent-loop] agent_start hook fire failed: ${String(err)}\n`,
        );
      }
    }

    const memory = this.#memoryFor(sessionId);
    // Drawers model: skills are NOT dumped into the prompt. The model discovers
    // them on demand via the `list_skills` tool and loads bodies with
    // `read_skill`. (skillsContext is still accepted for host/API compat but no
    // longer injected — the full menu cost tokens every turn even when no skill
    // was used.)
    void skillsContext;

    // P2-#3: traceId — a unique identifier for this handle() invocation.
    // Threaded into every OutboundEvent the agent emits during the turn
    // (chunk, tool_start, tool_done, done, budget_warning, error) so the
    // UI can correlate the entire timeline of one user request. Also
    // used by the sidecar's audit log so a row can be cross-referenced
    // with what the user saw. Cryptographically random — collision
    // probability is negligible at the scale of a single user session.
    const traceId = crypto.randomUUID();

    // Drawers model: past context is NOT auto-injected. Wholesale recall ran an
    // embedding query every turn and dumped all semantic facts + graph + the top
    // episodic hits into the prompt — thousands of tokens on a trivial "Test",
    // and it defeated the whole point of FMS being an on-demand store. The model
    // now pulls only what it needs via the `recall` tool (same FMS query path).

    // Strip <private>...</private> blocks before persisting to episodic memory.
    // The model still sees the full text during the current turn — only storage
    // is affected, preserving user privacy across sessions.
    //
    // Credentials are redacted on top of that, and without being asked.
    // Connector setup tells the user in plain words to paste a bot token
    // here; a guard that only fires when they remembered to type
    // `<private>` around it protects nobody at the moment it matters.
    const { text: userTextClean } = stripPrivate(redactSecrets(userText).text);

    // Refresh the durable task list for this turn. Cheap (one indexed SELECT)
    // and it must run per turn, not per session: the model updates the list
    // mid-task via todo_write and has to see its own edits.
    if (this.#todos) {
      try {
        memory.setTodoList(this.#todos.list());
      } catch {
        // A todo-store failure must never cost the user their turn.
      }
    }

    // Refresh the notebook for this turn, for the same reason as the task list:
    // the agent rewrites it mid-task via `remember` and has to see its own edits.
    // Scoped like every other semantic read, so one Discord member's notes never
    // surface in another's session.
    if (this.#notebook) {
      try {
        // Spoken turns get no notebook drawer — see `#spokenSurface` for why.
        memory.setNotebook(
          this.#spokenSurface.has(sessionId) ? [] : this.#notebook.notes(memoryScope(sessionId)),
        );
      } catch {
        // A memory-store failure must never cost the user their turn.
      }
    }

    // Automatic recall. The loop has always HELD a `Recaller` and never asked
    // it anything — only `noteWrite` was ever called, so memory was written
    // every turn and read only when the model happened to reach for the
    // `recall` tool. On TheAgentCompany that was 12 writes and zero reads, and
    // across a run of independent tasks the carry between them was nil.
    //
    // Queried from the user's own words, per turn, so it follows the
    // conversation instead of being fixed at session start. Failure is
    // swallowed on purpose: a memory store that is slow, locked or corrupt
    // must cost the user nothing worse than a turn without recall.
    if (this.#recall && !this.#spokenSurface.has(sessionId) && recallInjectionEnabled()) {
      try {
        const recalled = await this.#recall.recall(userTextClean, sessionId);
        memory.setRecall(recalled.context, recallInjectionMaxChars());
      } catch {
        memory.setRecall("");
      }
    }

    // When the message names a file, the transcript carries the one instruction
    // this model obeys. Only the transcript: `userTextClean` above already went
    // to episodic memory unchanged, so what the person actually wrote is what
    // gets remembered. See withOpenFirst for why a rule in SOUL.md does not
    // substitute for this.
    memory.addUser(withOpenFirst(userText), images);
    // Memory Resume: this user turn IS the current task. Fired here, at the one
    // seam every surface goes through (desktop/TUI dispatch, WhatsApp, Discord),
    // rather than in dispatch.ts — a connector conversation is still the user
    // working, and resume data that ignores it goes stale the moment they pick
    // up their phone. Machine sessions (cron/RSI/dream) and public-persona
    // profiles are excluded: neither is the owner, and a customer's WhatsApp
    // message must never become the owner's "current task".
    if (isReplayableSession(sessionId) && !this.#profileFor(sessionId)) {
      this.#onUserTurn?.(sessionId, userTextClean);
    }
    // Tool-intent: pin the advertised tool subset once, on the first real
    // message of this session. Owner sessions only — connector profiles
    // already carry an explicit allow-list, workers are scoped elsewhere,
    // and background sessions (cron/RSI/dream) are not user intent.
    // `#syncTools` is deliberately NOT the place: it runs on registry
    // version bumps (MCP connect), not on user input, and re-selecting
    // there would churn the cached prefix every time a tool registers.
    if (
      !this.#toolIntentSelection.has(sessionId) &&
      isReplayableSession(sessionId) &&
      !this.#profileFor(sessionId) &&
      !isWorkerSession(sessionId)
    ) {
      try {
        const coreNames = this.#registry.list().map((t) => t.manifest.name).filter(isCoreTool);
        const selected = selectTools({ text: userTextClean, coreTools: coreNames });
        // `selectTools` returns the full core set when it has no signal or
        // the saving is too small to be worth the miss risk. Store `null`
        // for that case so per-turn filtering stays a single branch.
        const narrowed = selected.length < coreNames.length ? new Set(selected) : null;
        this.#toolIntentSelection.set(sessionId, narrowed);
      } catch {
        // Classifier is pure but the failure mode is the same as no signal:
        // fall open, advertise everything.
        this.#toolIntentSelection.set(sessionId, null);
      }
    }

    const userWriteTs = Date.now();
    const userLeafId = this.#episodic.record(sessionId, "user", userTextClean);
    if (userLeafId !== null) {
      this.#recall?.noteWrite?.({ id: userLeafId, sessionId, ts: userWriteTs });
    }

    const turnStartedAt = Date.now();
    let toolCallCount = 0;
    let tokensUsed = 0;

    // S5: Brain Stack routing — compute ONCE per user turn (NOT per tool
    // iteration). The chosen {primary, fallback} pair is used for every
    // router call inside the loop in #run (main completion + budget-
    // recovery retry). A BrainError here falls back to the default path —
    // a misconfigured Brain must not break a turn — but the fallback is
    // announced via `model_routed`, never silent.
    const routeTargets = this.#brain
      ? this.#routeForTurn(userText, images, ctx, sessionId, traceId)
      : null;

    try {
      // Self-terminating loop: no limit computation needed. #run() returns
      // naturally when the model produces a text-only turn (no tool calls).
      // The 500-ceiling inside #run() is an emergency backstop only.
      const { text: runText, toolCallCount: runToolCount, outcome, diagnostic } = await this.#run(
        sessionId,
        memory,
        messageId,
        ctx,
        traceId,
        routeTargets,
      );
      toolCallCount = runToolCount;
      // The turn returned (completed, stopped, or out of time) — it is not a
      // crash, so retire its checkpoint. Only a process that dies mid-turn
      // leaves a `running` row, and that is exactly what resume keys on.
      this.#checkpoints?.markDone(sessionId);

      // Walk-away summary: if any decision was taken without the user this turn,
      // append an audit block so they can review every autonomous choice when
      // they return. Free — no extra completion, just the decisions collected
      // in #run. The model's own text is already its "what I did" narrative.
      // The session-scoped no-progress counters (see `SessionEntry.noProgress`)
      // only accumulate while a task is unfinished. A turn that reached a real
      // answer is proof the repeats leading up to it were productive, so the
      // slate is wiped — that is what keeps normal chat, where every turn ends
      // here, on exactly the pre-session-scope behaviour.
      if (outcome === "completed") this.#sessions.get(sessionId)?.noProgress.clear();

      const decisions = ctx.autoDecisions ?? [];
      const final = decisions.length > 0
        ? `${runText}\n\n---\n**Decisions I made on your behalf** (you weren't asked — review these):\n` +
          decisions.map((d) => `- ${d}`).join("\n")
        : runText;
      memory.addAssistant(final);
      // The agent echoing a token back ("I've saved sk-…") would persist it
      // just as surely as the user pasting it, so the reply gets the same
      // pass.
      const { text: finalClean } = stripPrivate(redactSecrets(final).text);
      const asstWriteTs = Date.now();
      const asstLeafId = this.#episodic.record(sessionId, "assistant", finalClean);
      if (asstLeafId !== null) {
        this.#recall?.noteWrite?.({ id: asstLeafId, sessionId, ts: asstWriteTs });
      }

      // An answer about a file that nothing opened. This used to live in
      // `connectors.ts`, which meant Discord and Slack got the warning and
      // every other surface shipped the invention bare — the desktop, the TUI,
      // and `/runtime/chat`, whose answer is this `done` event and never the
      // string a caller returns. Six live completions producing three
      // fabricated line counts for files that do not exist, none of them
      // marked, is what one guard sitting in one caller costs.
      //
      // AFTER the recording above, deliberately. The note is the environment
      // talking, and anything appended to the assistant's stored text comes
      // back as the assistant's own voice on the next replay — which is the
      // bug in the commit before this one.
      const entry = this.#sessions.get(sessionId);
      const answerToolCalls = (entry?.answerToolCalls ?? 0) + toolCallCount;
      if (entry) entry.answerToolCalls = isContinuable(outcome) ? answerToolCalls : 0;
      // Nothing to warn about mid-run: a cut-off turn is not an answer yet.
      const unsourced = isContinuable(outcome)
        ? null
        : unsourcedWarning(final, answerToolCalls, userText);
      const delivered = unsourced ? `${final}\n\n${unsourced}` : final;

      ctx.emit({
        type: "done",
        id: messageId,
        content: delivered,
        stopped: ctx.stopped,
        traceId,
        outcome,
        incomplete: isContinuable(outcome),
        ...(diagnostic ? { diagnostic } : {}),
      });

      // Fire-and-forget: extract durable user facts from the turn just
      // completed — but only when the speaker IS the user.
      //
      // SemanticMemory is "the persistent model of the user". A session under
      // a RESTRICTED profile is, by construction, someone else: the public
      // WhatsApp lead mode answers strangers who were never on the allowlist.
      // Mining "durable facts about the user" from them is a category error
      // before it is a leak — a lead saying "my name is Bob, I run a
      // competitor" became a global fact the owner's `recall` would later
      // return as truth about the owner. It is also a prompt-injection
      // channel: whoever messages the business account gets to write into the
      // owner's durable memory.
      //
      // Restricted (`allowed` non-null) is the right test, not "has a
      // profile": a persona-only profile is still the owner in a different
      // voice, and their facts should keep being learned. The sanctioned way
      // for a lead's details to persist is `capture_lead`, which the public
      // toolset does include.
      if (!isRestrictedSession(sessionId)) {
        this.#extractor?.extractAsync(sessionId, [...memory.turns]);
      }

      // P0-4: agent_end hook. Informational. Carries the final answer,
      // the tool-call count, the duration, and the token total so a
      // hook can write to a log, send a notification, or trigger a
      // background job. Errors are swallowed.
      if (this.#hooks) {
        try {
          await this.#hooks.fire("agent_end", {
            sessionId,
            userText,
            answer: final,
            toolCalls: toolCallCount,
            tokensUsed,
            durationMs: Date.now() - turnStartedAt,
          });
        } catch (err) {
          process.stderr.write(
            `[agent-loop] agent_end hook fire failed: ${String(err)}\n`,
          );
        }
      }

      return { text: delivered, outcome, toolCallCount, incomplete: isContinuable(outcome), ...(diagnostic ? { diagnostic } : {}) };
    } catch (err) {
      // Checkpoint policy on a handled failure (crash is handled elsewhere — a
      // dead process leaves the row `running` on its own):
      //   - a user STOP retires the checkpoint (they chose to end it);
      //   - an ERROR (a wedged model, a total provider outage) LEAVES it
      //     running, so the turn resumes from its last good step when the
      //     session is next touched — a provider outage during a walk-away run
      //     must not become permanent data loss. It self-retires when the next
      //     turn on that session completes.
      // User-initiated stop: the router's fetch was aborted by `stop()`. Emit
      // a `done` event with `stopped: true` so the frontend can render a
      // "stopped" state without surfacing an error to the user. Use the
      // accumulated assistant text up to the abort point, or a short notice
      // if nothing was streamed.
      // #13: an idle-timeout abort is NOT a user stop — the engine went
      // silent for the whole idle window (model wedged, provider hung,
      // network dropped). Surface it as a real, explained error instead of
      // a mute "stopped" state.
      if (isIdleTimeout(err)) {
        const message =
          "The model stopped responding (no output for several minutes), so the " +
          "request was cancelled. The model or provider may be overloaded — try " +
          "again, or switch to a smaller/faster model.";
        ctx.emit({ type: "error", id: messageId, message, traceId });
        return { text: message, outcome: "out_of_time", toolCallCount, incomplete: true };
      }
      if (isAbortError(err)) {
        // A user stop is a deliberate end — retire the checkpoint.
        this.#checkpoints?.markDone(sessionId);
        ctx.stopped = true;
        const partial = memory.render();
        const lastAssistant = [...partial].reverse().find((m) => m.role === "assistant");
        const content = lastAssistant?.content?.trim() || "(stopped by user)";
        ctx.emit({ type: "done", id: messageId, content, stopped: true, traceId, outcome: "stopped", incomplete: false });
        if (this.#hooks) {
          try {
            await this.#hooks.fire("agent_end", {
              sessionId,
              userText,
              answer: content,
              toolCalls: toolCallCount,
              tokensUsed,
              durationMs: Date.now() - turnStartedAt,
            });
          } catch (hookErr) {
            process.stderr.write(
              `[agent-loop] agent_end hook fire failed: ${String(hookErr)}\n`,
            );
          }
        }
        return { text: content, outcome: "stopped", toolCallCount, incomplete: false };
      }
      const message = errorMessage(err);
      ctx.emit({ type: "error", id: messageId, message, traceId });
      if (this.#hooks) {
        try {
          await this.#hooks.fire("agent_end", {
            sessionId,
            userText,
            answer: message,
            toolCalls: toolCallCount,
            tokensUsed,
            durationMs: Date.now() - turnStartedAt,
          });
        } catch (hookErr) {
          process.stderr.write(
            `[agent-loop] agent_end hook fire failed: ${String(hookErr)}\n`,
          );
        }
      }
      // `message` names budgets, providers and exception text — the operator's
      // vocabulary. It already went out on the `error` event, which is where a
      // host that should see it looks; what comes back here is what gets
      // DELIVERED as the reply, so it stays in the reader's vocabulary instead.
      return {
        text: "Something went wrong on my side and I couldn't finish that.",
        diagnostic: message,
        outcome: "no_answer",
        toolCallCount,
        incomplete: false,
      };
    }
  }

  async #run(
    sessionId: string,
    memory: WorkingMemory,
    messageId: string,
    ctx: SessionRunContext,
    traceId: string,
    /**
     * S5: Brain Stack routing decision computed ONCE in #handle, threaded
     * through every iteration of the tool-call loop. When null, falls
     * back to router.complete() (the pre-S5 path) so the call graph is
     * unchanged for callers that don't opt into Brain.
     */
    routeTargets: { primary: ModelTarget; fallback?: ModelTarget } | null = null,
  ): Promise<{ text: string; toolCallCount: number; outcome: TurnOutcome; diagnostic?: string }> {
    // Reset stop flag at the start of every run (ctx is per-handle, so this
    // only affects this session — the P3 fix for shared #lastStopped).
    ctx.stopped = false;
    let toolCallCount = 0;
    // Emergency backstop — prevents infinite loops from runaway tool calls.
    // Normal usage never approaches this ceiling; the loop self-terminates
    // whenever the model produces a text-only turn (no tool calls).
    const ABSOLUTE_CEILING = 500;
    // Token-cutoff recovery: when a completion exhausts max_tokens while the
    // model is still reasoning (thinking present, answer empty), feed the
    // partial back and ask it to finish instead of surfacing a dead-end
    // "increase max_tokens" message. Bounded so a degenerate model that only
    // ever reasons can't loop forever.
    const MAX_CONTINUATIONS = 4;
    let continuations = 0;
    // One Daemon reflection per turn. See the gate at natural termination.
    let daemonReflections = 0;
    // Malformed tool-call recovery: when a turn contains a tool-call attempt
    // that failed to parse (corrupted JSON like `{"name="read_skill">`),
    // the model meant to act — ending the turn there strands the task. Feed
    // back a corrective nudge and let it re-emit a valid call. Bounded so a
    // model that can never produce valid JSON doesn't loop forever.
    const MAX_MALFORMED_RETRIES = 3;
    let malformedRetries = 0;
    // Wall-clock bound on one turn. ABSOLUTE_CEILING bounds ITERATIONS, not
    // time — and with a 300s per-request cloud deadline, 500 iterations is
    // ~41 hours. The desktop has a Stop button; Discord/Slack/WhatsApp have
    // none, so a wedged long-horizon task there ran until the sidecar died.
    // Checked between iterations only: we never abandon an in-flight tool or
    // completion, we just stop starting new ones and return what we have.
    const turnDeadline = Date.now() + turnBudgetMs();
    let ranOutOfTime = false;
    // Accumulated answer fragments from length-cutoff continuations: each
    // entry is the visible text of one completion that ran out of max_tokens
    // mid-answer. The final answer is the concatenation of all fragments
    // plus the terminating completion's text — mirroring what the user saw
    // stream into the chat bubble.
    const answerParts: string[] = [];
    // M1: no-progress detector. Two failure shapes matter and the old
    // consecutive-only check caught just one of them:
    //   A,A,A          — the model retries the identical call. Caught before.
    //   A,B,A,B,A      — a two-cycle (read the same missing file, list the
    //                    same dir, read it again). NEVER caught, because
    //                    every call differed from its immediate predecessor.
    // A sliding window of recent keys catches both, and failures are counted
    // separately so a call that FAILS twice is corrected immediately rather
    // than after a third identical attempt.
    const recentToolKeys: string[] = [];
    const toolFailureCounts = new Map<string, number>();
    // Every counter above keys on the ARGUMENTS, and some failures have nothing
    // to do with them. The live case: DuckDuckGo Lite paces at one query per
    // five seconds and, once tripped, refuses everything for two minutes —
    // instantly. The model searches, is refused, rephrases (the sensible move),
    // and is refused again in microseconds. A rephrased query is a different
    // key, so every counter restarts at one: the exact-arguments nudge never
    // fires, the loop window never fills, the hard stop at 20 is never
    // approached, and the turn spends its whole iteration ceiling in a few
    // seconds against a tool that is not even reaching the network.
    //
    // Keyed on tool + the failure text instead, so the same refusal counts as
    // the same refusal however the query is worded. Failures only: a tool
    // legitimately returning identical SUCCESS for different arguments is
    // somebody's cache, not a stall.
    const toolWideFailures = new Map<string, number>();
    // C-02: outcome-aware no-progress counter. `recentToolKeys` above keys on
    // arguments alone, so it can only warn — it cannot tell a productive repeat
    // (a poll whose output advances) from a stuck one. Keying on args AND the
    // rendered result makes "no progress" a fact rather than a guess, which is
    // what licenses a hard stop.
    //
    // Counts live on the SESSION, not this turn. The nudge counters above stay
    // per-turn on purpose — a nudge is advice and should arrive fresh — but the
    // hard stop has to see across continuations, because that is the only place
    // an 8-hour run can go wrong without any single turn looking wrong.
    // The `?? new Map()` is unreachable (`#memoryFor` ran in `#handle`) and
    // degrades to the old per-turn behaviour rather than throwing.
    const noProgressCounts = this.#sessions.get(sessionId)?.noProgress ?? new Map<string, number>();
    /** Set when a proven no-progress loop trips the hard stop; ends the turn. */
    let stuckOn: { tool: string; count: number } | null = null;

    // Walk-away audit trail: decisions ask_user made without a human (autonomous
    // mode or a timeout). Surfaced at turn end so the user, coming back, can see
    // and check every choice that was taken on their behalf. Held on ctx so the
    // caller (#handle) can append the summary without #run's many exit points
    // each having to thread it back.
    const autoDecisions: string[] = ctx.autoDecisions ??= [];

    // Crash-resume: snapshot the transcript after each tool call so a sidecar
    // death mid-turn resumes with completed steps intact. No-op without a
    // checkpoint store. Guarded against throwing — a checkpoint must never
    // cost the turn it is protecting.
    const checkpoint = (iteration: number): void => {
      if (!this.#checkpoints) return;
      try {
        this.#checkpoints.save({ sessionId, messageId, iteration, messages: [...memory.turns] });
      } catch {
        /* a failed checkpoint just means this step is not resumable */
      }
    };

    for (let i = 0; i < ABSOLUTE_CEILING; i++) {
      // A stop latched by stop() between iterations must not be followed by one
      // more model call — check before spending the turn, not only after it.
      if (ctx.stopped) break;
      // Same discipline for the clock: don't start another round we can't
      // afford. `i > 0` guarantees at least one attempt even if the budget was
      // already spent by a slow prompt build.
      if (i > 0 && Date.now() > turnDeadline) {
        ranOutOfTime = true;
        break;
      }

      // Stream tokens live — EXCEPT tool-call-shaped output. Once the stream
      // hits a tool-call opener (canonical tag, invoke-XML, or bare
      // {"name … JSON) everything from that point is held back: if the turn
      // parses as a tool call the pill events render it, and if it's
      // malformed garbage (observed: MiniMax M3 emitting `]<]minimax[>[`
      // token debris inside <tool_call>) the user never sees it — the old
      // behavior streamed the raw garbage into the chat and the malformed
      // retry then streamed a second full answer on top (the duplicated-
      // reply report, 2026-07-11). Held text that turns out to be plain
      // prose is flushed after parse, so nothing is ever lost.
      let streamedSoFar = "";
      const hold = createStreamHoldback((content) =>
        ctx.emit({ type: "chunk", id: messageId, content, traceId }),
      );
      // Where the time actually goes, because "it feels slow" has no answer and
      // is the third time this year the same question has been re-derived by
      // hand. Three numbers separate the three causes that look identical from
      // the outside: a long WAIT then a fast stream is the provider queueing,
      // a short wait then a slow stream is us (or the route), and a long wait
      // with thinking output is the model reasoning. Guessing between them from
      // a stopwatch is how an afternoon disappears.
      const sentAt = Date.now();
      let firstTokenAt = 0;
      let streamedChunks = 0;
      const onToken = (token: string) => {
        if (firstTokenAt === 0) firstTokenAt = Date.now();
        streamedChunks++;
        streamedSoFar += token;
        hold.push(token);
      };

      const { content: completion, finishReason, promptTokens, completionTokens } = await this.#complete(
        sessionId,
        memory,
        onToken,
        routeTargets,
        ctx,
        messageId,
        traceId,
      );
      // Surface REAL token usage so the UI context ring reflects actual context
      // consumption (the latest call's prompt = full context fed to the model,
      // plus this turn's completion) instead of a rough message estimate.
      ctx.emit({ type: "usage", id: messageId, sessionId, promptTokens, completionTokens, traceId });
      {
        const now = Date.now();
        // A non-streaming provider never calls onToken, so the wait IS the whole
        // turn — say "n/a" rather than printing 0 and implying it was instant.
        const ttft = firstTokenAt > 0 ? `${((firstTokenAt - sentAt) / 1000).toFixed(1)}s` : "n/a";
        const total = (now - sentAt) / 1000;
        // Rate from the provider's OWN completion count, not from how many
        // times onToken fired. The first reading said "6.0 tok/s" for 233
        // tokens in 1.7s — off by more than twenty times, because a provider
        // streams CHUNKS and a chunk is many tokens. An instrument that
        // understates throughput by 20× points the investigation straight at
        // the wrong half of the turn, which is the one thing it exists to
        // prevent. Chunks are still reported, because a low chunk count with a
        // high token count means the "stream" arrived in two lumps — which
        // feels like a stall no matter how good the tokens-per-second is.
        const streamSecs = firstTokenAt > 0 ? (now - firstTokenAt) / 1000 : 0;
        const rate = streamSecs > 0 && completionTokens
          ? `${(completionTokens / streamSecs).toFixed(0)} tok/s`
          : "n/a";
        // Thinking is measured because it is the cheapest way to rule the model
        // OUT: `think=0` on a slow turn means nothing was reasoned, so the time
        // was spent somewhere that is not the model's head.
        const think = completion.length - stripThinking(completion).length;
        // Not every provider returns usage. Printing "undefined prompt" in an
        // instrument built to answer "where does the time go" just adds a
        // second question — say the counts are missing, or leave them out.
        const usage = promptTokens || completionTokens
          ? `, ${promptTokens ?? "?"} prompt + ${completionTokens ?? "?"} completion`
          : "";
        log(
          `turn: wait ${ttft} → first token, ${total.toFixed(1)}s total, ` +
            `${rate} over ${streamedChunks} chunk(s)${usage}, think=${think}`,
        );
      }
      // The live registry is the allowlist for the vendored repair pass: a
      // shape we do not natively parse may only become a call if it names a
      // tool that actually exists. Read fresh each turn — load_tool can add
      // tools mid-task, and a stale list would reject the call it just enabled.
      const parsed = parseResponse(
        completion,
        this.#registry.list().map((t) => t.manifest.name),
      );

      // Settle the stream holdback against the parser's own account of the
      // turn's free text: anything it calls prose and the stream has not
      // shown yet goes out now, and the tool-call tags never do.
      hold.settle(parsed.text);

      if (parsed.toolCalls.length === 0 && parsed.malformedToolCall) {
        if (malformedRetries < MAX_MALFORMED_RETRIES) {
          malformedRetries++;
          // Store the turn WITHOUT its <think> reasoning. The chain-of-thought was
      // already streamed live to the UI and billed once as completion tokens;
      // persisting it means every later turn re-sends it as prompt tokens,
      // turning a multi-step task into quadratic token growth (a trivial shell
      // test burned ~18k tokens this way). Reasoning is ephemeral — only the
      // visible answer + any <tool_call> tags belong in re-sent history.
      memory.addAssistant(stripThinking(completion));
          memory.addUser(
            "(system: your previous message contained a tool call with invalid " +
              "JSON, so it was NOT executed. Re-emit the call as a single valid " +
              'JSON object — {"name": "tool_name", "args": {…}} inside ' +
              "<tool_call></tool_call> tags — or answer in plain text if you no " +
              "longer need the tool. Do NOT repeat any prose you already wrote; " +
              "the user has seen it.)",
          );
          continue;
        }
        // Retries exhausted: fall through to natural termination with whatever
        // prose survived the scrub, rather than looping forever.
      }

      if (parsed.toolCalls.length === 0) {
        // No tool calls → natural termination. The model chose to answer
        // rather than call another tool. Strip reasoning tags so a
        // thinking-only completion never leaks raw tags as the answer.
        // A turn whose whole visible output is a stray tag is not an answer.
        // Observed on the bench: MiniMax ended a half-done refactor by emitting
        // the single token `<boundary>` — no tool call, no prose, so the loop
        // read it as a final answer and returned with the task untouched (files
        // read, nothing edited). Anything with no letters or digits once tags
        // are stripped is degenerate output; fall through to the empty-answer
        // path, which already knows how to ask for a real continuation.
        // The fallback to the raw stream exists for the case where parsing lost
        // an answer the user already watched arrive. It must not resurrect what
        // parsing removed ON PURPOSE: a tool-call block is machine syntax, and
        // when the model will not emit valid JSON (three retries, then here)
        // this line used to deliver the broken call as the reply. Observed live
        // on Discord — the whole answer was a `<tool_call>` block. Prose the
        // model wrote around the call is still the user's, so scrub the blocks
        // rather than discarding the stream.
        const streamedFallback = stripThinking(streamedSoFar)
          .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "")
          .trim();
        const rawAnswer = stripThinking(parsed.text) || streamedFallback;
        const answer = /[\p{L}\p{N}]/u.test(rawAnswer.replace(/<[^>]*>/g, "")) ? rawAnswer : "";

        // Mid-answer token cutoff: the model was still WRITING when it ran
        // out of max_tokens (finish_reason "length" with visible text). The
        // old behavior silently presented the truncated text as the final
        // answer — the "agent randomly stops writing" report. Feed the
        // partial back and ask it to resume exactly where it stopped; the
        // streamed chunks keep flowing into the same UI bubble, so the user
        // sees one continuous reply. Shares the MAX_CONTINUATIONS bound with
        // the reasoning-cutoff path below.
        if (answer && finishReason === "length" && continuations < MAX_CONTINUATIONS) {
          continuations++;
          answerParts.push(answer);
          // Store the turn WITHOUT its <think> reasoning. The chain-of-thought was
      // already streamed live to the UI and billed once as completion tokens;
      // persisting it means every later turn re-sends it as prompt tokens,
      // turning a multi-step task into quadratic token growth (a trivial shell
      // test burned ~18k tokens this way). Reasoning is ephemeral — only the
      // visible answer + any <tool_call> tags belong in re-sent history.
      memory.addAssistant(stripThinking(completion));
          memory.addUser(
            "(system: your previous reply was cut off by the per-call token " +
              "limit mid-answer. Continue EXACTLY from where you stopped — do " +
              "not repeat anything you already wrote, no preamble, no summary; " +
              "resume mid-sentence if needed.)",
          );
          continue;
        }

        if (!answer) {
          // Empty answer — distinguish "model only reasoned, no answer" from
          // a true silence so the user knows whether to retry with a shorter
          // prompt (cut-off) or a different model (degenerate).
          const hadThinking = /<think>|<thinking>|<\|channel>thought/i.test(completion);
          // Degenerate output (a bare `<boundary>`-style tag and nothing else)
          // spends a continuation too. Giving up here ends the task silently
          // mid-work; one nudge is far cheaper than a half-done refactor the
          // user has to discover themselves.
          const degenerate = rawAnswer !== "" && answer === "";
          // A completion that is empty end to end used to finish the turn on
          // the spot. After a turn that has already run tools that throws the
          // work away: 28 tool calls and 88 seconds of real work came back to
          // the person as "(The model returned an empty response.)" while every
          // result sat in the transcript, unread. Silence is not a verdict, it
          // is a model that stopped talking — and the single nudge the stray-tag
          // case already gets costs one call against work that is otherwise
          // lost. Bounded by MAX_CONTINUATIONS like the others.
          const workToReport = toolCallCount > 0;
          if (hadThinking || degenerate || workToReport) {
            if (continuations < MAX_CONTINUATIONS) {
              continuations++;
              // Store the turn WITHOUT its <think> reasoning. The chain-of-thought was
      // already streamed live to the UI and billed once as completion tokens;
      // persisting it means every later turn re-sends it as prompt tokens,
      // turning a multi-step task into quadratic token growth (a trivial shell
      // test burned ~18k tokens this way). Reasoning is ephemeral — only the
      // visible answer + any <tool_call> tags belong in re-sent history.
      memory.addAssistant(stripThinking(completion));
              memory.addUser(
                workToReport && !degenerate
                  ? "(system: your previous reply was empty. The tool results above are " +
                      "work you have already done and nobody has seen it. If the task is " +
                      "not finished, call the next tool. If it is finished, state plainly " +
                      "what you did and what you verified.)"
                  : degenerate
                  ? "(system: your previous reply contained no answer — only a stray tag. " +
                      "If the task is not finished, continue working: call the next tool. " +
                      "If it is finished, state plainly what you did and what you verified.)"
                  : "(system: your previous reply hit the per-call token limit while you " +
                      "were still reasoning. Do NOT restart your reasoning from scratch — " +
                      "pick up where you left off and produce the final answer directly " +
                      "and concisely.)",
              );
              continue;
            }
            // If earlier length-cutoff fragments exist, they ARE the answer
            // the user watched stream in — return them rather than an apology.
            if (answerParts.length > 0) {
              return { text: answerParts.join(""), toolCallCount, outcome: "completed" };
            }
            // Same distinction as below: when tools ran, blaming the token
            // budget for reasoning is both wrong and, worse, it tells the
            // person nothing happened when files may have changed.
            return {
              // Audience-safe: true, useful, and it names no machinery. Whoever
              // is reading might be a customer who has never heard of a model.
              text:
                toolCallCount > 0
                  ? "I did some of the work but wasn't able to finish this. Please check before relying on it."
                  : "I wasn't able to answer that. Please try again.",
              diagnostic:
                toolCallCount > 0
                  ? `The model went silent after ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"} ` +
                    `and never wrote an answer, even after several automatic retries. The work itself ran — ` +
                    `check the files it touched before re-running this.`
                  : "The model used all available tokens on reasoning and produced no answer, even after several automatic continuations. Try a shorter prompt or a larger model.",
              toolCallCount,
              outcome: "no_answer",
            };
          }
          if (answerParts.length > 0) {
            return { text: answerParts.join(""), toolCallCount, outcome: "completed" };
          }
          // "Nothing came back" and "nothing happened" are different facts, and
          // saying the first when the second is false is how work goes missing
          // quietly: the files are on disk, the row says no_answer, and the
          // person is told the model said nothing. Name the work so they know
          // there is something to go and look at.
          return {
            text:
              toolCallCount > 0
                ? "I did some of the work but wasn't able to finish this. Please check before relying on it."
                : "I wasn't able to answer that. Please try again.",
            diagnostic:
              toolCallCount > 0
                ? `The model went silent after ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"} ` +
                  `and never wrote an answer. The work itself ran — check the files it touched before re-running this.`
                : "The model returned an empty response.",
            toolCallCount,
            outcome: "no_answer",
          };
        }
        // Natural termination — model chose to answer rather than call a tool.
        // Prepend any length-cutoff fragments so the persisted answer matches
        // the full text the user watched stream into the bubble.
        const finalText = [...answerParts, answer].join("");

        // The Daemon gate. "Completed" is the agent's opinion; a file being on
        // disk is not. `done_when` already established that the world wins over
        // the claim, but it only ever runs where somebody DECLARED an assertion
        // — the cron API, the UI, or a person typing `done_when:` into a chat
        // message — so for the person who just installed this and asked a
        // question, it has never once fired. This is the assertion nobody has to
        // declare: if the answer says it wrote a file, the file has to exist.
        //
        // Placed here rather than in `unattended.ts` (which has its own
        // run-level check) because every caller terminates through this line:
        // interactive turns, connectors, cron and subagents all get it from one
        // guard instead of four.
        //
        // Only after tools ran: a turn that called nothing cannot have written
        // anything, and `unsourced.ts` already owns that case. One reflection,
        // not four — a model that repeats the claim after being shown the empty
        // directory will keep repeating it, and the person is better served by
        // being told than by paying for a third round.
        if (toolCallCount > 0 && daemonReflections === 0) {
          const missing = await unkeptWriteClaims(finalText);
          if (missing.length > 0) {
            daemonReflections++;
            memory.addAssistant(stripThinking(completion));
            memory.addUser(daemonPrompt(missing));
            continue;
          }
        }
        // The reflection landed in a transcript nobody reads. If it did not take,
        // the person is about to be handed an answer we have already proved
        // wrong, so the reason goes on their screen in their own window.
        if (toolCallCount > 0 && daemonReflections > 0) {
          const stillMissing = await unkeptWriteClaims(finalText);
          if (stillMissing.length > 0) {
            return {
              text: `${finalText}\n\n${daemonNotice(stillMissing)}`,
              toolCallCount,
              outcome: "completed",
            };
          }
        }
        return { text: finalText, toolCallCount, outcome: "completed" };
      }

      // Model called tools → process them, then loop for the next turn.
      // Store the turn WITHOUT its <think> reasoning. The chain-of-thought was
      // already streamed live to the UI and billed once as completion tokens;
      // persisting it means every later turn re-sends it as prompt tokens,
      // turning a multi-step task into quadratic token growth (a trivial shell
      // test burned ~18k tokens this way). Reasoning is ephemeral — only the
      // visible answer + any <tool_call> tags belong in re-sent history.
      memory.addAssistant(stripThinking(completion));

      // Profiled (connector) sessions may only call tools on their whitelist.
      // The model isn't even shown the others, but a hallucinated call is
      // hard-blocked here before it reaches the registry — the connector
      // surface's security boundary must not depend on the model behaving.
      const profile = this.#profileFor(sessionId);

      // Subagent fan-out: a batch made ENTIRELY of delegate_task calls is
      // independent by contract (the tool's description instructs the model
      // to split only independent parts), so the delegations run
      // concurrently. Mixed batches keep sequential order — models emit
      // dependent sequences (write_file → read_file) often enough that
      // blanket parallelism would corrupt them.
      if (
        parsed.toolCalls.length > 1 &&
        parsed.toolCalls.every((c) => c.name === "delegate_task") &&
        (!profile?.allowed || profile.allowed.has("delegate_task"))
      ) {
        const toolSignal = this.#sessionToolSignals.get(sessionId)?.signal;
        for (const call of parsed.toolCalls) {
          toolCallCount++;
          ctx.emit({ type: "tool_start", id: messageId, tool: call.name, args: call.args, traceId, sessionId });
        }
        const results = await Promise.all(
          parsed.toolCalls.map((call) =>
            this.#registry.call(call.name, call.args, sessionId, {
              ...(toolSignal ? { signal: toolSignal } : {}),
              onProgress: ctx.emit,
            }),
          ),
        );
        for (let i = 0; i < parsed.toolCalls.length; i++) {
          const call = parsed.toolCalls[i]!;
          const result = results[i]!;
          ctx.emit({ type: "tool_done", id: messageId, tool: call.name, result, traceId, sessionId });
          if (result.error === "cancelled") ctx.stopped = true;
          const rendered = result.ok ? result.content : `ERROR: ${result.content}`;
          memory.addToolResult(call.name, rendered, result.images);
          const episodicContent = `${call.name}: ${rendered}`.slice(0, 400);
          const toolLeafId = this.#episodic.record(sessionId, "tool", episodicContent);
          if (toolLeafId !== null) {
            this.#recall?.noteWrite?.({ id: toolLeafId, sessionId, ts: Date.now() });
          }
        }
        checkpoint(i);
        if (ctx.stopped) break;
        continue;
      }

      for (const call of parsed.toolCalls) {
        toolCallCount++;
        ctx.emit({ type: "tool_start", id: messageId, tool: call.name, args: call.args, traceId, sessionId });
        // Advertising is not enforcement: a model can name a tool it was never
        // shown. Both conditions are checked here, and the owner-only one tests
        // the profile's presence rather than its allow-list.
        const deniedByProfile =
          (profile && isOwnerOnlyTool(call.name)) ||
          (profile?.allowed && !profile.allowed.has(call.name));
        if (deniedByProfile) {
          const denied = `Tool "${call.name}" is not available in this conversation.`;
          ctx.emit({ type: "tool_done", id: messageId, tool: call.name, result: { ok: false, content: denied, error: "not_available" }, traceId, sessionId });
          memory.addToolResult(call.name, `ERROR: ${denied}`);
          continue;
        }
        // P0-#3: thread the per-session tool signal so AgentLoop.stop()
        // aborts the in-flight tool (in addition to the router).
        const toolSignal = this.#sessionToolSignals.get(sessionId)?.signal;
        const result = await this.#registry.call(call.name, call.args, sessionId, {
          ...(toolSignal ? { signal: toolSignal } : {}),
          onProgress: ctx.emit,
        });
        ctx.emit({ type: "tool_done", id: messageId, tool: call.name, result, traceId, sessionId });

        // P0-#3: a `cancelled` result means the user invoked stop() during
        // this tool. Exit the iteration loop cleanly so the user's intent
        // to stop is respected.
        if (result.error === "cancelled") {
          ctx.stopped = true;
          break;
        }

        const rendered = result.ok ? result.content : `ERROR: ${result.content}`;
        // A tool that looked at a picture hands the pixels along with its text
        // (ToolResult.images). Attached to the tool turn so a vision-capable
        // model sees the image itself; text-only models ignore them.
        memory.addToolResult(call.name, rendered, result.images);

        // Record any decision ask_user made on the user's behalf (autonomous
        // mode or a timeout auto-resolve), for the end-of-turn summary.
        if (call.name === "ask_user" && result.ok) {
          const d = result.data as { autoResolved?: boolean; answers?: Array<{ question?: string; selected?: string[] }> } | undefined;
          if (d?.autoResolved && Array.isArray(d.answers)) {
            for (const a of d.answers) {
              autoDecisions.push(`"${a.question ?? "(question)"}" → ${a.selected?.join(", ") || "(none)"}`);
            }
          }
        }

        // M1: detect a stuck model. See the declarations above for why this
        // is a window and not a consecutive-run check.
        const callKey = `${call.name}:${safeArgsKey(call.args)}`;
        recentToolKeys.push(callKey);
        if (recentToolKeys.length > LOOP_WINDOW) recentToolKeys.shift();

        if (!result.ok) {
          const failures = (toolFailureCounts.get(callKey) ?? 0) + 1;
          toolFailureCounts.set(callKey, failures);
          // Second failure of the SAME call: quote the actual error back at
          // the model and forbid the repeat. This is the "read the error,
          // adjust, don't do it again" step — waiting for a third identical
          // attempt just burns a turn re-learning what we already know.
          if (failures === 2) {
            memory.addUser(
              `(system: "${call.name}" has now failed twice with these exact arguments. ` +
              `The error was: ${result.content.slice(0, 300)} — do NOT call it with these arguments again. ` +
              "Change the arguments, use a different tool, or tell the user plainly what is blocking you.)",
            );
          }
          // The same refusal, whatever was asked. Deliberately the opposite
          // advice from the nudge above: telling a rate-limited search to
          // change its arguments is what keeps it rephrasing forever.
          const wideKey = `${call.name}:${resultDigest(result.content)}`;
          const wide = (toolWideFailures.get(wideKey) ?? 0) + 1;
          toolWideFailures.set(wideKey, wide);
          if (wide === TOOL_WIDE_FAILURE_STOP) {
            memory.addUser(
              `(system: "${call.name}" has now failed ${wide} times with the SAME error across ` +
              "different arguments, so the problem is the tool itself and not the arguments — " +
              `rephrasing will not help. The error was: ${result.content.slice(0, 300)}\n` +
              `Stop calling "${call.name}" for now. Continue with what you already have, use a ` +
              "different tool, or tell the user plainly that this is what is blocking you.)",
            );
          }
        }

        // C-02: identical call AND identical output = proven zero progress.
        const outcomeKey = `${callKey}:${resultDigest(rendered)}`;
        const noProgress = (noProgressCounts.get(outcomeKey) ?? 0) + 1;
        noProgressCounts.set(outcomeKey, noProgress);
        if (noProgress >= NO_PROGRESS_STOP) {
          stuckOn = { tool: call.name, count: noProgress };
          break;
        }

        const repeats = recentToolKeys.filter((k) => k === callKey).length;
        if (repeats >= 3) {
          memory.addUser(
            `(system: you have called "${call.name}" with the same arguments ${repeats} times within the ` +
            `last ${LOOP_WINDOW} tool calls — you are looping. Take a different approach, or give the user ` +
            "your best answer with what you already have and say what you could not do.)",
          );
          // Clear the window so the nudge is not re-emitted on every
          // subsequent call while the model is recovering.
          recentToolKeys.length = 0;
        }

        const toolWriteTs = Date.now();
        // Truncate before episodic storage: tool results can be up to 64 KB
        // (read_file), but recall only needs the identifying gist to surface
        // this event in future sessions. Store at most 400 chars so large
        // file reads don't bloat the FTS5 index and flood recall results.
        const episodicContent = `${call.name}: ${rendered}`.slice(0, 400);
        const toolLeafId = this.#episodic.record(sessionId, "tool", episodicContent);
        if (toolLeafId !== null) {
          this.#recall?.noteWrite?.({ id: toolLeafId, sessionId, ts: toolWriteTs });
        }
        // Checkpoint after each tool call, not each batch: a crash between two
        // sequential calls should resume after the one that finished.
        checkpoint(i);
      }

      // Some calls in this batch never ran. Say so BEFORE the model reasons
      // over the results it did get — left unsaid, it reads the successful
      // results as the whole batch and reports work it never did. Naming the
      // count (not just "something failed") is what lets it work out WHICH
      // ones are missing by diffing against what it sent.
      if (parsed.droppedToolCalls > 0) {
        memory.addUser(
          `(system: ${parsed.droppedToolCalls} tool call(s) in your previous message were malformed ` +
            "and did NOT run — you only have results for the ones that did. Work out which are " +
            "missing and re-emit ONLY those, one valid JSON object per <tool_call> block. Verify " +
            "the current state first if the missing calls had side effects: re-sending a write " +
            "that actually succeeded creates a duplicate.)",
        );
      }

      if (stuckOn) break;
      if (ctx.stopped) break;
    }

    // C-02: a proven no-progress loop. Report honestly rather than burning the
    // rest of the iteration ceiling or the wall clock on an identical call.
    if (stuckOn) {
      return {
        text:
          `I stopped: "${stuckOn.tool}" returned exactly the same result ${stuckOn.count} times ` +
          `with the same arguments, so repeating it cannot make progress. Here is what I ` +
          `completed in ${toolCallCount} actions before getting stuck — tell me how you'd ` +
          `like to approach it differently, or narrow the task.` +
          (answerParts.length > 0 ? `\n\n${answerParts.join("")}` : ""),
        toolCallCount,
        outcome: "stuck",
      };
    }

    // User-initiated stop via tool-cancel path: the break above exited the main
    // loop, not the ceiling. Return a clean "(stopped by user)" instead of the
    // ceiling-hit message, which is misleading when the user meant to stop.
    if (ctx.stopped) {
      return {
        text: "(stopped by user)",
        toolCallCount,
        outcome: "stopped",
      };
    }

    // Wall-clock stop. Return the work done so far with an honest explanation
    // rather than the ceiling message (which blames the task's scope) — the
    // task may have been fine and simply slow.
    if (ranOutOfTime) {
      return {
        text:
          `I ran out of time for this turn after ${toolCallCount} actions ` +
          `(limit ${Math.round(turnBudgetMs() / 60_000)} min). The task is NOT finished — ` +
          `here is where I got to.` +
          (answerParts.length > 0 ? `\n\n${answerParts.join("")}` : ""),
        toolCallCount,
        outcome: "out_of_time",
      };
    }

    // Only reached if the ABSOLUTE_CEILING was hit — an emergency backstop
    // for runaway tool-call loops, not a normal termination path.
    return {
      text: `I completed ${toolCallCount} actions but haven't been able to produce a final answer. The task may be too open-ended — try narrowing the scope or asking for a specific output format.`,
      toolCallCount,
      outcome: "ceiling",
    };
  }

  /**
   * Token budget for the live transcript, sized to the model's REAL context.
   *
   * Local engines load with a small KV cache — Rust caps it at CINDERPAW_MAX_CONTEXT
   * (default 8192, see inference.rs `DEFAULT_MAX_CONTEXT`) — and the prompt that
   * actually hits the model is system + tool schemas + drawers + transcript +
   * this turn's output. The tool schemas are NOT counted by
   * `WorkingMemory.estimatedTokens()`, so we subtract an explicit margin for
   * them plus the output reserve. Without compacting to THIS budget before each
   * call, the transcript grows unbounded until it overflows the KV cache — the
   * "local model crashes every 5-10 prompts / on complex tasks" failure.
   *
   * For sub-8K-context models, lower CINDERPAW_MAX_CONTEXT to match (calibration
   * knob — the real model context isn't always the cap).
   */
  #transcriptBudget(): number {
    if (!this.#router.isPrimaryLocal) {
      return Number(readEnv("CINDERPAW_CLOUD_TRANSCRIPT_BUDGET")) || AgentLoop.CLOUD_TRANSCRIPT_BUDGET;
    }
    // Prefer the engine's real active window (forwarded by Rust on set_model);
    // fall back to the env / conservative default before the first set_model.
    const ctx = this.#router.contextWindow || cfgInt("CINDERPAW_MAX_CONTEXT");
    const outputReserve = Math.min(this.#config.maxTokensPerCall, 2048);
    // ponytail: covers the CORE advertised tool schemas (~2-3K) plus headroom
    // for a few drawer-loaded tools — not counted by estimatedTokens(). Was
    // 1536, which under-reserved the old full ~28-tool set (~5-8K) and let the
    // prompt overflow small local KV caches. Bump if the core set grows.
    const toolSchemaMargin = 3072;
    return Math.max(1024, ctx - outputReserve - toolSchemaMargin);
  }

  /** One completion with budget handling (compress-and-retry or stop). */
  async #complete(
    sessionId: string,
    memory: WorkingMemory,
    onToken?: (token: string) => void,
    /**
     * S5: Brain Stack routing decision computed ONCE in #handle, threaded
     * through every iteration of the tool-call loop. When null, falls
     * back to router.complete() (the pre-S5 path) so the call graph is
     * unchanged for callers that don't opt into Brain.
     */
    routeTargets: { primary: ModelTarget; fallback?: ModelTarget } | null = null,
    /**
     * Present only when called from the main #run loop — used to surface
     * a synthetic tool_start/tool_done pair around context compaction so a
     * slow summarizer call (a full extra LLM completion on CPU) shows up
     * as a visible step instead of silent dead air inside the "streaming"
     * status line. Absent for the summarizer/extractor's own one-shot calls.
     */
    ctx?: SessionRunContext,
    messageId?: string,
    traceId?: string,
  ): Promise<CompletionOutcome> {
    // Pick up any tools registered since the last turn (MCP servers finish
    // connecting after boot) before deriving this turn's schemas from them.
    this.#syncTools();
    // Grammar-constrained tool calls (opt-in). Applied only to the main agent
    // loop — the summarizer and memory extractor have their own router calls
    // and must stay unconstrained.
    const grammarFields = this.#toolGrammar
      ? { grammar: this.#toolGrammar, grammarTriggers: [...TOOL_CALL_TRIGGERS] }
      : {};
    // P1 (prompt caching): the main agent loop asks the local engine to
    // reuse the persistent LlamaContext's KV cache. Combined with the
    // cache-friendly layout in WorkingMemory.render() (dynamic context
    // appended to the last user message, system prompt kept static), this
    // makes the static prefix tokenize identically turn-over-turn so the
    // engine reuses the cached KV and only recomputes the new tail.
    // The summarize() and extractor() paths leave this off — they are
    // one-shot calls with no stable prefix to cache.
    // Profiled (connector) sessions advertise only their restricted tool
    // subset; the owner default sees the full set.
    const profile = this.#profileFor(sessionId);
    // Owner default advertises CORE tools only; extended tools are added once
    // the model pulls them in via the drawer (load_tool → #loadedTools). This
    // is the token-economy lever: ~28 schemas (~5-8K tokens) every turn drops
    // to the core set (~2-3K). Profiled sessions keep their explicit list.
    const loaded = this.#loadedTools.get(sessionId);
    // A profiled session advertises exactly its allow-list; the owner sees the
    // core set plus whatever the drawer pulled in. Both filter the LIVE arrays
    // (see #syncTools), so a tool that registered after boot — every MCP tool —
    // is reachable instead of being permanently invisible.
    // A restricted profile advertises exactly its allow-list; a persona-only
    // profile (allowed = null) and the owner both see core + drawer-loaded.
    // Tool-intent is the per-session narrowing from selectTools, pinned on
    // the first user message. `null` / absent = no narrowing. A non-null set
    // is the subset for this session; drawer-loaded tools are still allowed
    // through so a bad guess is recoverable via `load_tool`.
    const intentSelection = this.#toolIntentSelection.get(sessionId) ?? null;
    const advertise = (name: string): boolean => {
      // Owner-only tools are withheld from every profiled session, including a
      // persona-only one whose `allowed` is null — see OWNER_ONLY_TOOLS. The
      // test is the PRESENCE of a profile, not the contents of its allow-list,
      // because a null allow-list is exactly the case that used to pass.
      if (profile && isOwnerOnlyTool(name)) return false;
      if (profile?.allowed) return profile.allowed.has(name);
      // Drawer escape hatch: a tool the model explicitly pulled in is always
      // advertised, even if intent selection would have withheld it. Without
      // this the drawer and the intent router would fight, and the drawer —
      // the recovery path for a wrong guess — would lose.
      if (loaded?.has(name)) return true;
      if (intentSelection !== null && !intentSelection.has(name)) return false;
      return isCoreTool(name);
    };
    const nativeTools = this.#nativeTools.filter((t) => advertise(t.name));
    const openAITools = this.#openAITools.filter((t) => advertise(t.function.name));
    // A turn that advertises nothing is indistinguishable, from the outside,
    // from a model that chose not to call anything: same empty tool_calls, same
    // confident answer built on nothing. We spent a day reading the second story
    // out of evidence that fit both. Zero is the one count worth a line — a
    // healthy turn stays silent, so this only ever appears when something is
    // actually wrong upstream (empty registry, a profile allow-list that matches
    // no tool name, a sync that never ran).
    if (openAITools.length === 0 && nativeTools.length === 0) {
      log(`tools: 0 advertised for ${sessionId} — the model cannot call anything this turn`);
    }

    // Surfaces compaction as a visible synthetic tool call (tool_start/
    // tool_done on the existing event stream) instead of silent dead air —
    // the summarizer is a full extra LLM completion, which on CPU can take
    // as long as the turn itself, with nothing in the UI to explain the wait.
    const compact = async (budget: number): Promise<boolean> => {
      // Gate the synthetic event on the same over-budget check maybeCompress
      // makes internally — without it every turn (not just ones that
      // actually compact) would emit a tool_done, inflating any caller that
      // counts tool calls from the event stream (e.g. Subagent.run).
      if (!ctx || !messageId || !traceId || memory.estimatedTokens() <= budget) {
        return memory.maybeCompress((msgs) => this.#summarize(sessionId, msgs), budget);
      }
      ctx.emit({ type: "tool_start", id: messageId, tool: "context_compaction", args: {}, traceId });
      try {
        const compressed = await memory.maybeCompress((msgs) => this.#summarize(sessionId, msgs), budget);
        ctx.emit({
          type: "tool_done",
          id: messageId,
          tool: "context_compaction",
          result: { ok: true, content: compressed ? "compacted" : "not needed" },
          traceId,
        });
        return compressed;
      } catch (err) {
        ctx.emit({
          type: "tool_done",
          id: messageId,
          tool: "context_compaction",
          result: { ok: false, content: String(err) },
          traceId,
        });
        throw err;
      }
    };

    // Proactive context-window management: keep the transcript within the
    // model's real context BEFORE sending. The reactive cost-budget path in the
    // catch below only fires at millions of tokens — far past the local KV-cache
    // wall — so without this the prompt overflows the engine and the run crashes
    // after a handful of turns. Cheap: a no-op until the transcript exceeds the
    // budget, then one summarizer call amortized over many subsequent turns.
    await compact(this.#transcriptBudget());

    // S5: dispatch helper — uses router.completeWith() when Brain Stack
    // provided route targets, otherwise the existing router.complete()
    // path. Same shape either way; the router handles all the audit /
    // budget / abort machinery in both modes. Hoisted BEFORE the try so
    // both the main call and the budget-recovery retry can call it.
    const overrides = this.#sessionInferParams.get(sessionId);
    // For cloud models we intentionally do NOT set max_tokens when the user
    // hasn't explicitly chosen a value. OpenAI-compatible APIs (NIM, Ollama
    // cloud, etc.) omit the field entirely and use the server's own default —
    // which is always better than us guessing. Anthropic requires max_tokens
    // so we supply a safe upper bound there (see ANTHROPIC_REQUIRED_MAX_TOKENS).
    const defaultMaxTokens = this.#router.isPrimaryLocal
      ? this.#config.maxTokensPerCall
      : undefined;

    // What we are about to send, by category. Built here rather than in
    // WorkingMemory because the advertised tool schemas are a per-session fact
    // (profile allow-list + whatever the drawer has pulled in) that the memory
    // has never seen — and on a short turn they are the largest single lane.
    // Stripped exactly when the providers strip it: native tool definitions are
    // being sent, so the prose copy of the tool list is removed from the system
    // prompt on its way out.
    const sendsNativeTools = openAITools.length > 0 || nativeTools.length > 0;
    const breakdown = memory.breakdown(
      sendsNativeTools ? stripToolsFromSystemPrompt : undefined,
    );
    const schemaTokens = countTokens(
      JSON.stringify(openAITools.length > 0 ? openAITools : nativeTools),
    );
    if (schemaTokens > 0) {
      breakdown.parts.push({
        category: "tool_schemas",
        detail: `${(openAITools.length > 0 ? openAITools : nativeTools).length} advertised`,
        tokens: schemaTokens,
      });
      breakdown.localTotal += schemaTokens;
    }

    const dispatch = (
      maxTokens: number | undefined,
      temperature: number | undefined,
    ): Promise<InferenceResponse> => {
      const req = {
        sessionId,
        messages: memory.render(),
        promptBreakdown: breakdown,
        maxTokens,
        temperature,
        onToken,
        cachePrompt: true,
        // The main loop is the one place in the product where this is
        // unambiguously true: system prompt and tool schemas are rebuilt only
        // when the registry changes, and everything that varies per turn is
        // appended to the last user message rather than spliced into the
        // prefix. That layout was built for the local KV cache; declaring it
        // here is what lets a cloud provider bill it the same way.
        cachePrefix: "short" as const,
        // A3: native tool definitions for Anthropic.
        nativeTools,
        // A3 regression fix: native tool definitions for OpenAI-compatible providers.
        openAITools,
        ...grammarFields,
      };
      if (routeTargets) {
        return this.#router.completeWith(
          routeTargets.primary,
          routeTargets.fallback,
          req,
        );
      }
      return this.#router.complete(req);
    };

    try {
      const res = await dispatch(
        // Precedence: explicit UI Controls override > RSI champion > cloud/local default.
        overrides?.maxTokens ?? this.#championParams.maxTokens ?? defaultMaxTokens,
        overrides?.temperature ?? this.#championParams.temperature,
      );
      return projectCompletion(res);
    } catch (err) {
      if (
        err instanceof BudgetExhaustedError &&
        this.#config.onBudgetExhausted === "compress_and_continue"
      ) {
        const compressed = await compact(this.#transcriptBudget());
        if (compressed) {
          const overrides = this.#sessionInferParams.get(sessionId);
          const res = await dispatch(
            overrides?.maxTokens ?? (this.#router.isPrimaryLocal ? this.#config.maxTokensPerCall : undefined),
            overrides?.temperature,
          );
          return projectCompletion(res);
        }
      }
      throw err;
    }
  }

  /**
   * S5: ask Brain Stack to pick `{primary, fallback}` for this user turn.
   * Returns null when Brain is unconfigured, has no candidates, or
   * throws — all of those cases fall back to the existing router.complete()
   * path so a misconfigured Brain never breaks a turn.
   *
   * The `offline` hint is computed here from the router's state:
   *   offline = primary is local AND cloud is not reachable
   * (cloud is reachable when primary OR fallback is on a non-loopback
   * host — see `InferenceRouter.cloudReachable`).
   */
  /**
   * Roughly how big this turn's prompt will be, so routing can rule out a
   * model that cannot hold it.
   *
   * An estimate on purpose. The real prompt is assembled inside `#run`, after
   * the model has already been chosen — waiting for the exact number would
   * mean choosing first and measuring afterwards, which is the order that
   * produced the failure this guards against. The three parts that dominate
   * are known here: the system prompt, the advertised tool schemas, and the
   * conversation so far.
   *
   * Erring high is the safe direction: it moves a borderline turn to a bigger
   * model, and the cost of that is money. The cost of erring low is a reply
   * made of repeated bytes.
   */
  #estimateTurnTokens(userText: string, sessionId: string): number {
    let total = countTokens(this.#systemPrompt) + countTokens(userText);
    // The tool schemas, measured the same way the cost log measures them.
    total += countTokens(
      JSON.stringify(this.#openAITools.filter((t) => isCoreTool(t.function.name))),
    );
    const memory = this.#sessions.get(sessionId)?.memory;
    if (memory !== undefined) {
      for (const turn of memory.turns) total += countTokens(turn.content ?? "");
    }
    return total;
  }

  #routeForTurn(
    userText: string,
    images: string[] | undefined,
    ctx: SessionRunContext,
    sessionId: string,
    traceId: string,
  ): { primary: ModelTarget; fallback?: ModelTarget } | null {
    if (!this.#brain) return null;
    try {
      const offline =
        this.#router.isPrimaryLocal && !this.#router.cloudReachable;
      const result = this.#brain.route({
        text: userText,
        hasImages: images !== undefined && images.length > 0,
        offline,
        promptTokens: this.#estimateTurnTokens(userText, sessionId),
      });
      ctx.emit({
        type: "model_routed",
        sessionId,
        provider: result.primary.provider,
        model: result.primary.model,
        reason: result.fallback ? "brain" : "only_candidate",
        category: result.classification.category,
        traceId,
      });
      return { primary: result.primary, fallback: result.fallback };
    } catch (err) {
      // BrainError (no candidates) or any other routing failure: fall
      // through to the default path. The router will surface its own
      // InferenceError if no model is actually configured.
      //
      // The fallback is ANNOUNCED, not silent. This used to be a bare
      // console.warn: the turn was answered by a different model than the
      // one routing chose, and the only explanation lived in a log file
      // the user does not have open. A fallback is allowed; a hidden one
      // is not.
      const detail = String(err);
      console.warn(`[brain] route failed, falling back to router defaults: ${detail}`);
      const current = this.#router.currentModel;
      ctx.emit({
        type: "model_routed",
        sessionId,
        provider: current.provider,
        model: current.model,
        reason: "fallback",
        detail,
        traceId,
      });
      return null;
    }
  }

  /** Summarize older turns into a compact note (used by working-memory). */
  async #summarize(sessionId: string, msgs: ChatMessage[]): Promise<string> {
    if (!this.#router.isPrimaryLocal) {
      console.warn(
        "[cinderpaw:privacy] working-memory compression is sending transcript to cloud model:",
        this.#router.currentModel.model,
        "— set primary to a local engine to keep compression on-device",
      );
    }
    // The excerpt fed to the summarizer used to be `.slice(0, 6_000)` — the
    // FIRST 6000 chars of everything being compacted. On a multi-step task the
    // compacted region is tens of thousands of chars, so the summary described
    // the opening of the session and EVERY later fact (the paths just written,
    // the commands just run, the errors just fixed) was dropped on the floor.
    // That is the "forgets file paths it wrote earlier / repeats actions it
    // already completed" report. Head+tail sampling keeps the framing AND the
    // recent work; the head is small because the tail is what the next turn
    // needs. Raise CINDERPAW_SUMMARY_EXCERPT_CHARS on big-context models.
    const transcript = summaryExcerpt(msgs, cfgInt("CINDERPAW_SUMMARY_EXCERPT_CHARS") || 24_000);
    const res = await this.#router.complete({
      sessionId,
      messages: [
        {
          role: "system",
          content:
            "Summarize the following conversation excerpt for an agent that must " +
            "continue the task.\n\n" +
            "Start with a section headed exactly `### Established facts`, one line " +
            "per fact the agent DETERMINED and may be asked to report: a value it " +
            "read (line count, version, id, size), a path it created or edited and " +
            "its state, a command and its outcome, a URL, a decision already made. " +
            "Copy values EXACTLY. This section is the only record that survives — " +
            "a fact left out of it is a fact the agent must go and fetch again, and " +
            "on a long task it will fetch it again after every compaction.\n\n" +
            "Then a short narrative: what is DONE so it is not repeated, and what " +
            "is still open. Terse bullets, not prose. Never shorten the facts " +
            "section to make room for the narrative.\n\n" +
            "Finally, a section headed exactly `### Position`: two to four lines " +
            "on where the work stands RIGHT NOW — the step in progress, what is " +
            "next, and anything blocked. Write it as the note you would leave " +
            "yourself before walking away. This section is replaced wholesale " +
            "each time; the facts section above it is never rewritten.",
        },
        { role: "user", content: transcript },
      ],
      // 256 could not hold a path list. The summary is written once per
      // compaction and re-sent every turn afterwards, so it is worth the tokens
      // — SUMMARY_RESERVE_TOKENS in working.ts reserves room for it.
      //
      // 1024 was the whole budget INCLUDING a reasoning model's chain of
      // thought, and the thinking ate it. Observed verbatim in a stored
      // summary: `Summary of earlier conversation: <think>The user wants me to
      // summarize…` — cut off mid-deliberation, so the `### Established facts`
      // section that was supposed to follow never existed. The agent then had
      // no record of the 24 line counts it had just read and went back for them
      // again, every compaction.
      //
      // Reasoning is stripped below and never stored, so raising this ceiling
      // does NOT grow the summary or the prompt: it buys room to think on top of
      // a full answer, and SUMMARY_RESERVE_TOKENS keeps bounding what is kept.
      maxTokens: 3072,
      // Bypass the budget gate: this call exists to RECOVER from budget
      // pressure, so it must run even when the conversation is over budget.
      skipBudgetCheck: true,
    });
    const summary = summaryText(res.content);
    // The safety net. The agent is supposed to keep `note:position` current with
    // `remember`; this catches the run where it stopped bothering. Only ever this
    // one key — every other notebook entry is the agent's own and is never
    // rewritten by a model. Guarded because a failure here must not cost the
    // compaction, which is the thing actually recovering the context budget.
    if (this.#notebookWriter) {
      try {
        const position = extractPosition(summary);
        if (position !== null) this.#notebookWriter(sessionId, position);
      } catch {
        /* the summary still stands */
      }
    }
    return summary;
  }

  /**
   * Look up (or create) the WorkingMemory for a session, applying the
   * P2 eviction policy along the way.
   *
   * Two layers of protection against unbounded growth:
   *   1. TTL: every call sweeps the map and drops any session that
   *      hasn't been accessed in `#sessionIdleEvictMs` ms. Lazy
   *      (no background timer), bounded cost (at most `#sessions.size`
   *      checks, itself bounded by the LRU cap). A user who walks
   *      away and comes back within `sessionIdleEvictMs` keeps their
   *      transcript; one who returns after the window pays a one-time
   *      re-hydration cost (a fresh WorkingMemory, the prior
   *      conversation gone from RAM but not from episodic memory).
   *   2. LRU: when adding a new session would push the map past
   *      `#maxRetainedSessions`, the oldest entry (Map preserves
   *      insertion order, and we re-insert on every access) is
   *      evicted first. Worst-case bound: `#maxRetainedSessions`
   *      entries × WorkingMemory footprint, regardless of how many
   *      distinct sessionIds the caller churns through.
   */
  #memoryFor(sessionId: string): WorkingMemory {
    // Cheap when there's nothing to evict (the common case for an
    // active session). The for-of loop is the only allocation.
    this.#evictIdleSessions();

    let entry = this.#sessions.get(sessionId);
    if (!entry) {
      // Make room: evict the oldest until we're under the cap. The
      // re-checked `while` (vs `if`) handles the rare case where the
      // caller's `maxRetainedSessions` was lowered between config
      // updates; in steady state the loop runs at most once.
      while (this.#sessions.size >= this.#config.maxRetainedSessions) {
        const oldest = this.#sessions.keys().next().value;
        if (oldest === undefined) break; // defensive: empty map
        this.#sessions.delete(oldest);
        this.#sessionProfile.delete(oldest);
        this.#toolIntentSelection.delete(oldest);
      }
      // A profiled session (connector surface) runs under the profile's own
      // system prompt; the owner default uses the full prompt. Resolved at
      // creation only — the prompt is the static, cache-friendly prefix.
      const profile = this.#profileFor(sessionId);
      // Refresh first: a session created before the MCP servers finished
      // connecting would otherwise be pinned for its whole life to a system
      // prompt whose "Available tools" block predates them.
      this.#syncTools();
      // RSI champion style: the evolved prompt addendum rides the OWNER
      // prompt only (never a connector profile's persona) and is resolved
      // at session creation, so a mid-session ratchet can't churn the
      // cache-friendly static prefix of an active conversation.
      const championStyle = this.#championParams.systemPromptAddendum;
      // The notebook doctrine rides here rather than inside buildSystemPrompt
      // because it is session-scoped (see buildNotebookAddendum). Resolved once
      // at session creation like everything else in this prefix, so the
      // cache-friendly static head stays static.
      const ownerPrompt = [
        this.#systemPrompt,
        championStyle,
        buildWorkerAddendum(sessionId),
        buildNotebookAddendum(this.#registry, sessionId),
      ]
        .filter((s): s is string => !!s)
        .join("\n\n");
      const memory = new WorkingMemory(profile?.systemPrompt ?? ownerPrompt);
      // Re-hydrate the transcript from episodic memory. Without this a
      // session that was evicted (idle/LRU) or lost to a restart came back
      // amnesiac even though every turn is already on disk — "close Cinderpaw,
      // reopen, continue where you left off" never worked.
      //
      // Only CONVERSATIONS rehydrate. A machine session (cron job, RSI eval,
      // dream) reuses a stable synthetic sessionId across runs and is meant to
      // start clean every time; replaying the previous run's transcript into it
      // would burn tokens and steer the task with stale context.
      // `episodic.conversation()` handles which ROWS are replayable (no tool
      // rows, no extractor notes) — see its docstring.
      // Crash resume takes precedence over episodic replay. A `running`
      // checkpoint is a turn the sidecar died in the middle of; its stored
      // transcript is faithful (tool results included), where episodic is
      // lossy (tool output truncated to 400 chars). Restoring it lets the
      // model continue from the exact step it reached instead of redoing work.
      const resume = isReplayableSession(sessionId) ? this.#checkpoints?.loadRunning(sessionId) : null;
      if (resume && resume.messages.length > 0) {
        memory.restore(resume.messages);
        log(`checkpoint: resumed session ${sessionId} from iteration ${resume.iteration} (${resume.messages.length} messages)`);
      } else if (isReplayableSession(sessionId)) {
        // Tool rows are collapsed into a one-line note in front of the answer
        // they produced. Replaying them as real tool messages is not possible
        // (no call ids, output truncated to 400 chars), but dropping them —
        // which is what this did — left a transcript in which the agent had
        // never once opened a file, and the model copied that. The note costs a
        // few tokens per turn and restores the only thing that mattered:
        // evidence that looking things up is what happens here.
        //
        // The note is a TOOL row, never a prefix on the assistant message.
        // Prefixed to the answer (11d067a) it sat in the assistant's own voice,
        // and the model did the one thing that pattern teaches: it opened its
        // next reply with `[used shell_exec, list_tools, read_file ×3, grep]`
        // and fabricated everything after it, having called nothing. Evidence
        // written in the voice being imitated is not evidence, it is a
        // template — and worse than the fabrication it replaced, because the
        // fabrication now arrives wearing a receipt. `toProviderMessage`
        // renders a tool row as a user-role `[tool:…]` line, which is a channel
        // the model reads and never emits.
        let used: string[] = [];
        let lastUser = "";
        for (const ev of this.#episodic.conversation(sessionId, REHYDRATE_TURNS)) {
          if (ev.role === "tool") {
            used.push(ev.content.slice(0, ev.content.indexOf(":") + 1 || 40).replace(/:$/, ""));
            continue;
          }
          // Flushed before BOTH roles: tool rows trailing the last answer (a
          // turn that crashed mid-work) belong to the transcript too.
          const note = replayedToolNote(used);
          if (note) {
            memory.addToolResult("earlier_tool_use", note);
          } else if (ev.role === "assistant" && (claimedPath(ev.content) || claimedPath(lastUser))) {
            // An answer about a file that opened nothing. Noting the tools a
            // turn DID use fixes the turns that used some; it cannot touch
            // these, because there is nothing to note — and these are the
            // majority. Measured on the real poisoned session: 8 answers about
            // a file with no tool behind them against 5 with, including the
            // same "read X and summarise" answered confidently three times in
            // a row. Replay that and the transcript's own house style is
            // answering from memory; the model followed it exactly, making
            // ZERO tool calls in 3 of 3 runs where a clean session made 2-5.
            //
            // So the gap gets named instead of passing as normal. Same lane as
            // the tool note and for the same reason: it is the environment
            // speaking, and the model must never learn to write this line
            // itself. Recomputed here rather than stored, because the rows
            // that need it most were written long before the check existed.
            memory.addToolResult("earlier_answer", "unverified — no tool was used for this answer");
          }
          memory.addReplayed(ev.role === "user" ? "user" : "assistant", ev.content);
          if (ev.role === "user") lastUser = ev.content;
          used = [];
        }
      }
      entry = { memory, lastAccess: Date.now(), noProgress: new Map(), answerToolCalls: 0 };
      this.#sessions.set(sessionId, entry);
    } else {
      // Touch: delete + re-insert moves the entry to the tail of the
      // Map's iteration order, so it becomes "newest" for LRU. We
      // could use a doubly-linked list for O(1) LRU, but at 64 entries
      // the Map ops are cheaper than the bookkeeping.
      this.#sessions.delete(sessionId);
      entry.lastAccess = Date.now();
      this.#sessions.set(sessionId, entry);
    }
    return entry.memory;
  }

  /**
   * Drop sessions that have been idle longer than `#sessionIdleEvictMs`.
   * Called from `#memoryFor` on every access — no background timer, no
   * observable latency cost (at most 64 cheap timestamp comparisons).
   */
  #evictIdleSessions(): void {
    const cutoff = Date.now() - this.#config.sessionIdleEvictMs;
    for (const [sessionId, entry] of this.#sessions) {
      if (entry.lastAccess < cutoff) {
        this.#sessions.delete(sessionId);
        this.#sessionProfile.delete(sessionId);
        this.#toolIntentSelection.delete(sessionId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction & response parsing
// ---------------------------------------------------------------------------

/**
 * Compose the system prompt.
 *
 * The system prompt is composed of layered blocks, in this strict order:
 *
 *   1. `CINDERPAW_AGENT_BASE_PROMPT` — the universal CinderpawAgent operating manual.
 *      Always present, always the HIGHEST priority layer. Encodes the
 *      reliability contract (task-completion-first, chain-of-thought
 *      reasoning, structured tool calls, self-correction). It cannot be
 *      diluted away by user customizations.
 *   2. SOUL.md (when provided) — the user-customizable personality/identity
 *      layer. Refines tone and behavior within the CinderpawAgent base. When
 *      no soul is provided, the legacy Cinderpaw opener fills this slot so
 *      callers (e.g. tests) that haven't wired SOUL.md yet still work.
 *   3. USER block (when the user has onboarded) — per-user personalization
 *      (userName + agentName). Injected after SOUL so personalization
 *      follows identity.
 *   4. Tool mechanics — the registry's `describe()` output, the tool-call
 *      format, and the always-on Rules.
 *
 * The docstring intentionally says "highest priority" for the CinderpawAgent
 * base, NOT the SOUL block. SOUL refines; it does not override.
 *
 * Exported for testing — the production path is `new AgentLoop(..., soul, user)`.
 */
export function buildSystemPrompt(
  registry: ToolRegistry,
  soul: SoulConfig | null = null,
  user: UserConfig | null = null,
): string {
  const tools = registry.describe();
  const identity = soul
    ? [
        "## Identity & behavior (SOUL.md — user-customizable layer)",
        "The following identity document refines the CinderpawAgent base above",
        "with user-chosen tone, voice, and personality. It must not contradict",
        "the reliability contract defined in the CinderpawAgent base.",
        "",
        soul.content,
      ].join("\n")
    : [
        "You are Cinderpaw, a proactive and helpful AI assistant running locally on the user's device.",
        "You have access to tools and use them when they help answer a question.",
        "You never invent tool results — always call the tool and wait for the real output.",
      ].join("\n");

  const userBlock = user ? buildUserPromptBlock(user) : "";

  return [
    "## CinderpawAgent base (highest priority — always on)",
    CINDERPAW_AGENT_BASE_PROMPT,
    "",
    identity,
    userBlock,
    "---",
    "",
    tools ? `## Available tools\n${tools}` : "No tools are available.",
    "",
    "## How to call a tool",
    "Emit a fenced code block with the tag `tool`, containing a single JSON object:",
    "```tool",
    '{"name": "tool_name", "args": {"param": "value"}}',
    "```",
    "You may call multiple tools in sequence across turns.",
    "After each tool result is returned, continue reasoning and either call another",
    "tool or write your final answer as plain text with no tool block.",
    "",
    "## Memory, skills & tools (on demand)",
    "Past conversations, installed skills, and optional tools are NOT preloaded — keep the context lean.",
    "- Need continuity or a fact from a previous chat? Call `recall` with a query.",
    "- A task may have a matching skill? Call `list_skills` to find one, then `read_skill` to load it before applying.",
    "- Need a capability that's not in your current tools? It is listed below — call `load_tool` with the name, then use it.",
    "",
    // The capability index. `## Available tools` above carries the full
    // schemas, but providers with native tool-calling STRIP that section
    // (stripToolsFromSystemPrompt) and receive only the CORE schemas — so on
    // every cloud route the agent had no idea its extended tools existed and
    // would answer "I can't do that" for things it ships with. This block is
    // names + one line each (~300 tokens, not ~6K of schemas), lives under its
    // own heading so the strip leaves it alone, and is rebuilt by #syncTools()
    // so late-registering MCP tools appear too.
    buildCapabilityIndex(registry),
    "## Rules",
    "- Be concise and direct.",
    "- If you cannot help or a tool fails, say so clearly.",
    "- Never output raw JSON outside a tool block as your final answer.",
    "- Respond in the same language the user writes in.",
  ].filter((s) => s.length > 0).join("\n");
}

/**
 * The notebook doctrine, for a session that actually has a notebook.
 *
 * Separate from `buildSystemPrompt` for one reason: the doctrine's recursion
 * clause is only true at depth 0, and depth is a property of the SESSION, not
 * of the loop. A subagent's session id is `subagent:<parent>:<child>` and its
 * notebook binds no `rlm` (notebook.ts applies the same rule), so promising a
 * worker it can spawn workers would send it after a function that is not there.
 *
 * Returns "" when the notebook is not registered — which is the default, since
 * the tool only exists under CINDERPAW_ENABLE_NOTEBOOK. Nobody who has not turned
 * the notebook on pays a token for this.
 */
/** A subagent's session, by the id `Subagent.run` mints for it. */
export const isWorkerSession = (sessionId: string): boolean => sessionId.startsWith("subagent:");

/**
 * Tell a spawned worker that it is one.
 *
 * A subagent runs its own AgentLoop with `soul = null`, so it gets the default
 * identity — "You are Cinderpaw, a proactive and helpful AI assistant running
 * locally on the user's device" — and nothing else. It therefore answers as if
 * a person were reading, mid-conversation, and may ask a follow-up question
 * that reaches nobody: the parent gets the question as the answer.
 *
 * The text is upstream's `buildChildAgentDoctrine`, which was ported months ago
 * and, like the notebook doctrine beside it, was never wired to anything. It
 * applies to every subagent, not only to a worker `rlm()` spawned, because
 * `delegate_task` builds the child exactly the same way.
 */
export function buildWorkerAddendum(sessionId: string): string {
  return isWorkerSession(sessionId) ? `## You are a worker\n${WORKER_BRIEF}` : "";
}

export function buildNotebookAddendum(registry: ToolRegistry, sessionId: string): string {
  // Same degradation as buildCapabilityIndex: several callers pass a fake with
  // only `describe()`, and an optional section must not take the prompt down.
  if (typeof registry?.list !== "function") return "";
  const names = registry.list().map((t) => t.manifest.name);
  if (!names.includes(NOTEBOOK_TOOL_NAME)) return "";

  const isWorker = isWorkerSession(sessionId);
  return buildNotebookSection({
    // What the notebook actually injects: one identifier per tool, itself
    // excluded (repl.ts `exclude`), so the list the model reads is the list of
    // functions that exist.
    toolIdentifiers: names.filter((n) => n !== NOTEBOOK_TOOL_NAME).map(toIdentifier),
    depth: isWorker ? 1 : 0,
    allowRecursion: !isWorker,
  });
}

/**
 * The agent's index of everything it can do that is NOT advertised as a schema
 * this turn.
 *
 * Awareness and schemas are different problems, and conflating them is what
 * broke this: the drawer model correctly stopped sending ~28 tool schemas every
 * turn (5-8K tokens), but it also removed the only place the agent could learn
 * those tools EXIST. On a native-tool provider the `## Available tools` section
 * is stripped outright, so the agent saw the core set and nothing else — it
 * would tell the user "I can't run tests" while `run_tests` sat in the drawer.
 *
 * One line per tool, first sentence of the description only. Costs a few
 * hundred tokens instead of thousands, and turns `load_tool` from a guess into
 * a lookup. Returns "" when everything is already core (nothing to announce).
 */
export function buildCapabilityIndex(registry: ToolRegistry): string {
  // `describe()` is the only method the prompt strictly needs, and several
  // callers (tests, lightweight fakes) provide just that. Degrade to "no index"
  // rather than taking the whole prompt down over an optional section.
  if (typeof registry?.list !== "function") return "";
  const hidden = registry
    .list()
    .map((t) => t.manifest)
    .filter((m) => !isCoreTool(m.name))
    .filter((m) => !isConnectorTool(m.name));
  if (hidden.length === 0) return "";

  const line = (m: { name: string; description: string }): string => {
    // First sentence, capped — the index is a menu, not documentation.
    const gist = (m.description.split(/(?<=\.)\s/)[0] ?? m.description).trim();
    return `- \`${m.name}\` — ${gist.length > 140 ? `${gist.slice(0, 137)}…` : gist}`;
  };

  // Extension (MCP) tools are listed by NAME ONLY, and the reason is that they
  // are the one group whose size the user controls. Built-in drawer tools are a
  // fixed set we chose; MCP tools arrive with whatever servers someone installs,
  // and each description line costs ~40 tokens on EVERY completion, forever.
  // Measured on this machine: three servers, 41 tools, ~2.6K tokens per
  // completion — a person who installs ten servers would pay several thousand
  // for a menu they read once. Names survive because the name is what
  // `load_tool` takes and MCP tool names are verbose enough to be self-
  // describing (`mcp_send_discord_message`); the descriptions survive too, in
  // `list_tools`, one call away. Awareness is preserved; the per-turn rent is
  // not.
  const extensions = hidden.filter((m) => m.name.startsWith("mcp_"));
  const builtin = hidden.filter((m) => !m.name.startsWith("mcp_"));

  return [
    "## Your full capability index (load before use)",
    "These tools are installed and available to you RIGHT NOW, but their schemas",
    "are not loaded this turn to keep the context lean. To use one, call",
    '`load_tool` with its name (e.g. {"name": "load_tool", "args": {"names": ["run_tests"]}}),',
    "then call the tool normally on the next turn. NEVER tell the user you lack a",
    "capability that appears in this list — load it and do the work.",
    "",
    ...builtin.map(line),
    ...(extensions.length > 0
      ? [
          "",
          `From your installed extensions (${extensions.length}) — names only; call \`list_tools\` for what each one does:`,
          extensions.map((m) => `\`${m.name}\``).join(", "),
        ]
      : []),
  ].join("\n");
}

/**
 * A3: Convert the tool registry's manifest list into Anthropic native tool
 * definitions. Called once at AgentLoop construction; the result is cached in
 * `#nativeTools` and threaded into every main-loop `router.complete()` call.
 *
 * Only `AnthropicProvider` reads this field; all other providers ignore it.
 */
/**
 * The one line that puts the work back into a replayed answer.
 *
 * `["read_file", "read_file", "shell_exec"]` → `read_file ×2, shell_exec`
 * Empty in, empty out — a turn that genuinely used no tool must not be dressed
 * up as one that did, or the note becomes noise and stops meaning anything.
 *
 * Bare list, no `[used …]` wrapper: the caller emits it as a tool row, so the
 * wire already carries `[tool:earlier_tool_use] read_file ×2`. The wrapper was
 * there when this was prefixed onto the assistant's own text, which is exactly
 * the shape the model learned to reproduce instead of calling anything.
 */
export function replayedToolNote(names: string[]): string {
  if (names.length === 0) return "";
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return parts.join(", ");
}

export function buildNativeTools(registry: ToolRegistry): AnthropicToolDef[] {
  return registry.list().map((tool) => {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, param] of Object.entries(tool.parameters)) {
      // Prefer the full JSON Schema when the tool provides one (nested shapes
      // like ask_user's questions array); fall back to the flat pair.
      properties[key] = param.schema ?? { type: param.type, description: param.description };
      if (param.required !== false) required.push(key);
    }
    return {
      name: tool.manifest.name,
      description: tool.manifest.description,
      input_schema: { type: "object" as const, properties, required },
    };
  });
}

/**
 * A3 regression fix: Convert the tool registry's manifest list into
 * OpenAI-compatible native tool definitions. Called once at AgentLoop
 * construction; cached in `#openAITools` and threaded into every main-loop
 * `router.complete()` call. Read by `OpenAICompatibleProvider` and
 * `OllamaProvider`; all other providers ignore it.
 */
export function buildOpenAITools(registry: ToolRegistry): OpenAIToolDef[] {
  return registry.list().map((tool) => {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, param] of Object.entries(tool.parameters)) {
      // Prefer the full JSON Schema when the tool provides one (nested shapes
      // like ask_user's questions array); fall back to the flat pair.
      properties[key] = param.schema ?? { type: param.type, description: param.description };
      if (param.required !== false) required.push(key);
    }
    return {
      type: "function" as const,
      function: {
        name: tool.manifest.name,
        description: tool.manifest.description,
        parameters: { type: "object" as const, properties, required },
      },
    };
  });
}

/**
 * Strip reasoning/thinking blocks from a model's final answer.
 *
 * Local "thinking" models wrap chain-of-thought in tags the user must never see
 * in the answer area. The frontend splits these out of the *live* token stream,
 * but the agent loop's final answer (and the `done` event's content) is the
 * authoritative fallback used when streaming produced nothing — so it must be
 * stripped here too, or a degraded model that emits only `<think>` and stops
 * leaks the raw tag into the chat.
 *
 * Handles, in order:
 *   - paired  <think>…</think> / <thinking>…</thinking>   (any number)
 *   - Gemma   <|channel>thought … <|channel>response|end  (channel sections)
 *   - dangling <think> with no close → everything after it is reasoning, dropped
 *   - orphan stray tags left behind
 */
/**
 * How much of a tool result's BODY the summarizer needs to see. Its first line
 * is the fact; the body is the payload the fact came from, and the summarizer is
 * not being asked to re-derive anything from it.
 *
 * ponytail: one flat cap, not per-tool tuning. Raise it if a summary starts
 * missing something that was only inferable from a body.
 */
const TOOL_EXCERPT_CHARS = 400;

/**
 * The transcript excerpt handed to the summarizer.
 *
 * Structure BEFORE sampling. `headTail` cuts by character position, which is
 * blind to what a tool result is: its first line is the fact (`path — 227 lines,
 * 8618 bytes`), the rest is the payload it was extracted from. Feeding whole
 * bodies in meant 24 file reads produced ~90 KB, head+tail kept 24 KB, and 20 of
 * the 24 headers landed in the discarded middle.
 *
 * The summary said so itself, verbatim: "All other files' tool-header line counts
 * were TRIMMED from the visible excerpt". It wrote a correct, exact facts section
 * containing 4 of 24 facts — because 4 was all it was shown — and the agent went
 * back for the other 20, every compaction.
 *
 * Every tool result now contributes its header plus a bounded body excerpt, so
 * 24 headers cost ~1.4 KB together and cannot be sampled away.
 */
export function summaryExcerpt(
  msgs: { role: string; name?: string; content: string }[],
  budgetChars: number,
): string {
  const flattened = msgs
    .map((m) => {
      if (m.role !== "tool") return `${m.role}: ${m.content}`;
      const newline = m.content.indexOf("\n");
      const head = newline === -1 ? m.content : m.content.slice(0, newline);
      const body = newline === -1 ? "" : m.content.slice(newline + 1);
      const label = `tool(${m.name ?? "?"}): ${head}`;
      if (body.length === 0) return label;
      return body.length > TOOL_EXCERPT_CHARS
        ? `${label}\n${body.slice(0, TOOL_EXCERPT_CHARS)}…`
        : `${label}\n${body}`;
    })
    .join("\n");
  return headTail(flattened, budgetChars);
}

/**
 * What actually gets stored as a compaction summary.
 *
 * The summarizer's answer was the ONE completion in the loop that never went
 * through `stripThinking` — and it is the one that is stored and re-sent for the
 * rest of the session. A stored summary, verbatim: `Summary of earlier
 * conversation: <think>The user wants me to summarize…`, cut off
 * mid-deliberation, so the facts section it was going to write never existed.
 * The agent lost the 24 line counts it had just read and went back for them,
 * every compaction.
 *
 * Falling back to tags-off raw when stripping leaves nothing is deliberate: a
 * response truncated inside an unclosed `<think>` strips to empty, and an empty
 * summary discards the entire compacted region. That deliberation had the facts
 * in it — keeping it beats keeping nothing.
 */
export function summaryText(raw: string): string {
  const stripped = stripThinking(raw).trim();
  return stripped || raw.replace(/<\/?think(ing)?>/gi, "").trim();
}

/**
 * Pull the `### Position` section out of a compaction summary.
 *
 * Returns null when the section is absent or empty, and null MUST mean "leave
 * the existing note alone". A summarizer that skipped the section tells us
 * nothing about where the run is; blanking a good note on that basis would be
 * strictly worse than a slightly stale one.
 */
export function extractPosition(summary: string): string | null {
  // The whole heading LINE, not a prefix match: `indexOf("### Position")` also
  // fires on `### Positioning`, and lifting an unrelated section into the
  // notebook is worse than leaving the old note — the note is what the next turn
  // navigates by.
  const heading = /^[ \t]*###[ \t]+Position[ \t]*$/m.exec(summary);
  if (!heading) return null;
  const after = summary.slice(heading.index + heading[0].length);
  // Stop at the next heading — the position section is the only part of the
  // summary that gets rewritten, so it must not absorb the facts around it.
  const end = after.search(/\n[ \t]*#{1,6}[ \t]/);
  const body = (end === -1 ? after : after.slice(0, end)).trim();
  return body.length > 0 ? body : null;
}

// `stripThinking` now lives in its own module so the RSI eval path can reuse it
// without importing the whole agent loop. It is imported at the top of this
// file and re-exported here, so every existing caller and test that imports it
// from `agent-loop.ts` keeps working unchanged.
export { stripThinking };

/**
 * Parse a model response into free text plus any tool calls.
 *
 * Accepted formats (tried in order):
 *   1. Fenced block tagged `tool` or `json` — the canonical format
 *   2. Any fenced block containing a valid tool-call JSON object
 *   3. A bare JSON object on its own line containing `name`/`args`
 *   4. A bare JSON object that is the entire response
 *
 * Malformed blocks are silently ignored; partial / extra text around a tool
 * call is preserved as the text portion.
 */
/**
 * Stream-holdback openers: the first occurrence of any of these in a live
 * completion stops chunks from reaching the UI until parseResponse decides
 * whether the tail was a tool call (drop — the pill events render it),
 * malformed garbage (drop — the retry nudge handles it), or prose (flush).
 * Mirrors the shapes parseResponse/extractBareToolCalls recognise.
 */
export const STREAM_HOLD_OPENERS = [
  "<tool_call",
  "<invoke",
  '{"name',
  '{"tool',
  '{"invoke',
  // The canonical instructed format is a ```tool fence (see buildSystemPrompt's
  // "How to call a tool"). Hold it back too so the fence never flashes mid-
  // stream before the call is parsed out. Safe: "```tool" is never a real code
  // language, so this can't stall a genuine code block (unlike "```json").
  "```tool",
  // MiniMax M3 tool-call framing leaking as literal text (see MINIMAX_DEBRIS).
  "]<]minimax[>[",
] as const;
export const STREAM_HOLD_MAX_OPENER = Math.max(
  ...STREAM_HOLD_OPENERS.map((o) => o.length),
);

/**
 * First keys that mark a bare JSON object as a tool-call attempt. Must stay
 * in sync with `extractBareToolCalls`'s `startRe` — the test
 * "every bare-call key is both held back and parsed" is what enforces that,
 * because drift between the two is a user-visible bug, not a style issue:
 *
 * `startRe` tolerates whitespace after the brace (`{ "name":`, `{\n "name":`)
 * but STREAM_HOLD_OPENERS only listed the tight literals `{"name` / `{"tool` /
 * `{"invoke`. A pretty-printing model therefore emitted a call that parsed
 * and executed correctly — AFTER the raw JSON had already streamed into the
 * user's chat. Correct behaviour, visible garbage.
 */
export const BARE_CALL_KEYS = ["tool_name", "name", "tool", "invoke"] as const;

/**
 * Index of a `{` that is, or could still become, a bare tool-call opener.
 * Returns -1 when no brace in `s` qualifies.
 *
 * A brace qualifies when what follows it — after optional whitespace and an
 * optional quote — either matches one of {@link BARE_CALL_KEYS} or is a
 * strict prefix of one at the end of the buffer (the key is still arriving
 * token by token). Holding a prefix that never completes is harmless: the
 * text is flushed verbatim by `resolve(true)`, just at end-of-completion
 * instead of mid-stream.
 */
export function braceOpenerAt(s: string): number {
  for (let i = s.indexOf("{"); i >= 0; i = s.indexOf("{", i + 1)) {
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j]!)) j++;
    if (j >= s.length) return i; // ran out mid-whitespace — may still qualify
    if (s[j] === '"') j++;
    if (j >= s.length) return i; // ran out right after the quote
    const rest = s.slice(j);
    for (const key of BARE_CALL_KEYS) {
      if (rest.startsWith(key)) return i;
      // Partial key at the very end of the buffer: more tokens may complete it.
      if (key.startsWith(rest)) return i;
    }
  }
  return -1;
}

/**
 * Stream holdback state machine. `push(token)` forwards prose to `emit`
 * but stops at the first tool-call opener (handling openers split across
 * token boundaries); `resolve(wasProse)` flushes the held tail to `emit`
 * when the finished completion turned out to be plain prose, or drops it
 * when it was a (possibly malformed) tool call.
 */
export function createStreamHoldback(rawEmit: (text: string) => void): {
  push: (token: string) => void;
  settle: (visible: string) => void;
} {
  let held = "";
  let holding = false;
  // What the person has actually been shown. `settle` needs it to work out
  // what is still missing; a length alone would be enough only while the
  // stream and the parsed answer agree, which is exactly the case that does
  // not need fixing.
  let emitted = "";
  const emit = (text: string) => {
    emitted += text;
    rawEmit(text);
  };
  const openerAt = (s: string): number => {
    let best = -1;
    for (const o of STREAM_HOLD_OPENERS) {
      const idx = s.indexOf(o);
      if (idx >= 0 && (best < 0 || idx < best)) best = idx;
    }
    // Whitespace-tolerant bare-call braces, which the literal list misses.
    const brace = braceOpenerAt(s);
    if (brace >= 0 && (best < 0 || brace < best)) best = brace;
    return best;
  };
  // Longest suffix of `s` that is a strict prefix of an opener — kept back
  // so an opener split across token boundaries is still caught.
  const tailKeep = (s: string): number => {
    const max = Math.min(s.length, STREAM_HOLD_MAX_OPENER - 1);
    for (let k = max; k > 0; k--) {
      const tail = s.slice(-k);
      if (STREAM_HOLD_OPENERS.some((o) => o.length > k && o.startsWith(tail))) return k;
    }
    return 0;
  };
  return {
    push(token: string) {
      if (holding) {
        // Keep accumulating while held — if resolve() decides this was
        // prose after all, the WHOLE tail must flush, not just the opener.
        held += token;
        return;
      }
      held += token;
      const idx = openerAt(held);
      if (idx >= 0) {
        if (idx > 0) emit(held.slice(0, idx));
        held = held.slice(idx);
        holding = true;
        return;
      }
      const keep = tailKeep(held);
      if (held.length > keep) {
        emit(held.slice(0, held.length - keep));
        held = held.slice(held.length - keep);
      }
    },
    /**
     * Show whatever the parser says was prose and the stream has not shown yet.
     *
     * This used to be `resolve(wasProse: boolean)`, and the boolean is what
     * lost people's text. Holding LATCHES on the first opener it sees, and one
     * of those openers is a `{` followed by `name`/`tool`/`invoke` — which a
     * model writes in ordinary narration ("the setting looks like
     * {name: 'x'}"). From that brace to the end of the turn everything was
     * held; if the turn then ended in a real tool call, `resolve(false)` threw
     * the whole buffer away, prose included. The reported symptom was an answer
     * cut off just before a tool call, and it was worst in exactly the turns
     * where the model explains what it is about to do.
     *
     * `visible` is the parser's own account of the turn's free text, so this
     * cannot re-leak a tool call: whatever the parser scrubbed is not in it.
     * When the two disagree about what was already sent — the stream showed
     * something the parser later scrubbed — nothing more is emitted, because
     * the alternative is showing it twice.
     */
    settle(visible: string) {
      // `parsed.text` is trimmed and the stream is not, so a turn whose answer
      // begins with a blank line would fail a bare `startsWith` and flush
      // nothing — turning the fix into a no-op on exactly the turns a model
      // pads. Compare against the shown text with its leading whitespace
      // dropped; what was already shown is untouched either way.
      const shown = emitted.trimStart();
      if (visible.startsWith(shown)) {
        const rest = visible.slice(shown.length);
        if (rest !== "") emit(rest);
      }
      held = "";
      holding = false;
      emitted = "";
    },
  };
}

/**
 * MiniMax M3's native tool-call tag delimiter, decoded literally by the
 * OpenAI-compatible endpoint instead of as a control token. Never valid prose.
 */
export const MINIMAX_DEBRIS = "]<]minimax[>[";

/**
 * Parse Anthropic-style `<invoke name="tool"><arg>value</arg></invoke>` XML
 * into real tool calls.
 *
 * Models fall back to this shape unprompted — MiniMax M3 switches to it
 * mid-task, and it is the native format for several others. The loop used to
 * only SCRUB it and ask (via the malformed nudge) for JSON instead. The bench
 * settled whether asking is enough: it is not. `ads-campaign-triage` re-emitted
 * the same XML on every retry, burned the retry budget and finished having
 * changed nothing — 3 of 9 runs, in a task whose whole point is measuring
 * damage to a live account. Reading the format the model actually speaks is
 * strictly better than losing the turn insisting on ours.
 *
 * `<item>` children make an array (`<argv><item>cmd</item></argv>`); a value
 * that parses as JSON becomes that value; everything else stays a string.
 * A missing `</invoke>` (truncated stream) still yields the call — the args
 * gathered so far are better than nothing, and a wrong-arity call surfaces as
 * a tool error the model can see and correct.
 */
export function parseInvokeXml(input: string): ParsedToolCall[] {
  const coerce = (body: string): unknown => {
    if (/<item>/.test(body)) {
      return [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => coerce(m[1] ?? ""));
    }
    const text = body.trim();
    if (/^[[{]|^-?\d|^(true|false|null)$/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        /* not JSON after all — fall through to the raw string */
      }
    }
    return text;
  };

  const calls: ParsedToolCall[] = [];
  // The namespace prefix is optional and it is not cosmetic. A model imitating
  // Anthropic's own wire format writes `<invoke>`; the 8h run's first
  // turn produced `<atem:invoke>`, close enough to be obviously the same
  // intent and far enough to miss a matcher anchored on a bare tag. Thirty-one
  // good calls in our syntax, then one in this one, delivered to the person as
  // raw markup.
  // The final alternative used to be just `$`, so an invoke the model never
  // closed swallowed everything to the end of the message — including any
  // LATER `<invoke>`, which was then never seen at all: a turn that asked for
  // three tools ran one. Stopping at the next opener keeps the tolerance for a
  // missing closer without letting one call eat its siblings.
  const invokeRe = /<(?:[A-Za-z_][\w.-]*:)?invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:<\/(?:[A-Za-z_][\w.-]*:)?invoke>|(?=<(?:[A-Za-z_][\w.-]*:)?invoke\s)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(input)) !== null) {
    const name = m[1];
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const body = m[2] ?? "";
    // Shape 1, and the one this function was named after: `<parameter
    // name="path">value</parameter>`. It is what Anthropic's format actually
    // looks like, and it was the one shape the parser could not read — the
    // docstring claimed the format by name while only the simplified variant
    // below was implemented.
    // `[^>]*` after the name, not `\s*`: DeepSeek v4 writes a type hint as a
    // second attribute (`<parameter name="query" string="true">`). Anchoring
    // straight to `>` read that tag as prose and the call lost its arguments —
    // which is worse than not parsing it at all, because a tool then runs with
    // an empty argument set instead of visibly failing.
    const namedRe = /<(?:[A-Za-z_][\w.-]*:)?parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?parameter>/g;
    let np: RegExpExecArray | null;
    while ((np = namedRe.exec(body)) !== null) {
      args[np[1] as string] = coerce(np[2] ?? "");
    }
    // Shape 2: the argument name IS the tag (`<argv><item>cmd</item></argv>`).
    // Backreferenced closer, so a parameter's body is consumed whole — nested
    // <item> tags belong to their parent and must not be read as parameters.
    // Skipped entirely once shape 1 matched, so a `<parameter>` tag is never
    // also read as an argument literally called "parameter".
    if (Object.keys(args).length === 0) {
      const paramRe = /<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g;
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(body)) !== null) {
        if (p[1] === "item") continue;
        args[p[1] as string] = coerce(p[2] ?? "");
      }
    }
    // A bare opener with no arguments and no closer is an ANNOUNCEMENT, not a
    // call — the model wrote "<invoke name="write_file">" and stopped. Running
    // it would mean write_file with no path. A closed invoke with no args is
    // different and legitimate: the zero-arg tools (time_date, self_health).
    if (!/<\/(?:[A-Za-z_][\w.-]*:)?invoke>$/.test(m[0]) && Object.keys(args).length === 0) continue;
    calls.push({ name, args });
  }
  return calls;
}

/**
 * Last-resort pass: the vendored OpenClaw repair scanner.
 *
 * Runs only after every pass above has failed, and only when the whole message
 * parses as tool-call blocks — so it can add calls we would otherwise lose, but
 * can never reinterpret prose that an earlier pass already understood.
 *
 * `allowedToolNames` is what makes this safe to run at all: an unrecognised
 * name is rejected instead of invented. Callers pass the live registry; without
 * it the scanner still works, but nothing constrains a hallucinated name, so
 * the loop always supplies one.
 */
function repairWithVendoredScanner(
  text: string,
  allowedToolNames?: Iterable<string>,
): ParsedToolCall[] {
  try {
    const opts = allowedToolNames ? { allowedToolNames } : undefined;
    let blocks = parseStandalonePlainTextToolCallBlocks(text, opts);
    if (!blocks && text.includes("to=functions.")) {
      // Harmony's namespaced form. The scanner's tool-name charset stops at the
      // dot, so `to=functions.exec_command` never resolves — and that is the
      // shape Hermes documents for GPT-OSS, i.e. the common one in the wild.
      // Normalised HERE rather than in the vendored file so upgrading that file
      // stays a re-copy instead of a merge.
      blocks = parseStandalonePlainTextToolCallBlocks(
        text.split("to=functions.").join("to="),
        opts,
      );
    }
    return (blocks ?? []).map((b) => ({ name: b.name, args: b.arguments }));
  } catch {
    // A repair pass must never cost the turn it is trying to save.
    return [];
  }
}

export function parseResponse(raw: string, allowedToolNames?: Iterable<string>): ParsedResponse {
  const toolCalls: ParsedToolCall[] = [];
  let text = raw;

  // Pass 0: <tool_call>...</tool_call> tags — the canonical format: local
  // grammar-constrained decoding emits it, and the providers re-encode
  // cloud-native tool calls into it.
  //
  // The inner pattern forbids a nested "<tool_call>", anchoring each match
  // at the INNERMOST opening tag. Models sometimes emit a dangling
  // "<tool_call>" as prose right before the server switches to native
  // tool-call deltas (observed with MiniMax M3 on an OpenAI-compatible
  // API); the provider then appends its canonical tag, producing
  // "… <tool_call>\n<tool_call>{json}</tool_call>". A naive non-greedy
  // match anchors at the dangling tag, captures "\n<tool_call>{json}" as
  // the body, fails to parse, and the call surfaces as raw text in the
  // chat instead of executing.
  const toolCallTag = /<tool_call>((?:(?!<tool_call>)[\s\S])*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  // Blocks that failed to parse while siblings succeeded. Counted, not
  // discarded: see ParsedResponse.droppedToolCalls — losing one call out of a
  // batch and reporting success is how three lead imports become one.
  let dropped = 0;
  while ((match = toolCallTag.exec(raw)) !== null) {
    const block = parseCallBlock(match[1]?.trim() ?? "");
    toolCalls.push(...block.calls);
    dropped += block.dropped;
    text = text.replace(match[0], "").trim();
  }

  if (toolCalls.length > 0) {
    // Sweep orphan tags (the dangling "<tool_call>" prose case above, or a
    // stray closer) so they never reach the UI or the stored transcript.
    text = text.replace(/<\/?tool_call>/g, "").trim();
    return { text, toolCalls, malformedToolCall: false, droppedToolCalls: dropped };
  }

  // Pass 1 (narrow): bare tool-call JSON in the content. Grammar-constrained
  // local inference normally guarantees  tool_call tags, but models on
  // plain OpenAI-compatible APIs (observed: MiniMax M3) still emit
  // `{"name":"read_skill","args":{…}}` — sometimes several in a row, and
  // sometimes corrupted (`{"name="read_skill">`). Without this pass the raw
  // JSON was displayed verbatim in the chat instead of executing.
  //
  // Unlike the removed legacy passes, this one only fires on objects whose
  // FIRST key is name/tool (the tool-call signature), and never inside code
  // fences — JSON in prose ({"port": 8080, …}) is untouched.
  // XML-style invoke openers (`<invoke name="write_file">`) are another
  // observed malformed-call shape: some models fall back to Anthropic-style
  // function-call XML the loop never taught them. Scrub and flag so the turn
  // is retried instead of ending mid-task with the tag in the visible text.
  let preScrubbed = raw.replace(/<\/?tool_call>/g, "");

  // Strip the debris FIRST: it sits between the XML tags, so the invoke parser
  // below cannot see the structure until it is gone.
  const hadMinimaxDebris = preScrubbed.includes(MINIMAX_DEBRIS);
  if (hadMinimaxDebris) {
    preScrubbed = preScrubbed.split(MINIMAX_DEBRIS).join("");
  }

  // DeepSeek's DSML framing (observed live 2026-08-29, DeepSeek v4 Flash via
  // OpenRouter, on a plain web-search request): structurally the same
  // Anthropic-style invoke XML the parser below already reads, but every tag
  // is fenced with U+FF5C FULLWIDTH VERTICAL LINE —
  //
  //     <｜DSML｜tool_calls><｜DSML｜invoke name="web_search">
  //       <｜DSML｜parameter name="query" string="true">…</｜DSML｜parameter>
  //     </｜DSML｜invoke></｜DSML｜tool_calls>
  //
  // The namespace tolerance below is `[A-Za-z_][\w.-]*:` — an ASCII name and a
  // colon — so `｜DSML｜` slips past every matcher and the whole block was
  // delivered to the person as raw markup instead of running the search.
  // Normalising the fence here rather than widening each regex keeps the one
  // shape the rest of this function is written against.
  preScrubbed = preScrubbed.replace(/<(\/?)｜DSML｜/g, "<$1");

  // Namespace-tolerant everywhere `invoke` is looked for. The gate used to be
  // `/<\/?invoke\b/`, which a prefixed tag slips straight past — so the parser
  // below was never even asked about the shape it was written to read.
  // The wrapper (`<…function_calls>`) goes too; left behind it is markup the
  // person reads as the answer.
  const hadInvokeXml = /<\/?(?:[A-Za-z_][\w.-]*:)?invoke\b/.test(preScrubbed);
  if (hadInvokeXml) {
    // Read it rather than reject it — see parseInvokeXml.
    const xmlCalls = parseInvokeXml(preScrubbed);
    if (xmlCalls.length > 0) {
      return {
        text: preScrubbed
          .replace(/<(?:[A-Za-z_][\w.-]*:)?invoke[\s\S]*?(?:<\/(?:[A-Za-z_][\w.-]*:)?invoke>|$)/g, "")
          // `tool_calls` alongside `function_calls`: DeepSeek wraps its invokes
          // in the former. Left behind, the wrapper is markup the person reads
          // as the answer — the exact leak this branch exists to prevent.
          .replace(/<\/?(?:[A-Za-z_][\w.-]*:)?(?:function_calls|tool_calls)>/g, "")
          .trim(),
        toolCalls: xmlCalls,
        malformedToolCall: false,
        droppedToolCalls: 0,
      };
    }
    preScrubbed = preScrubbed.replace(/<\/?(?:[A-Za-z_][\w.-]*:)?invoke\b[^>\n]*>?/g, "");
  }

  // Debris with no recoverable <invoke> structure around it (a lone sentinel,
  // or args whose opener was lost to truncation). Nothing to execute, but the
  // sentinel only ever appears inside tool-call framing — so the turn was an
  // attempted call, not prose, and must be retried rather than returned.
  const scrubbed = extractBareToolCalls(preScrubbed);

  // Nothing we understand natively. Hand the raw text to the vendored scanner,
  // which knows the shapes we do not: <function=…>, [tool:name], Harmony
  // channels. A hit here is a real call the turn would otherwise have thrown
  // away as prose.
  if (scrubbed.calls.length === 0) {
    const repaired = repairWithVendoredScanner(raw, allowedToolNames);
    if (repaired.length > 0) {
      return {
        text: stripPlainTextToolCallBlocks(raw).trim(),
        toolCalls: repaired,
        malformedToolCall: false,
        droppedToolCalls: 0,
      };
    }
  }
  // A <tool_call> opener with no parseable call inside also counts as a
  // malformed attempt — the model opened a call and never produced valid JSON.
  // An orphan CLOSER counts too: when the opener is lost to a truncated
  // stream what remains is a naked JSON tail plus `</tool_call>`.
  const danglingTag = scrubbed.calls.length === 0 && /<\/?tool_call>/.test(raw);
  return {
    text: scrubbed.text.trim(),
    toolCalls: scrubbed.calls,
    malformedToolCall:
      scrubbed.malformed ||
      danglingTag ||
      (scrubbed.calls.length === 0 && (hadInvokeXml || hadMinimaxDebris)),
    droppedToolCalls: 0,
  };
}

/**
 * Scan text outside code fences for objects starting with a name/tool key.
 * Valid objects become tool calls; corrupted ones (malformed JSON that is
 * still unmistakably a tool-call attempt) are removed from the visible text
 * so raw JSON never reaches the user.
 */
function extractBareToolCalls(input: string): {
  text: string;
  calls: ParsedToolCall[];
  malformed: boolean;
} {
  const calls: ParsedToolCall[] = [];
  let malformed = false;
  // Split on fence markers; even segments are outside fences and get
  // scanned, odd segments (fenced code) pass through untouched.
  const segments = input.split(/(```[\s\S]*?(?:```|$))/);
  const out: string[] = [];

  // `"?` and `[:=]` tolerate the observed corruption {"name="tool"> where
  // the colon was emitted as `=`. The `invoke` branch catches the JSON/XML
  // hybrid {"invoke name="write_file"> (model imitating Anthropic-style
  // invoke XML with a brace) — unparseable, but unmistakably a call attempt.
  // `tool_name` is the third observed shape ({"tool_name":"write_file",
  // "arguments":{…}}): the old alternation matched `tool` and then demanded
  // `[:=]`, hit the `_`, and gave up — so the whole call was rendered to the
  // user as raw JSON instead of executing.
  const startRe = /\{\s*"?(?:(?:tool_name|name|tool)"?\s*[:=]|invoke\b)/g;

  // Scan one out-of-fence chunk: pull out every tool-call object, hide
  // corrupted fragments, return the surviving prose.
  const scan = (seg: string): string => {
    let cursor = 0;
    let kept = "";
    while (cursor < seg.length) {
      startRe.lastIndex = cursor;
      const m = startRe.exec(seg);
      if (!m) {
        kept += seg.slice(cursor);
        break;
      }
      kept += seg.slice(cursor, m.index);
      const rest = seg.slice(m.index);
      const end = findJsonEnd(rest);
      const call = end >= 0 ? tryParseCall(rest.slice(0, end + 1)) : null;
      if (call) {
        calls.push(call);
        cursor = m.index + end + 1;
      } else {
        // Corrupted tool-call fragment: hide it. Drop through the end of the
        // JSON-ish run — the matched object if one closed, else end of line.
        malformed = true;
        const lineEnd = seg.indexOf("\n", m.index);
        cursor =
          end >= 0
            ? m.index + end + 1
            : lineEnd >= 0
              ? lineEnd
              : seg.length;
      }
    }
    return kept;
  };

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (s % 2 === 1) {
      // Fenced block. Cloud models (observed: MiniMax M3) sometimes wrap a
      // tool call in a ```json / ```tool fence — the same fences
      // TOOL_CALL_TRIGGERS treats as canonical openers — instead of using
      // native tool-calling. Unwrap and scan such a fence so the call runs.
      // Every other fence (real code, {"port":8080} JSON-in-prose) is left
      // untouched: we only enter here when the interior starts with a
      // name/tool object.
      const inner = seg
        .replace(/^```[^\n]*\n?/, "")
        .replace(/\n?```[ \t]*$/, "");
      if (/^\s*\{\s*"?(?:tool_name|name|tool)"?\s*[:=]/.test(inner)) {
        out.push(scan(inner));
      } else {
        out.push(seg);
      }
      continue;
    }
    out.push(scan(seg));
  }

  return { text: out.join(""), calls, malformed };
}

/**
 * Every top-level JSON object inside ONE `<tool_call>` block.
 *
 * Models batch parallel calls by stacking objects in a single block rather than
 * opening a second tag:
 *
 *     <tool_call>
 *     {"name":"http_request","args":{…pause…}}
 *     {"name":"http_request","args":{…budget…}}
 *     </tool_call>
 *
 * `tryParseCall` returns the FIRST object and silently discards the rest, which
 * is how "pause the losing campaign and raise the winner's budget" executed only
 * the pause — and, because nothing was counted as dropped, the model was told
 * nothing and reported both done. Measured on the walk-away bench, where the
 * model's own words were "Both calls succeeded."
 *
 * A malformed object is COUNTED, never skipped: droppedToolCalls is what makes
 * the loop tell the model which calls never ran.
 */
function parseCallBlock(body: string): { calls: ParsedToolCall[]; dropped: number } {
  const calls: ParsedToolCall[] = [];
  let dropped = 0;
  let rest = body.trim();

  while (rest.startsWith("{")) {
    const end = findJsonEnd(rest);
    if (end < 0) {
      // Truncated object — the stream was cut mid-call.
      dropped++;
      break;
    }
    const call = tryParseCall(rest.slice(0, end + 1));
    if (call) calls.push(call);
    else dropped++;
    rest = rest.slice(end + 1).trim();
  }

  // The block held no JSON at all (prose, an array, an XML hybrid). One
  // malformed call, which is what the single-object path always reported.
  if (calls.length === 0 && dropped === 0) dropped = 1;
  return { calls, dropped };
}

function tryParseCall(candidate: string): ParsedToolCall | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("{")) return null;

  // Find the first complete JSON object (handles trailing text after the object)
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Try to extract just the first JSON object if there's trailing text
    const end = findJsonEnd(trimmed);
    if (end < 0) return null;
    try {
      obj = JSON.parse(trimmed.slice(0, end + 1));
    } catch {
      return null;
    }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const record = obj as Record<string, unknown>;
  // Support {"name":..,"args":..}, {"tool":..,"args":..}, {"tool":..,"parameters":..},
  // {"tool_name":..,"arguments":..}
  const name = record.name ?? record.tool ?? record.tool_name;
  if (typeof name !== "string" || !name.trim()) return null;

  const rawArgs = record.args ?? record.arguments ?? record.parameters ?? record.input ?? {};
  const args =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  return { name: name.trim(), args };
}


/** Find the index of the closing brace of the first top-level JSON object. */
function findJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Heuristic: true when the user message is long enough that a single-pass
 * answer is unlikely to suffice.
 *
 * P7 fix: the previous implementation keyword-matched on "research",
 * "analyze", "compare", "audit", "report", "overview", "every", "multiple",
 * and ~20 more common English words. That flipped routine user messages
 * ("can you audit this report?") into long-iteration deep mode and burned
 * the local model's context for no reason. Keyword matching is gone.
 *
 * Signals that DO still count:
 *   - message is long (> 60 words) — implies a multi-part or detailed request
 *     the model is unlikely to satisfy in one round.
 *
 * For explicit "I want deep mode" opt-in, callers should use a prefix or
 * flag (e.g. `/deep <task>`) — not a heuristic on the natural language.
 */
export function isComplexTask(text: string): boolean {
  const wordCount = text.trim().split(/\s+/).length;
  return wordCount > 60;
}

/**
 * Validate and clamp Controls-panel inference overrides coming from the host.
 * Non-numeric values are dropped; numbers are clamped to safe ranges so a
 * buggy or malicious host message can't request a 10M-token completion or a
 * NaN temperature.
 */
export function sanitizeInferParams(raw: {
  temperature?: unknown;
  max_tokens?: unknown;
}): { temperature?: number; maxTokens?: number } {
  const out: { temperature?: number; maxTokens?: number } = {};
  if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
    out.temperature = Math.min(2, Math.max(0, raw.temperature));
  }
  if (typeof raw.max_tokens === "number" && Number.isFinite(raw.max_tokens)) {
    out.maxTokens = Math.min(32_768, Math.max(128, Math.floor(raw.max_tokens)));
  }
  return out;
}

/**
 * Keep the head and (mostly) the tail of an oversized excerpt, with an explicit
 * elision marker in between. A plain head-slice loses exactly the recent work
 * the next turn depends on; a plain tail-slice loses the task framing.
 * ponytail: 25/75 split, no smarter selection — the summarizer reads both ends.
 */
/**
 * Wall-clock budget for one agent turn, in ms.
 *
 * ponytail: 20 min covers every real multi-step task observed (a 5-file project
 * with tests lands well under it) while capping a wedged loop at something a
 * human will wait through. Raise with CINDERPAW_TURN_BUDGET_MS on a box doing
 * genuinely long builds; the bound only stops NEW iterations, so a single slow
 * tool is never cut off mid-run.
 */
export function turnBudgetMs(): number {
  const raw = cfgInt("CINDERPAW_TURN_BUDGET_MS");
  if (!Number.isFinite(raw) || raw <= 0) return 20 * 60_000;
  return Math.min(6 * 3_600_000, Math.max(60_000, raw));
}

/**
 * How many recent tool calls the no-progress detector remembers. Six covers
 * the cycles models actually get stuck in (A,A,A through A,B,C,A,B,C) without
 * flagging a legitimate re-read of the same file later in a long task.
 *
 * ponytail: fixed window, no decay. Raise if long multi-file tasks start
 * tripping it; the symptom would be the nudge firing on honest repeat reads.
 */
export const LOOP_WINDOW = 6;

/**
 * Hard stop for a *proven* no-progress loop: the same tool, the same arguments,
 * AND the same result, this many times in one turn.
 *
 * The `LOOP_WINDOW` nudge above is argument-only, so it fires as a warning and
 * then trusts the model to change course. When the model ignores it, nothing
 * stopped the turn short of `ABSOLUTE_CEILING` (500 iterations) or the wall
 * clock — on a cloud provider that is real money spent re-running an identical
 * call. Identical args + identical output is not a heuristic: it is definitionally
 * zero progress, so blocking on it cannot false-positive the way an
 * argument-only rule can (a poll whose output changes keeps running freely).
 *
 * Deliberately far higher than the nudge threshold (3): the model gets warned,
 * gets a long chance to recover, and only then is stopped.
 *
 * ponytail: 20, not 6. A poll that legitimately reports `{"status":"running"}`
 * with byte-identical output IS honest waiting, and a low threshold would cut it
 * off — the false positive an outcome-only rule can still produce. 20 sits above
 * any plausible legitimate identical-repeat run while still saving 480 iterations
 * against ABSOLUTE_CEILING. Lower it only with evidence that real loops are
 * running long; the symptom of it being too low is a stopped turn whose tool was
 * genuinely waiting on something.
 */
export const NO_PROGRESS_STOP = 20;

/**
 * The same tool, the same failure text, this many times — however the arguments
 * differed.
 *
 * Three, where the argument-keyed stop is twenty, because the evidence is much
 * stronger: twenty is the bar for "this repeat is unproductive", and a tool
 * returning byte-identical failure text to three genuinely different inputs has
 * already said the input is not what it is reacting to. Two would be too eager —
 * a search engine can plausibly fail twice on unrelated queries.
 */
export const TOOL_WIDE_FAILURE_STOP = 3;

/**
 * Stable digest of a rendered tool result, for no-progress detection.
 *
 * sha1 over the full text: tool output runs to 64 KB (read_file), and keeping
 * whole results in the per-turn map would hold the transcript twice in RAM.
 * Not security-sensitive — it only needs to be stable and collision-shy across
 * one turn's results.
 *
 * `surrogatepass`-equivalent guard: web-scraped tool output can carry unpaired
 * UTF-16 surrogates, and a strict encode of those throws. A digest failure must
 * cost detection accuracy, never the turn — so it degrades to a length key.
 */
export function resultDigest(rendered: string): string {
  try {
    return createHash("sha1").update(rendered, "utf8").digest("hex");
  } catch {
    return `len:${rendered.length}`;
  }
}

/** Stable key for a tool call's arguments. Model-supplied args are always
 *  JSON-safe, but a throw here would kill the turn — so it degrades to a
 *  constant instead, costing detection accuracy, never the conversation. */
export function safeArgsKey(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "[unserializable]";
  }
}

export function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n…[middle of the excerpt elided]…\n";
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * 0.25);
  const tail = budget - head;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function errorMessage(err: unknown): string {
  if (err instanceof BudgetExhaustedError) {
    return `Token budget exhausted (${err.reason}). ${err.message}`;
  }
  if (err instanceof InferenceError) {
    return `Inference unavailable: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

/**
 * #13: detect the inference stream's idle-timeout abort (see
 * `deadlineController` in sandbox/inference-providers.ts — its stall timer
 * aborts with a named `IdleTimeoutError`). Matched by name to avoid a
 * core→sandbox import. Some runtimes propagate `signal.reason` wrapped, so
 * the message is checked as a fallback.
 */
function isIdleTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "IdleTimeoutError" || /stream stalled/i.test(err.message);
}

/**
 * Detect a user-initiated stop. The router throws either a DOMException with
 * name "AbortError" (browser-style) or a plain Error with the same name
 * (Node 18+ fetch). We accept both shapes.
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // Some runtimes wrap the abort under a different error type
  // (e.g. "AbortError" string on a generic Error).
  return /abort/i.test(err.message);
}

