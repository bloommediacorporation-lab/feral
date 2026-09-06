// IPC façade
//
// Tauri returns T directly on success and throws a string on Err.
// Domain groups keep components to ~5 imports each.

import { invoke, Channel } from '@tauri-apps/api/core';
export { Channel };
import type {
  TokenEvent,
  StreamDoneEvent,
  StreamErrorEvent,
  StreamTruncatedEvent,
  DownloadProgressEvent,
  DownloadCompleteEvent,
  DownloadErrorEvent,
  ModelLoadProgressEvent,
} from './events';

// ── Types (mirrors Rust structs exactly — snake_case, no rename_all) ──────────
export type { TokenEvent, StreamDoneEvent, StreamErrorEvent, StreamTruncatedEvent };
export type { DownloadProgressEvent, DownloadCompleteEvent, DownloadErrorEvent };
export type { ModelLoadProgressEvent };
export type { StreamProgressEvent, RsiEngineEventLine, FractalActivityLine, DreamCycleLine } from './events';

/**
 * One row of the voice-engine picker — mirrors `cinderpaw_core::tts::TtsEngine`.
 *
 * `isLocal` must be shown before recording starts, not buried in settings: with
 * a hosted engine every spoken reply leaves the machine, and a local-first
 * product that does not say so has lied by omission.
 *
 * `available: false` means the engine is catalogued but not built into this
 * version. The row is shown (so the plan is visible) and cannot be chosen (so it
 * cannot lie) — `from_id` refuses it in Rust regardless of what the UI does.
 */
export interface TtsProviderInfo {
  id: string;
  label: string;
  isLocal: boolean;
  needsKey: boolean;
  needsBaseUrl: boolean;
  needsModel: boolean;
  /** Runs from a file the user must fetch first. A property rather than a list of
   *  ids in this file, so the next local engine cannot skip the download step. */
  needsDownload: boolean;
  consoleUrl: string | null;
  note: string;
  available: boolean;
}

/**
 * One selectable voice, listed by the vendor. `locale` is empty for a
 * multilingual voice — which is not "English", it means the voice follows the
 * text, and that is what a bilingual conversation needs.
 */
export interface TtsVoice { id: string; label: string; locale: string }

/**
 * One speech-to-speech vendor a call can run on — mirrors
 * `commands::livekit::S2sProviderInfo`.
 *
 * `voices` is per vendor because a voice id only means something to the vendor
 * that issued it; `connected` is whether a key is actually stored, which is the
 * difference between an assistant and an echo.
 */
export interface S2sProviderInfo {
  id: string;
  label: string;
  voices: string[];
  default_voice: string;
  /**
   * Assembled from the app's own STT / model / TTS choices rather than being one
   * vendor's session. Whether anything leaves the device is decided by those
   * engines, not by this flag.
   */
  pipeline: boolean;
  connected: boolean;
}

export interface Message       { role: string; content: string; images?: string[] }
export interface InferParams   {
  temperature: number;
  top_p: number;
  repeat_penalty: number;
  max_tokens: number;
  system_prompt?: string | null;
  tools?: string[] | null;
}
export interface LoadedModel   { path: string; name: string; ctx_len: number; n_ctx_train: number;
                                 /** e.g. "GPU (vulkan, 24/32 layers)" · "CPU (GPU build, but offload unavailable)" · "CPU" */
                                 backend: string; gpu_layers: number; gpu_layers_total: number }
export interface ModelInfo     {
  id: string; name: string; path: string; size_bytes: number;
  quant?: string | null; ctx_len?: number | null; loaded: boolean;
  /**
   * True for a model that turns text into vectors and cannot hold a
   * conversation.
   *
   * Rust has carried this on `ModelInfo` for a while, with a doc comment saying
   * it exists so each of its many callers can decide for itself. This
   * hand-written mirror never gained the field, so no caller on this side could
   * decide anything: both model pickers listed `bge-m3`, and because it sorts
   * before every chat model and a menu focuses its first row on open, opening
   * the picker looked like it had chosen the one model that can only return
   * vectors. The Models tab and the download panel must still NOT filter on it
   * — hiding a file somebody is trying to delete is worse.
   */
  is_embedding: boolean;
}
export interface SystemInfo {
  os: string;
  cpu: string;
  cores: number;
  ram_total_mb: number;
  ram_used_mb: number;
  gpu_name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  supports_vulkan: boolean;
}

// At-rest encryption posture for the host disk (H-1). `state` is "on" | "off"
// | "unknown"; `detail` is a human-readable note for the UI.
export interface DiskEncryptionStatus {
  state: 'on' | 'off' | 'unknown';
  detail: string;
}

// MCP "Extensions" — display-safe views only (no transports, paths, or keys)
export interface McpConfigField {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
}
export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  logo_url?: string;
  fields: McpConfigField[];
  /** Connecting opens a browser for the user to sign in to the publisher. */
  browser_login: boolean;
}
export interface McpServerView {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  logo_url?: string;
  enabled: boolean;
  running: boolean;
}
export interface McpToolView { name: string; description: string }

// Connectors — inbound messaging surfaces over the local agent. Field names
// match Rust snake_case serialization exactly.
//
// v2 (2026-07-07) — Decision D Phase 1 delivered connector catalog with
// rich metadata (`pairing_method`, `validate_endpoint`,
// `oauth_client_id_source`, `qr_setup_endpoint`). Older React callers
// that only read `id/name/icon/fields/auth_kind` keep working — every
// new field is optional. The richer surface lands when the Connectors
// tab lands as part of Phase 2.
export interface ConnectorField { key: string; label: string; secret: boolean }

/** A pairing in flight. Public values only — what to type and where. The
 *  device code is a credential and never crosses this boundary. */
export type ConnectorAuthState = {
  kind: 'waiting_for_user';
  user_code: string;
  verification_uri: string;
  expires_at: number;
};

/** Status is a value derived from the credential, never "enabled in a file".
 *  `error` carries its own words because the person needs them. */
export type ConnectorAccountStatus =
  | 'disconnected'
  | 'pairing'
  | 'connected'
  | 'expired'
  | 'revoked'
  | { error: string };

export interface ConnectorAccount {
  connector_id: string;
  display_name?: string | null;
  status: ConnectorAccountStatus;
  metadata: Record<string, string>;
  auth_state?: ConnectorAuthState | null;
  secret_ref?: string | null;
  expires_at?: number | null;
}
export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  logo_url?: string;
  fields: ConnectorField[];
  auth_kind: string; // "token" | "qr"
  coming_soon: boolean;
  /** Optional rich metadata exposed by v2+ catalog payloads. */
  pairing_fields?: Array<{ key: string; label: string; secret: boolean }>;
  pairing_method?: 'bot_token' | 'oauth' | 'qr';
  console_url?: string | null;
  free_tier_note?: string | null;
  /** Gateway endpoint the wizard POSTs to for an OAuth/bot-token probe. */
  validate_endpoint?: string | null;
  /** OAuth scopes shown on the card so the user knows what they'll grant. */
  oauth_scopes?: string[];
  /** OAuth client-id source, when `pairing_method === 'oauth'`. */
  oauth_client_id_source?: { kind: 'env' | 'keychain'; ref: string } | null;
  /** QR pairing only — endpoint that returns a fresh QR payload. */
  qr_setup_endpoint?: string | null;
}
export interface ConnectorView {
  id: string;
  name: string;
  description: string;
  icon: string;
  logo_url?: string;
  fields: ConnectorField[];
  auth_kind: string;
  coming_soon: boolean;
  enabled: boolean;
  filled: string[];   // field keys that hold a value (never the values)
  linked: boolean;    // QR connectors: session established
  allowlist: string[];
  channels: string[];
  mode: string;            // "owner" | "public" (WhatsApp)
  knowledgeBase: string;   // inline KB text for public mode
}
export interface WhatsappQr {
  qr: string;     // raw pairing payload
  ascii: string;  // terminal-style QR art, scannable in a monospace block
  ts: number;     // Unix ms when the sidecar wrote this code (rotates ~20s)
}

// HF types — field names match Rust snake_case serialization exactly
export interface HfModelSummary {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  last_modified: string;
  tags: string[];
}

export interface HfFile {
  rfilename: string;
  size: number | null;
}

export interface HfModelDetail {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  last_modified: string;
  tags: string[];
  gguf_files: HfFile[];
  readme: string | null;
}

export interface HfSearchPage {
  models: HfModelSummary[];
  next_cursor: string | null;
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  license: string;
  tags: string[];
  source_provider: string;
  source_url: string | null;
  content_url: string | null;
  install_status: string; // "installed" | "not_installed"
  trust_label: string;    // "local" | "community" | "unknown" | etc.
  last_updated: string | null;
}

export interface SkillPreview {
  meta: SkillMeta;
  content: string;
}

export interface Settings {
  models_dir: string;
  default_gpu_layers: number;
  api_server_enabled: boolean;
  api_port: number;
  version: string;
  /** Opt-in for OS-level desktop control (the `control_app` tool). Off by default. */
  desktop_control_enabled: boolean;
  /** YOLO mode: skip the per-action confirmation prompt for desktop control. Off = Safe mode. */
  desktop_control_yolo: boolean;
  /** Per-conversation token budget. null = unlimited (Infinity); number = hard cap in tokens. */
  token_budget_conversation: number | null;
  /** USD spend cap for the passive RSI background engine. null / 0 = local-only (free). */
  rsi_max_cost_usd: number | null;
  /** Let the dream cycle run on a CLOUD model. Off by default — background
   *  dreaming on a paid route spends money while the user is away. Without it,
   *  a machine with no local model never dreams at all. */
  rsi_allow_cloud_dreams: boolean;
  /** MASTER opt-in for the dream cycle. Off by default: dreaming (local or
   *  cloud) never starts unless the user flipped this on. */
  dreams_enabled: boolean;
  /** The chosen inference route: `"<provider>:<model>"` (cloud) or
   *  `"local:<file>"`. null = the bundled local default. */
  active_route: string | null;
  /** Allow a failed cloud turn to be retried against a DIFFERENT configured
   *  cloud provider. Off by default: it sends the conversation, and that
   *  provider's key, to a recipient the person did not choose. */
  cloud_fallback_enabled: boolean;
}

export interface ByokProvider {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  has_api_key: boolean;
  base_url?: string | null;
  default_model?: string | null;
}

// Phase 1 (2026-07-07) — canonical provider catalog row served by the
// Rust `byok::provider_catalog()` function via the
// `provider_catalog` Tauri command. Mirrors
// `crates/cinderpaw-core/src/byok.rs::ProviderCatalogEntry` 1:1.
// Optional fields come back as `null` from the Rust serde
// `skip_serializing_if = "Option::is_none"` so we type them as
// `T | null` (NOT `T | undefined`).
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  provider: string;
  default_base_url: string;
  default_model: string;
  console_url?: string | null;
  key_format?: string | null;
  key_format_hint?: string | null;
  free_tier_note?: string | null;
  supports_custom_base_url: boolean;
  auth_style: 'bearer' | 'x_api_key';
}

// Guided setup (2026-07-10 OpenClaw onboarding parity). Mirrors
// `crates/cinderpaw-core/src/setup.rs::Candidate` / `VerifyOutcome` 1:1 —
// the detection ladder + real-completion verification the CLI's
// `cinderpaw setup` and the TUI consume over `/runtime/setup/*`.
export type SetupCandidateKind =
  | 'existing_config'
  | 'local_gguf'
  | 'hardware_download'
  | 'env_key'
  | 'ollama'
  | 'openclaw_import';

export interface SetupCandidate {
  kind: SetupCandidateKind;
  id: string;
  label: string;
  detail: string;
  provider_id?: string | null;
  model?: string | null;
  base_url?: string | null;
  env_var?: string | null;
  recommended: boolean;
  download?: {
    repo_id: string;
    filename: string;
    label: string;
    approx_size: string;
  } | null;
}

export interface SetupVerifyOutcome {
  ok: boolean;
  status: 'ok' | 'auth' | 'rate_limit' | 'billing' | 'timeout' | 'format' | 'unavailable' | 'unknown';
  message: string;
  latency_ms?: number | null;
  reply?: string | null;
  persisted: boolean;
}

// ── RSI (Fractal Memory) ────────────────────────────────────────────────────
//
// Rust types are snake_case (no `rename_all`). The `engine` field is
// `null` until the sidecar starts emitting `rsi_engine_event` lines on
// stdout; until then the UI shows "engine not wired" rather than crashing
// on `engine.something` (7c comment in commands.rs).
//
// Ack semantics (7b-part2): `rsi_start` / `rsi_stop` / `rsi_set_concurrency`
// now wait up to 500ms for the sidecar's ack on stdout before returning.
// If the sidecar doesn't ack, Tauri throws the timeout string — surface
// that to the user as "sidecar did not ack rsi_start within 500ms".

export interface RsiInitResult {
  plan_commit: string;
  main_tip: string;
  bounds_version: number;
  audit_chain_ok: boolean;
}

/** Mirror of the running RSI engine. Updated by Rust from the
 *  sidecar's `rsi_engine_event` stdout lines. */
export interface RsiEngineState {
  running: boolean;
  iteration: number;
  best_score: number | null;
  cost_so_far_usd: number;
  concurrency: number;
  /** Last `StopReason` if the engine has terminated; null while
   *  running or before the engine has ever been started. */
  stop_reason: string | null;
}

/** Display-safe snapshot of the RSI substrate + engine mirror. */
export interface RsiStatus {
  initialized: boolean;
  bounds_sha256: string | null;
  bounds_version: number | null;
  max_total_cost_usd: number | null;
  cost_warning_ratio: number | null;
  main_tip: string | null;
  main_tip_score: number | null;
  /** `null` until the sidecar starts emitting engine status events. */
  engine: RsiEngineState | null;
}

export interface RsiStartAck {
  /** True iff the sidecar's stdin send succeeded (Tauri throw → false). */
  delivered: boolean;
  /** UUID echoed back by Rust for log correlation. */
  request_id: string;
}

export interface RsiStopAck {
  delivered: boolean;
}

/** One completed Dream Cycle episode (Rust `DreamEpisode`, camelCase wire). */
export interface DreamEpisode {
  startedAt: number;
  endedAt: number;
  trigger: 'idle' | 'error';
  iterations: number;
  tokens: number;
  ratchets: number;
  stopReason: string;
}

/** Lifetime Dream Cycle totals + the most recent episodes (newest first). */
export interface DreamTelemetrySummary {
  episodes: number;
  ratchets: number;
  tokens: number;
  iterations: number;
  last: DreamEpisode[];
}

/** The terminal decision of a journal row (BRSI §2.9). */
export interface JournalDecisionRow { action: string; reason: string }

/** Per-candidate fitness receipt (Contract FSM rows). Null on episode
 *  summary rows. Only the components the receipts UI renders. */
export interface JournalResultRow {
  aggregate: number;
  tier0: string;
  fitnessVector: { accuracy: number; userSatisfaction: number };
}

/** One Evolution Journal row (BRSI §2.9), flattened for the receipts UI.
 *  `observed` lines are already human-readable receipt copy. */
export interface JournalRow {
  cycleId: string;
  timestamp: number;
  durationMin: number;
  observed: string[];
  decided: JournalDecisionRow;
  result?: JournalResultRow | null;
}

/** One niche's reigning champion from the Tree of Champions (§7.4), flattened
 *  for the receipts UI. `niche` is the escape-time behavioural region key. */
export interface ChampionTreeRow {
  niche: string;
  genomeId: string;
  score: number;
}

// ── Code-patch approval gate (Faza 2 Slice 5) ───────────────────────────────
// Frozen wire shape from CinderpawAgent/src/types.ts (OutboundEvent `code_patches`
// + `code_patch_resolved`). The Dreams panel renders this list and resolves
// patches; the trust boundary + sidecar disk live behind the Tauri command.

/** The six lifecycle states a pending code patch can be in (spec §2.5). */
export type CodePatchStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'apply_failed'
  | 'reverted';

/** One entry in the pending-patches queue, flattened for the card UI. */
export interface CodePatch {
  id: string;
  status: CodePatchStatus;
  score: number;
  rationale: string;
  affectedFiles: string[];
  /** The unified diff itself — the card renders it for review. */
  patch: string;
  commitHash: string;
  createdAt: number;
  /** Host note (e.g. "applied", "live apply unavailable: CINDERPAW_CODE_RSI_REPO not set"). */
  note?: string;
  /** Resolution-side error, when status === 'apply_failed'. */
  error?: string;
}

/** Payload of the `code_patches` outbound event (full queue snapshot). */
export interface CodePatchesPayload {
  patches: CodePatch[];
  /** True while the first-10 window is open (spec §2.5): every apply
   *  needs an explicit human approval. */
  manualWindowOpen: boolean;
  appliedCount: number;
}

/** Payload of the `code_patch_resolved` ack event. */
export interface CodePatchResolvedPayload {
  id: string;
  status: CodePatchStatus;
  error?: string;
}

/** Mirrors Rust `conversations::VoiceMeta` (snake_case, no rename_all). */
export interface VoiceMeta { audio_path: string; duration_ms: number; transcript: string; peaks: number[] }
/** Mirrors `conversations::ScratchStats` — churn in the agent's own workspace. */
export interface ScratchStats        { edits: number; added: number; removed: number }
export interface PersistedMessage    { role: string; content: string; thinking?: string; voice?: VoiceMeta | null; scratch?: ScratchStats | null; created_at?: number | null }
export interface ConversationSummary {
  id: string; title: string; updated_at: string;
  /** Set when this conversation belongs to an agent (Agents tab); null for chat. */
  agent_id?: string | null;
}
export interface Conversation {
  id: string; title: string;
  created_at: string; updated_at: string;
  messages: PersistedMessage[];
  agent_id?: string | null;
}
export interface Project { id: string; name: string; conversation_ids: string[] }

// ── Memory Graph ─────────────────────────────────────────────────────────────
export interface MemoryGraphNodeView {
  id: string;
  label: string;
  type: string;
  touched_at: number;
}

export interface MemoryGraphEdgeView {
  from: string;
  to: string;
  relation: string;
}

export interface MemoryGraphSnapshot {
  nodes: MemoryGraphNodeView[];
  edges: MemoryGraphEdgeView[];
}

/** One extracted fact triple written to the shared knowledge graph. */
export interface MemoryFactInput {
  subject: string;
  predicate: string;
  object: string;
}

/** Sprint 1.6 — Memory Resume. Mirrors `src-tauri/src/memory_resume.rs`
 *  `LastTaskView` (snake_case wire). Every field is null on first launch. */
export interface LastTaskView {
  task: { title: string; ts: number; workspace_id?: string | null } | null;
  workspace_id: string | null;
  workspace_name: string | null;
  last_active_at: number | null;
}

// ── Agents ───────────────────────────────────────────────────────────────────
/** Mirrors Rust AgentEvent — `#[serde(tag = "kind", rename_all = "snake_case")]` */
export type AgentEvent =
  | { kind: 'token';       text: string }
  | { kind: 'tool_call';   name: string; args: unknown }
  | { kind: 'tool_result'; name: string; ok: boolean; output: string }
  | { kind: 'final';       text: string }
  | { kind: 'error';       message: string };

export interface AgentConfig {
  /** Omit when creating a new agent — the backend assigns a UUID. */
  id?: string;
  name: string;
  system_prompt: string;
  model_id: string;
  /** Serialised as Rust enum variant names: "WebSearch" | "FileRead" | "FileWrite" | "CodeExecute" | "HttpRequest" */
  tools: string[];
  params?: Record<string, unknown> | null;
}

// ── Cinderpaw Agent ─────────────────────────────────────────────────────────────

/** Parsed output event from the Cinderpaw Agent sidecar. */
export type CinderpawAgentEvent =
  | { type: 'chunk';       id: string; content: string }
  // `diagnostic` is the operator-facing reason a turn failed (token budget,
  // model, files worth checking). The sidecar keeps it OUT of `content` so
  // connectors and benchmarks — where the reader is not the person who owns
  // the machine — deliver a clean answer. The desktop is the surface whose
  // reader IS that person, so it is the one place that shows it.
  | { type: 'done';        id: string; content: string; stopped: boolean; diagnostic?: string }
  // `sessionId` is optional and only present on newer sidecars. It is what
  // lets a surface attribute a call to WHO ran it — the cowork panel uses it
  // to show which tools a teammate is using, which the events could not say
  // before because they carried no owner.
  | { type: 'tool_start';  id: string; callId: string; tool: string; args: Record<string, unknown>; sessionId?: string }
  | { type: 'tool_done';   id: string; callId: string; tool: string; result: unknown; sessionId?: string }
  // #18: live progress/retry notes from long-running tools (sidecar emits
  // these with a sessionId, not a message id).
  | { type: 'tool_progress'; sessionId: string; tool: string; stage: string; progress: number | null; message: string }
  // Agent Cowork S6 — one thread replayed from the mailbox. An empty list
  // is a real answer ("no teammate traffic in this chat"), not a failure.
  | {
      type: 'cowork_history_result';
      threadId: string;
      messages: {
        id: string;
        fromAgentId: string;
        toAgentId: string;
        fromAgentName?: string;
        toAgentName?: string;
        body: string;
        status: string;
        createdAt: number;
      }[];
    }
  // A background worker spawned by the notebook's `rlm()`. Carries a
  // sessionId and no message id, and unlike every other event here it usually
  // arrives AFTER the turn that caused it has finished — `rlm()` returns the
  // instant a child is admitted, so all the child's work happens later.
  | {
      type: 'rlm_child';
      sessionId: string;
      childId: string;
      name: string;
      status: 'running' | 'completed' | 'error' | 'cancelled';
      detail?: string;
      durationMs?: number;
    }
  | { type: 'proactive';   content: string }
  | { type: 'model_set';   provider: string; model: string }
  // Which model answered this turn, and why that one. Emitted on the
  // success AND the failure path: automatic model selection used to fail
  // into a console warning and a silent switch to the default target, so a
  // user whose routing broke got a different model with no explanation
  // anywhere on their screen.
  | {
      type: 'model_routed';
      sessionId: string;
      provider: string;
      model: string;
      reason: 'brain' | 'only_candidate' | 'fallback';
      category?: string;
      detail?: string;
    }
  | { type: 'model_error'; message: string }
  | { type: 'pong' }
  | { type: 'error';       id?: string; message: string }
  | { type: 'ask_user';    id: string; sessionId: string; questions: import('@/stores/askUser').AskUserQuestion[] }
  | { type: 'ask_user_cancelled'; id: string; sessionId: string; reason: string }
  | { type: 'spawning'; id: string; count: number }
  // Real token usage per completion — drives the live context ring in agent mode.
  | { type: 'usage'; id: string; sessionId: string; promptTokens: number; completionTokens: number }
  // X3: scheduled-job results and failures, surfaced as toasts.
  | { type: 'cron_fired'; jobId: string; jobName: string; sessionId: string; content: string }
  | { type: 'cron_error'; jobId: string; jobName: string; message: string }
  // Agent Cowork (S3.5): one agent-to-agent occurrence, rendered as an
  // activity bubble on the mascot strip. `title` is the human-readable
  // line; `data` carries ids/detail for the expandable preview. S4 adds
  // the approval kinds: `approval_requested` asks the human to decide in
  // chat; the three terminal kinds close the same bubble.
  | {
      type: 'cowork_event';
      eventType:
        | 'message_received'
        | 'message_processed'
        | 'message_rejected'
        | 'handoff_received'
        | 'handoff_completed'
        | 'handoff_failed'
        | 'approval_requested'
        | 'approval_approved'
        | 'approval_denied'
        | 'approval_expired';
      agentId: string;
      threadId?: string;
      title: string;
      data: Record<string, unknown>;
    };

/** Display-safe snapshot of the Cinderpaw Agent's active LLM — no API keys. */
export interface CinderpawModelConfigView {
  provider: string;
  model: string;
  base_url: string;
  display_name: string;
}

/** What React sends to Rust when changing the Cinderpaw model. */
export type CinderpawModelSelection =
  | { source: 'ollama';            model: string; baseUrl: string }
  | { source: 'byok';              providerId: string; model: string }
  | { source: 'openai_compatible'; baseUrl: string; model: string; providerId: string };

// ── Raw invoke helpers ────────────────────────────────────────────────────────
// Tauri returns T directly on Ok; throws a string on Err.
// No Result wrapper needed — errors propagate as thrown exceptions.
const raw = {
  getModels:             ()    => invoke<ModelInfo[]>('get_models'),
  getLoadedModel:        ()    => invoke<LoadedModel | null>('get_loaded_model'),
  loadModel:             (path: string, maxContext?: number) => invoke<LoadedModel>('load_model', { path, maxContext }),
  startModelLoad:        (path: string, maxContext?: number) => invoke<LoadedModel>('start_model_load', { path, maxContext }),
  unloadModel:           ()    => invoke<void>('unload_model'),
  deleteModel:           (path: string) => invoke<void>('delete_model', { path }),
  chatStream:            (messages: Message[], params: InferParams, sessionId: string) =>
    invoke<void>('chat_stream', { messages, params, sessionId }),
  stopGeneration:        (sessionId: string) => invoke<void>('stop_generation', { sessionId }),
  downloadModel:         (repoId: string, filename: string) =>
    invoke<string>('download_model', { repoId, filename }),
  cancelDownload:        (modelId: string) =>
    invoke<void>('cancel_download', { modelId }),
  getModelSizeInfo:      (repoId: string, filename: string) =>
    invoke<number>('get_model_size_info', { repoId, filename }),
  getSystemInfo:         ()    => invoke<SystemInfo>('get_system_info'),
  diskEncryptionStatus:  ()    => invoke<DiskEncryptionStatus>('disk_encryption_status'),
  saveAgent:             (cfg: AgentConfig) => invoke<AgentConfig>('save_agent', { cfg }),
  getAgents:             ()    => invoke<AgentConfig[]>('get_agents'),
  deleteAgent:           (id: string) => invoke<void>('delete_agent', { id }),
  getAgentPresets:       ()    => invoke<AgentConfig[]>('get_agent_presets'),
  runAgent:              (agentId: string, prompt: string, sessionId: string) =>
    invoke<void>('run_agent', { agentId, prompt, sessionId }),
  saveConversation:      (id: string, title: string, messages: PersistedMessage[], agentId?: string | null) =>
    invoke<void>('save_conversation', { id, title, messages, agentId: agentId ?? null }),
  loadConversations:     ()    => invoke<ConversationSummary[]>('load_conversations'),
  loadConversation:      (id: string) => invoke<Conversation>('load_conversation', { id }),
  agentIsReady:          ()    => invoke<boolean>('agent_is_ready'),
  renameConversation:    (id: string, title: string) =>
    invoke<void>('rename_conversation', { id, title }),
  deleteConversation:    (id: string) => invoke<void>('delete_conversation', { id }),
  clearAllConversations: ()    => invoke<void>('clear_all_conversations'),
  loadProjects:          ()    => invoke<Project[]>('load_projects'),
  saveProject:           (id: string, name: string, conversationIds: string[]) =>
    invoke<void>('save_project', { id, name, conversationIds }),
  deleteProject:         (id: string) => invoke<void>('delete_project', { id }),
  getSettings:           ()    => invoke<Settings>('get_settings'),
  saveSettings:          (settings: Settings) => invoke<void>('save_settings', { settings }),
  setDesktopControlEnabled: (enabled: boolean) =>
    invoke<void>('set_desktop_control_enabled', { enabled }),
  setDesktopControlYolo: (enabled: boolean) =>
    invoke<void>('set_desktop_control_yolo', { enabled }),
  setTokenBudgetConversation: (budget: number | null) =>
    invoke<void>('set_token_budget_conversation', { budget }),
  setRsiBudget: (budget: number | null) =>
    invoke<void>('set_rsi_budget', { budget }),
  setRsiAllowCloudDreams: (enabled: boolean) =>
    invoke<void>('set_rsi_allow_cloud_dreams', { enabled }),
  setDreamsEnabled: (enabled: boolean) =>
    invoke<void>('set_dreams_enabled', { enabled }),
  searchHfModels:        (query: string, cursor?: string | null) =>
    invoke<HfSearchPage>('search_hf_models', { query, cursor }),
  getHfModelDetail:      (repoId: string) =>
    invoke<HfModelDetail>('get_hf_model_detail', { repoId }),
  getByokSettings:       ()    => invoke<ByokProvider[]>('get_byok_settings'),
  saveByokProvider:      (providerId: string, enabled: boolean, apiKey: string, baseUrl?: string | null, defaultModel?: string | null) =>
    invoke<void>('save_byok_provider', { providerId, enabled, apiKey, baseUrl, defaultModel }),
  removeByokProvider:    (providerId: string) =>
    invoke<void>('remove_byok_provider', { providerId }),
  testByokProvider:      (providerId: string, apiKey: string, baseUrl?: string | null) =>
    invoke<object>('test_byok_provider', { providerId, apiKey, baseUrl }),
  chatCloudStream:       (providerId: string, model: string, messages: Message[], params: InferParams, sessionId: string) =>
    invoke<void>('chat_cloud_stream', { providerId, model, messages, params, sessionId }),
  readFileAsText:        (path: string) => invoke<string>('read_file_as_text', { path }),
  listInstalledSkills:      () => invoke<SkillMeta[]>('list_installed_skills'),
  getInstalledSkillContent: (id: string) => invoke<string>('get_installed_skill_content', { id }),
  fetchRemoteSkills:        () => invoke<SkillMeta[]>('fetch_remote_skills'),
  fetchCommunitySkills:     () => invoke<SkillMeta[]>('fetch_community_skills'),
  previewRemoteSkill:       (url: string) => invoke<SkillPreview>('preview_remote_skill', { url }),
  previewLocalSkill:        (path: string) => invoke<SkillPreview>('preview_local_skill', { path }),
  skillExistsCmd:           (id: string) => invoke<boolean>('skill_exists_cmd', { id }),
  // The old `install_skill(meta, content, overwrite)` is gone. It let the
  // CALLER supply the file body, the metadata and the trust label, and the
  // host checked only that the id was a safe slug. Each of these instead
  // names a source and lets the host fetch it.
  installCapability:        (id: string) => invoke<SkillMeta>('install_capability', { id }),
  inspectCapability:        (id: string) => invoke<SkillPreview>('inspect_capability', { id }),
  installSkillFromUrl:      (url: string, overwrite: boolean) =>
    invoke<SkillMeta>('install_skill_from_url', { url, overwrite }),
  installSkillFromFile:     (path: string, overwrite: boolean) =>
    invoke<SkillMeta>('install_skill_from_file', { path, overwrite }),
  removeSkill:              (id: string) => invoke<void>('remove_skill', { id }),
  cinderpawSendMessage:         (content: string, sessionId: string, images?: string[], inferParams?: { temperature?: number; max_tokens?: number }) =>
    invoke<string>('cinderpaw_send_message', { content, sessionId, images: images ?? null, inferParams: inferParams ?? null }),
  cinderpawAgentStatus:         () => invoke<boolean>('cinderpaw_agent_status'),
  cinderpawStopGeneration:      (sessionId?: string | null) =>
    invoke<void>('cinderpaw_stop_generation', { sessionId: sessionId ?? null }),
  cinderpawSubmitFeedback:      (sessionId: string, messageId: string, value: 'up' | 'down') =>
    invoke<void>('cinderpaw_submit_feedback', { sessionId, messageId, value }),
  cinderpawSetModel: (
    source: string,
    model: string,
    providerId?: string | null,
    baseUrl?: string | null,
  ) => invoke<void>('cinderpaw_set_model', { source, model, providerId, baseUrl }),
  cinderpawGetModelConfig:      () => invoke<CinderpawModelConfigView | null>('cinderpaw_get_model_config'),
  mcpCatalog:               () => invoke<McpCatalogEntry[]>('mcp_catalog'),
  mcpList:                  () => invoke<McpServerView[]>('mcp_list'),
  mcpInstall:               (id: string, values: Record<string, string>) =>
    invoke<McpServerView>('mcp_install', { id, values }),
  mcpSetEnabled:            (id: string, enabled: boolean) =>
    invoke<McpServerView>('mcp_set_enabled', { id, enabled }),
  mcpRemove:                (id: string) => invoke<void>('mcp_remove', { id }),
  mcpListTools:             (id: string) => invoke<McpToolView[]>('mcp_list_tools', { id }),
  mcpCallTool:              (id: string, tool: string, argsJson: string) =>
    invoke<string>('mcp_call_tool', { id, tool, argsJson }),
  connectorsCatalog:        () => invoke<ConnectorCatalogEntry[]>('connectors_catalog'),
  // Phase 1 (2026-07-07) — canonical provider catalog (decision locked:
  // one source of truth in Rust). Replaces the desktop's hard-coded
  // provider list at the wizard level; see OnboardingWizard.tsx.
  providerCatalog:          () => invoke<ProviderCatalogEntry[]>('provider_catalog'),
  // Guided setup — detection ladder + real-completion verify (persist only
  // on success; the invariant lives in cinderpaw-core, not here).
  setupDetect:              () => invoke<SetupCandidate[]>('setup_detect'),
  setupVerify:              (candidate: SetupCandidate, apiKey: string | undefined, persist: boolean) =>
    invoke<SetupVerifyOutcome>('setup_verify', { candidate, apiKey: apiKey ?? null, persist }),
  connectorsList:           () => invoke<ConnectorView[]>('connectors_list'),
  connectorsSave:           (id: string, secrets: Record<string, string>, allowlist: string[], channels: string[], mode?: string, knowledgeBase?: string) =>
    invoke<ConnectorView>('connectors_save', { id, secrets, allowlist, channels, mode, knowledgeBase }),
  connectorsSetEnabled:     (id: string, enabled: boolean) =>
    invoke<ConnectorView>('connectors_set_enabled', { id, enabled }),
  connectorsRemove:         (id: string) => invoke<void>('connectors_remove', { id }),
  connectorsWhatsappQr:     () => invoke<WhatsappQr | null>('connectors_whatsapp_qr'),
  connectorAccounts:        () => invoke<ConnectorAccount[]>('connector_accounts_list'),
  connectorPairStart:       (id: string) => invoke<ConnectorAccount>('connector_pair_start', { id }),
  connectorPairPoll:        (id: string) => invoke<ConnectorAccount>('connector_pair_poll', { id }),
  getLocalApiToken:         () => invoke<string>('get_local_api_token'),
  listOllamaModels:         (baseUrl: string) => invoke<string[]>('list_ollama_models', { baseUrl }),
  getMemoryGraph:           () => invoke<MemoryGraphSnapshot>('get_memory_graph'),
  addMemoryFacts:           (facts: MemoryFactInput[]) =>
    invoke<number>('add_memory_facts', { facts }),
  // Sprint 1.6 — Memory Resume. Powers the React WelcomeBack banner and the
  // TUI last-task row. Reads `meta` + `workspaces` via the sidecar (single-
  // writer discipline: Tauri is a reader, never opens SQLite for writes).
  // Returns `{ task, workspace_id, workspace_name, last_active_at }`; every
  // field is null on first launch.
  getLastTask:              () => invoke<LastTaskView>('get_last_task'),
  chatCompleteLocal:        (messages: Message[], params: InferParams) =>
    invoke<string>('chat_complete_local', { messages, params }),
  chatCloudComplete:        (providerId: string, model: string, messages: Message[], params: InferParams) =>
    invoke<string>('chat_cloud_complete', { providerId, model, messages, params }),
  // ── RSI (Fractal Memory) commands. Field names match Rust snake_case
  // exactly (the Tauri command extractor doesn't auto-rename). The engine-
  // driver trio (start/stop/set_concurrency) embed a request_id and wait
  // up to 500ms for the sidecar's ack; a timeout surfaces as a thrown
  // string from Tauri.
  rsiInit:            () => invoke<RsiInitResult>('rsi_init'),
  rsiStatus:          () => invoke<RsiStatus>('rsi_status'),
  rsiStart:           (goal: string, budgetUsd: number, maxIterations: number, concurrency: number) =>
    invoke<RsiStartAck>('rsi_start', { goal, budgetUsd, maxIterations, concurrency }),
  rsiStop:            () => invoke<RsiStopAck>('rsi_stop'),
  rsiSetConcurrency:  (concurrency: number) =>
    invoke<void>('rsi_set_concurrency', { concurrency }),
  rsiDreamTelemetry:  (limit: number) =>
    invoke<DreamTelemetrySummary>('rsi_dream_telemetry', { limit }),
  rsiJournalRecent:   (limit: number) =>
    invoke<JournalRow[]>('rsi_journal_recent', { limit }),
  rsiChampionTree:    () => invoke<ChampionTreeRow[]>('rsi_champion_tree'),
  rsiDreamNow:        () => invoke<void>('cinderpaw_dream_now'),
  // Faza 6 (L6) Meta Evolution — fire-and-forget; the sidecar replies async
  // via a `meta_result` event (handled by `events.onMetaResult`).
  cinderpawMeta:          (op: 'status' | 'evolve' | 'rollback' | 'history') =>
    invoke<void>('cinderpaw_meta', { op }),
  // Slice A6 (L5 Governance) — fire-and-forget; the sidecar replies async
  // via a `governance_result` event (handled by `events.onGovernanceResult`).
  cinderpawGovernance:    (op: 'status' | 'verify' | 'approve' | 'reject', policyId?: string, reason?: string) =>
    invoke<void>('cinderpaw_governance', { op, policyId: policyId ?? null, reason: reason ?? null }),
  // Phase B (L4 Architecture Evolution) — fire-and-forget; the sidecar
  // replies async via a `modules_result` event (events.onModulesResult).
  cinderpawModules:       (op: 'list' | 'approve' | 'reject' | 'demote', moduleId?: string, seam?: string, note?: string) =>
    invoke<void>('cinderpaw_modules', { op, moduleId: moduleId ?? null, seam: seam ?? null, note: note ?? null }),
  // Faza 2 Slice 5 — code-patch approval gate. `cinderpaw_code_patches_list` is
  // fire-and-forget; the sidecar replies async via a `code_patches` event
  // (handled by `events.onCodePatches`). `cinderpaw_code_patch_resolve` is also
  // fire-and-forget; the ack + refreshed queue arrives as `code_patch_resolved`
  // + `code_patches`. The Rust handler validates `action ∈ {approve,reject}`
  // and rejects anything else.
  cinderpawCodePatchesList:   () => invoke<void>('cinderpaw_code_patches_list'),
  cinderpawCodePatchResolve:  (patchId: string, action: 'approve' | 'reject') =>
    invoke<void>('cinderpaw_code_patch_resolve', { patchId, action }),
  // Faza 4 (L2 LoRA) — personal-adaptation gate. All fire-and-forget; the
  // sidecar replies via `lora_reviews` / `lora_review_resolved` /
  // `lora_train_result` events (see events.ts).
  cinderpawLoraReviewsList:   () => invoke<void>('cinderpaw_lora_reviews_list'),
  cinderpawLoraReviewResolve: (cardId: string, action: 'approve' | 'reject') =>
    invoke<void>('cinderpaw_lora_review_resolve', { cardId, action }),
  // Agent Cowork S4 — approval gate. Fire-and-forget; the sidecar acks by
  // emitting the terminal cowork_event (approval_approved / approval_denied),
  // which is also what closes the chat bubble.
  cinderpawCoworkApprovalResolve: (requestId: string, action: 'approve' | 'reject') =>
    invoke<void>('cinderpaw_cowork_approval_resolve', { requestId, action }),
  /** Agent Cowork S6 — write straight to a teammate's inbox from the panel,
   *  without asking the main agent to retype what the person already wrote. */
  /** Agent Cowork S6 — replay one chat's teammate traffic. The answer
   *  arrives as a `cowork_history_result` event, paired by thread id. */
  cinderpawCoworkHistory: (threadId?: string | null) =>
    invoke<void>('cinderpaw_cowork_history', { threadId: threadId ?? null }),
  cinderpawCoworkSendMessage: (toAgentId: string, body: string, threadId?: string) =>
    invoke<void>('cinderpaw_cowork_send_message', {
      toAgentId,
      body,
      threadId: threadId ?? null,
    }),
  cinderpawLoraTrain:         (domain?: string) =>
    invoke<void>('cinderpaw_lora_train', { domain: domain ?? null }),
  saveVoiceBlob:            (bytes: number[], ext: string) =>
    invoke<string>('save_voice_blob', { bytes, ext }),
  whisperModelPresent:      (modelSize: string) =>
    invoke<boolean>('whisper_model_present', { modelSize }),
  transcribeAudio:          (pcm: number[], modelSize: string) =>
    invoke<string>('transcribe_audio', { pcm, modelSize }),
  transcribeAudioCloud:     (audioPath: string, provider: string, language?: string) =>
    invoke<string>('transcribe_audio_cloud', { audioPath, provider, language: language ?? null }),
  downloadWhisperModel:     (modelSize: string) =>
    invoke<string>('download_whisper_model', { modelSize }),
  // Diagnostics bridge: prints into the terminal running the app, because the
  // webview console is invisible there and the voice loop lives in the webview.
  uiLog:                    (scope: string, message: string) =>
    invoke<void>('ui_log', { scope, message }),
  ttsProviders:             () =>
    invoke<TtsProviderInfo[]>('tts_providers'),
  // `getByokSettings` is derived from the LLM provider catalog and so can never
  // report a voice engine's key. This asks the keychain directly.
  ttsHasKey:                (providerId: string) =>
    invoke<boolean>('tts_has_key', { providerId }),
  // "Can this engine speak right now" — a key for hosted engines, a downloaded
  // voice for Piper. Ask this before opening the microphone; `ttsHasKey` only
  // answers half the question and answers `true` for a voiceless Piper.
  ttsReady:                 (providerId: string) =>
    invoke<boolean>('tts_ready', { providerId }),
  ttsVoices:                (providerId: string) =>
    invoke<TtsVoice[]>('tts_voices', { providerId }),
  ttsVoicePresent:          (engine: string, voice: string) =>
    invoke<boolean>('tts_voice_present', { engine, voice }),
  // Idempotent — returns immediately if everything the engine needs is already
  // on disk. Progress streams over `cinderpaw://tts-download-*`.
  downloadTtsVoice:         (engine: string, voice: string) =>
    invoke<string>('download_tts_voice', { engine, voice }),
  // Resolves when SYNTHESIS ends (with the PCM byte count), not when playback
  // does — audio arrives on `cinderpaw://tts-chunk` and the webview owns the clock.
  speakText:                (sessionId: string, text: string, provider?: string, voice?: string) =>
    invoke<number>('speak_text', { sessionId, text, provider: provider ?? null, voice: voice ?? null }),
  stopSpeaking:             (sessionId: string) =>
    invoke<void>('stop_speaking', { sessionId }),
  // Speech to speech. One session replaces STT + the model + TTS, so these three
  // are a whole call: start it, feed it, hang up.
  //
  // Resolves once the model has ACCEPTED the session, so the microphone can open
  // the moment this returns. Rejects with `live-no-key` when no Google key is
  // stored — the same AI Studio key the chat side already uses.
  //
  // Audio comes back on `cinderpaw://tts-chunk` like every other engine's, at the
  // rate carried in the event; everything else arrives on `cinderpaw://live-status`.
  startLiveCall:            (sessionId: string, brief?: { model?: string; voice?: string; currentTask?: string; workspace?: string; context?: string }) =>
    invoke<void>('start_live_call', {
      sessionId,
      model: brief?.model ?? null,
      // The voice is pinned for the whole session: absent, the server picks one
      // per call and the same assistant answers in a different voice tomorrow.
      voice: brief?.voice ?? null,
      currentTask: brief?.currentTask ?? null,
      workspace: brief?.workspace ?? null,
      context: brief?.context ?? null,
    }),
  // Base64 of 16 kHz mono 16-bit LE PCM. Base64 and not a byte array because
  // Tauri's IPC serialises `Vec<u8>` as a JSON array of numbers.
  sendLiveAudio:            (pcm: string) => invoke<void>('send_live_audio', { pcm }),
  // A typed turn into the running call, for what dictation mangles.
  sendLiveText:             (text: string) => invoke<void>('send_live_text', { text }),
  // The prebuilt voices a Live call can be pinned to.
  liveVoices:               () => invoke<string[]>('live_voices'),
  // Idempotent: hanging up twice is not an error.
  endLiveCall:              () => invoke<void>('end_live_call'),

  // The self-hosted LiveKit call. Unlike every other engine here, no audio
  // crosses this boundary: Rust starts a server on 127.0.0.1 and returns the
  // credentials, and the webview then speaks WebRTC to it directly.
  //
  // Rejects with `livekit-no-node` when no Node runtime is installed — a code
  // rather than a sentence, because the answer needs a link the UI can put in
  // the user's language.
  startLivekitCall:     (provider?: string | null, voice?: string | null, pipeline?: { ttsEngine: string | null; sttModel: string | null; sttProvider: string | null; sttLanguage: string | null }, language?: string | null) => invoke<{ url: string; token: string; room: string; mode: 'assistant' | 'echo'; warm: boolean }>('start_livekit_call', { provider: provider ?? null, voice: voice ?? null, ttsEngine: pipeline?.ttsEngine ?? null, sttModel: pipeline?.sttModel ?? null, sttProvider: pipeline?.sttProvider ?? null, sttLanguage: language ?? pipeline?.sttLanguage ?? null }),
  endLivekitCall:       () => invoke<void>('end_livekit_call'),
  /** Same arguments as `startLivekitCall`, and that is load-bearing: a chain
   *  is warmed FOR one vendor, voice and pair of engines, and Rust throws
   *  away one that was warmed for anything else. Warming with fewer
   *  arguments than the call will use is a warmup guaranteed to be discarded. */
  warmLivekit:          (provider?: string | null, voice?: string | null, pipeline?: { ttsEngine: string | null; sttModel: string | null; sttProvider: string | null; sttLanguage: string | null }, language?: string | null) => invoke<void>('warm_livekit', { provider: provider ?? null, voice: voice ?? null, ttsEngine: pipeline?.ttsEngine ?? null, sttModel: pipeline?.sttModel ?? null, sttProvider: pipeline?.sttProvider ?? null, sttLanguage: language ?? pipeline?.sttLanguage ?? null }),
  // Which speech-to-speech vendors this build can run a call on, and which of
  // them actually have a key. Asked of Rust rather than listed here: the same
  // table decides which npm plugin gets installed, and a second list in
  // TypeScript would be free to offer a vendor the agent cannot load.
  listS2sProviders:     () => invoke<S2sProviderInfo[]>('list_s2s_providers'),
  // Whether this BINARY can transcribe on the machine. One frontend bundle
  // ships against builds compiled with different features, so it cannot know
  // from its own source whether the local path exists.
  sttLocalAvailable:    () => invoke<boolean>('stt_local_available'),
  // Fractal Memory Search: fetch the bge-small embedding model (~130 MB) into
  // the models dir. Idempotent — a no-op if already present — so it is safe to
  // fire on startup. Progress streams over `cinderpaw://embedding-download-*`.
  downloadEmbeddingModel:   () =>
    invoke<string>('download_embedding_model'),
};

// ── Public façade ─────────────────────────────────────────────────────────────
export const tauri = {
  raw,

  chat: {
    stream:      async (messages: Message[], params: InferParams, sessionId: string) =>
      raw.chatStream(messages, params, sessionId),
    cloudStream: async (providerId: string, model: string, messages: Message[], params: InferParams, sessionId: string) =>
      raw.chatCloudStream(providerId, model, messages, params, sessionId),
    stop: async (sessionId: string) => raw.stopGeneration(sessionId),
  },

  conversations: {
    list:     async () => raw.loadConversations(),
    load:     async (id: string) => raw.loadConversation(id),
    save:     async (id: string, title: string, msgs: PersistedMessage[], agentId?: string | null) =>
      raw.saveConversation(id, title, msgs, agentId),
    rename:   async (id: string, title: string) => raw.renameConversation(id, title),
    delete:   async (id: string) => raw.deleteConversation(id),
    clearAll: async () => raw.clearAllConversations(),
  },

  projects: {
    list:   async () => raw.loadProjects(),
    save:   async (id: string, name: string, ids: string[]) =>
      raw.saveProject(id, name, ids),
    delete: async (id: string) => raw.deleteProject(id),
  },

  models: {
    list:      async () => raw.getModels(),
    loaded:    async () => raw.getLoadedModel(),
    load:      async (path: string, maxContext?: number) => raw.loadModel(path, maxContext),
    startLoad: async (path: string, maxContext?: number) => raw.startModelLoad(path, maxContext),
    unload:    async () => raw.unloadModel(),
    delete:    async (path: string) => raw.deleteModel(path),
  },

  settings: {
    get:  async () => raw.getSettings(),
    save: async (s: Settings) => raw.saveSettings(s),
    setDesktopControl: async (enabled: boolean) => raw.setDesktopControlEnabled(enabled),
    setDesktopControlYolo: async (enabled: boolean) => raw.setDesktopControlYolo(enabled),
    setTokenBudget: async (budget: number | null) => raw.setTokenBudgetConversation(budget),
    setRsiBudget: async (budget: number | null) => raw.setRsiBudget(budget),
    setRsiAllowCloudDreams: async (enabled: boolean) => raw.setRsiAllowCloudDreams(enabled),
    setDreamsEnabled: async (enabled: boolean) => raw.setDreamsEnabled(enabled),
  },

  hf: {
    search:        async (query: string, cursor?: string | null) =>
      raw.searchHfModels(query, cursor),
    detail:        async (repoId: string) =>
      raw.getHfModelDetail(repoId),
    modelSizeInfo: async (repoId: string, filename: string) =>
      raw.getModelSizeInfo(repoId, filename),
  },

  download: {
    start:  async (repoId: string, filename: string) =>
      raw.downloadModel(repoId, filename),
    cancel: async (modelId: string) =>
      raw.cancelDownload(modelId),
  },

  voice: {
    saveBlob:      async (bytes: number[], ext: string) => raw.saveVoiceBlob(bytes, ext),
    modelPresent:  async (modelSize: string) => raw.whisperModelPresent(modelSize),
    transcribe:    async (pcm: number[], modelSize: string) => raw.transcribeAudio(pcm, modelSize),
    transcribeCloud: async (audioPath: string, provider: string, language?: string) =>
      raw.transcribeAudioCloud(audioPath, provider, language),
    downloadModel: async (modelSize: string) => raw.downloadWhisperModel(modelSize),
    ttsProviders:  async () => raw.ttsProviders(),
    ttsHasKey:     async (providerId: string) => raw.ttsHasKey(providerId),
    ttsReady:      async (providerId: string) => raw.ttsReady(providerId),
    ttsVoices:     async (providerId: string) => raw.ttsVoices(providerId),
    voicePresent:  async (engine: string, voice: string) => raw.ttsVoicePresent(engine, voice),
    voiceDownload: async (engine: string, voice: string) => raw.downloadTtsVoice(engine, voice),
    // An empty `apiKey` means "leave the stored key untouched" all the way down
    // to the keychain, so re-saving only a region cannot wipe a working key.
    saveTtsKey:    async (providerId: string, apiKey: string, baseUrl?: string, model?: string) =>
      raw.saveByokProvider(providerId, true, apiKey, baseUrl ?? null, model ?? null),
    // Purges the key from the OS keychain. The way out of a stored key nobody
    // remembers saving — `saveTtsKey` with an empty string deliberately does not
    // delete, so removal needs its own door.
    forgetTtsKey:  async (providerId: string) => raw.removeByokProvider(providerId),
    speak:         async (sessionId: string, text: string, provider?: string, voice?: string) =>
      raw.speakText(sessionId, text, provider, voice),
    stopSpeaking:  async (sessionId: string) => raw.stopSpeaking(sessionId),
  },

  system: {
    info: async () => raw.getSystemInfo(),
    diskEncryption: async () => raw.diskEncryptionStatus(),
  },

  files: {
    readAsText: async (path: string) => raw.readFileAsText(path),
  },

  skills: {
    listInstalled:      async () => raw.listInstalledSkills(),
    getContent:         async (id: string) => raw.getInstalledSkillContent(id),
    fetchRemote:        async () => raw.fetchRemoteSkills(),
    fetchCommunity:     async () => raw.fetchCommunitySkills(),
    previewRemote:      async (url: string) => raw.previewRemoteSkill(url),
    previewLocal:       async (path: string) => raw.previewLocalSkill(path),
    exists:             async (id: string) => raw.skillExistsCmd(id),
    installFromCatalogue: async (id: string) => raw.installCapability(id),
    installFromUrl:       async (url: string, overwrite: boolean) =>
      raw.installSkillFromUrl(url, overwrite),
    installFromFile:      async (path: string, overwrite: boolean) =>
      raw.installSkillFromFile(path, overwrite),
    remove:             async (id: string) => raw.removeSkill(id),
  },

  mcp: {
    catalog:    async () => raw.mcpCatalog(),
    list:       async () => raw.mcpList(),
    install:    async (id: string, values: Record<string, string>) => raw.mcpInstall(id, values),
    setEnabled: async (id: string, enabled: boolean) => raw.mcpSetEnabled(id, enabled),
    remove:     async (id: string) => raw.mcpRemove(id),
    listTools:  async (id: string) => raw.mcpListTools(id),
    callTool:   async (id: string, tool: string, argsJson: string) => raw.mcpCallTool(id, tool, argsJson),
  },

  connectors: {
    catalog:    async () => raw.connectorsCatalog(),
    list:       async () => raw.connectorsList(),
    save:       async (id: string, secrets: Record<string, string>, allowlist: string[], channels: string[], mode?: string, knowledgeBase?: string) => raw.connectorsSave(id, secrets, allowlist, channels, mode, knowledgeBase),
    setEnabled: async (id: string, enabled: boolean) => raw.connectorsSetEnabled(id, enabled),
    remove:     async (id: string) => raw.connectorsRemove(id),
    whatsappQr: async () => raw.connectorsWhatsappQr(),
    /** Phase 3 accounts: connectors that pair by signing in rather than by
     *  pasting a token. `pairPoll` is safe to call on a card that has already
     *  finished — the state it is in is the answer. */
    accounts:   async () => raw.connectorAccounts(),
    pairStart:  async (id: string) => raw.connectorPairStart(id),
    pairPoll:   async (id: string) => raw.connectorPairPoll(id),
  },

  cinderpawAgent: {
    sendMessage: async (content: string, sessionId: string, images?: string[], inferParams?: { temperature?: number; max_tokens?: number }) =>
      raw.cinderpawSendMessage(content, sessionId, images, inferParams),
    status:      async () => raw.cinderpawAgentStatus(),
    stop:        async (sessionId?: string) => raw.cinderpawStopGeneration(sessionId ?? null),
    /** Agent Cowork S4 — answer an approval request rendered in chat. The
     *  sidecar acks via the terminal cowork_event for that requestId. */
    coworkApprovalResolve: async (requestId: string, approve: boolean) =>
      raw.cinderpawCoworkApprovalResolve(requestId, approve ? 'approve' : 'reject'),
    coworkHistory: async (threadId?: string | null) => raw.cinderpawCoworkHistory(threadId ?? null),
    coworkSendMessage: async (toAgentId: string, body: string, threadId?: string) =>
      raw.cinderpawCoworkSendMessage(toAgentId, body, threadId),
    /** Abort a teammate's in-flight turn. A cowork turn runs under the session
     *  `cowork:<agentId>`, so the existing stop path already reaches it — no
     *  second mechanism, and it stops exactly one teammate rather than the
     *  user's own chat. */
    coworkStop: async (agentId: string) => raw.cinderpawStopGeneration(`cowork:${agentId}`),
  },

  rsi: {
    init:            async () => raw.rsiInit(),
    status:          async () => raw.rsiStatus(),
    start:           async (goal: string, budgetUsd: number, maxIterations: number, concurrency: number) =>
      raw.rsiStart(goal, budgetUsd, maxIterations, concurrency),
    stop:            async () => raw.rsiStop(),
    setConcurrency:  async (concurrency: number) => raw.rsiSetConcurrency(concurrency),
    dreamTelemetry:  async (limit = 12) => raw.rsiDreamTelemetry(limit),
    journalRecent:   async (limit = 12) => raw.rsiJournalRecent(limit),
    /** §7.4 Tree of Champions — per-niche champions, highest score first. */
    championTree:    async () => raw.rsiChampionTree(),
    /** BRSI §2.8 `user` Wake trigger — run one dream episode now. */
    dreamNow:        async () => raw.rsiDreamNow(),
    /** Faza 6 (L6) Meta Evolution — status / evolve / rollback / history.
     *  Reply arrives async via `events.onMetaResult`. */
    meta:            async (op: 'status' | 'evolve' | 'rollback' | 'history') =>
      raw.cinderpawMeta(op),
    /** Slice A6 (L5 Governance) — safety-rules card + approval inbox.
     *  Reply arrives async via `events.onGovernanceResult`. */
    governance:      async (op: 'status' | 'verify' | 'approve' | 'reject', args?: { policyId?: string; reason?: string }) =>
      raw.cinderpawGovernance(op, args?.policyId, args?.reason),
    /** Phase B (L4 Architecture Evolution) — the Architecture card.
     *  Reply arrives async via `events.onModulesResult`. */
    modules:         async (op: 'list' | 'approve' | 'reject' | 'demote', args?: { moduleId?: string; seam?: string; note?: string }) =>
      raw.cinderpawModules(op, args?.moduleId, args?.seam, args?.note),
    /** Faza 2 Slice 5 — ask the sidecar for the pending code-patch queue.
     *  The full snapshot arrives async via `events.onCodePatches`. */
    codePatchesList: async () => raw.cinderpawCodePatchesList(),
    /** Faza 2 Slice 5 — approve or reject one pending patch. The sidecar
     *  acks via `code_patch_resolved` and re-emits `code_patches`. */
    codePatchResolve: async (patchId: string, action: 'approve' | 'reject') =>
      raw.cinderpawCodePatchResolve(patchId, action),
    /** Faza 4 (L2 LoRA) — ask for the review inbox; snapshot arrives via
     *  `events.onLoraReviews`. */
    loraReviewsList: async () => raw.cinderpawLoraReviewsList(),
    /** Faza 4 — approve (promote + apply live) or reject one review card. */
    loraReviewResolve: async (cardId: string, action: 'approve' | 'reject') =>
      raw.cinderpawLoraReviewResolve(cardId, action),
    /** Faza 4 — run one training cycle; outcome via `events.onLoraTrainResult`. */
    loraTrain: async (domain?: string) => raw.cinderpawLoraTrain(domain),
  },

  agents: {
    getPresets: async () => raw.getAgentPresets(),
    save:       async (cfg: AgentConfig) => raw.saveAgent(cfg),
    getAll:     async () => raw.getAgents(),
    delete:     async (id: string) => raw.deleteAgent(id),
    run:        async (agentId: string, prompt: string, sessionId: string) =>
      raw.runAgent(agentId, prompt, sessionId),
  },

  memory: {
    getGraph: (): Promise<MemoryGraphSnapshot> => raw.getMemoryGraph(),
    addFacts: (facts: MemoryFactInput[]): Promise<number> => raw.addMemoryFacts(facts),
    /** Sprint 1.6 — Memory Resume. First-launch safe (every field null). */
    getLastTask: (): Promise<LastTaskView> => raw.getLastTask(),
  },
};

export { events } from './events';
