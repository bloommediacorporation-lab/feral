// CinderpawAgent/src/config.ts
// Single source of truth for CINDERPAW_* environment configuration read by the
// TypeScript sidecar (CinderpawAgent/src/). Rust-side vars (crates/cinderpaw-core,
// src-tauri) are documented separately in docs/CONFIGURATION.md §1/§2 and
// are NOT part of this schema.
//
// R3: replaces ad-hoc process.env.CINDERPAW_* reads. New vars: add a schema
// row here, do not read process.env directly elsewhere (tests/config.test.ts
// enforces this for new *literal* `process.env.CINDERPAW_X` reads; call sites
// that take an injected `env: NodeJS.ProcessEnv` parameter for testability
// — e.g. loadWorkspaceRoots, loadBrainConfig, shouldAutostartPassive,
// perf-policy's readEnvNumber — are unaffected by this schema and keep
// reading their injected `env` directly; that pattern predates R3 and
// migrating it would break test env-injection).
//
// docs/CONFIGURATION.md's TS-var table is generated FROM this file by
// scripts/gen-config-docs.mjs — do not hand-edit the table between the
// <!-- TS-SCHEMA-TABLE --> markers.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { assertValidRunId } from "./core/run-id.ts";

export interface ConfigEntry {
  name: string;
  type: "bool" | "int" | "path" | "list" | "string";
  default: string | number | boolean | null;
  description: string;
  security: boolean;
}

export const CONFIG_SCHEMA: ConfigEntry[] = [
  // ---- Security group (read this first) ----------------------------------
  { name: "CINDERPAW_DB_KEY", type: "string", default: null,
    description: "32-byte base64 key for at-rest encryption of sensitive DB columns. Anyone who can read this can read the DB.", security: true },
  { name: "CINDERPAW_WORKSPACE", type: "list", default: null,
    description: "TS sidecar path-list of FS roots. Unset = launch cwd + the user's home dir (broad by default; set to RESTRICT). The call-time deny wall (tool-permissions.ts) protects ~/.cinderpaw, ~/.ssh and CINDERPAW_FS_DENY regardless of roots.", security: true },
  { name: "CINDERPAW_FS_DENY", type: "list", default: null,
    description: "Extra comma/semicolon-separated paths the fs tools may never touch, on top of the built-in ~/.cinderpaw + ~/.ssh deny wall.", security: true },
  { name: "CINDERPAW_ENABLE_SHELL_EXEC", type: "bool", default: true,
    description: "Registers shell_exec (argv-only, whitelisted). On by default; set to \"false\" to disable. Doc note: an earlier draft of this doc said default off — the code's actual default is ON.", security: true },
  { name: "CINDERPAW_ENABLE_NOTEBOOK", type: "bool", default: true,
    description: "Registers `notebook`, a persistent JavaScript interpreter with every other tool bound as an async function, so the agent can compose tool calls in code instead of one per turn. ON by default since 2026-08-26: it is the largest measured lever on token cost, because two tool calls in one cell is ONE completion instead of two, and every completion re-sends ~10.7k tokens of schema + system prompt. Set to \"false\" to disable. Cells run in an isolated vm context with no ambient fetch/process/require, and every capability still goes through the tool registry and its permission checks — but it is a hardened context, not a jail against hostile input, which is why it is OWNER-ONLY: any session running under a profile (connector persona, WhatsApp public mode, a cowork teammate) is refused it at both the advertise and the execute gate. See tools/tiers.ts::OWNER_ONLY_TOOLS.", security: true },
  { name: "CINDERPAW_HOST_TOOLS", type: "string", default: null,
    description: "Path to a JSON file of tools the HOST will execute, in MCP's `{tools:[{name,description,inputSchema}]}` shape. When set, the agent calls these by name and the sidecar emits a `tool_request` event, suspending the call until the host answers with `tool_response` — so the host, not the agent, performs the action. Needed wherever the host owns the state being acted on and must record the call itself: tau2-bench grades a fresh environment replayed from ITS transcript, so a tool the harness never saw did not happen. Setting it also flips tool tiering — the host's tools are what get advertised and the built-ins move behind the on-demand drawer (list_tools/load_tool still reach every one of them), because a host that declares a tool set is declaring the job; measured on tau2's airline domain that cut the per-completion prefix from 16.5k to 10.8k tokens. Unset (the default, and every normal install) registers nothing and costs nothing. Not a sandbox escape: the host process spawned this one and already has everything it has.", security: true },
  { name: "CINDERPAW_ENABLE_DESKTOP_CONTROL", type: "bool", default: false,
    description: "Registers control_app (OS accessibility-tree control). Off by default; set to \"true\" to enable.", security: true },
  { name: "CINDERPAW_DESKTOP_CONTROL_CONFIRM", type: "bool", default: true,
    description: "Per-action confirmation dialog for control_app writes. On by default; set to \"false\" to disable (inverse-toggle var — see report for why this call site is not migrated to cfgBool).", security: true },
  { name: "CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK", type: "bool", default: false,
    description: "Sidecar-internal escape hatch: when true, a transport with no askUser bridge may proceed without confirmation instead of failing closed.", security: true },
  { name: "CINDERPAW_FORGE_NO_PROMPT_OK", type: "bool", default: false,
    description: "Sidecar-internal escape hatch: when true, tool_forge may create/update a tool on a transport with no askUser bridge instead of failing closed. This approves running agent-written code unattended — headless deployments only.", security: true },
  { name: "CINDERPAW_PERMISSION_MODE", type: "string", default: null,
    description: "What the agent is allowed to change: \"read_only\" (reads anything, writes nothing — no file writes, no destructive/machine-level commands; the mode for audits and for surfaces where the speaker is not the owner), \"workspace_write\" (default: writes inside the workspace roots, where the safety point can undo them), or \"full_access\" (guards that prevent mistakes step aside; the catastrophic denylist still applies). Resolution order: this var, then CINDERPAW_SHELL_WHITELIST=\"*\" (which still means full access), then `permission_mode` in ~/.cinderpaw/settings.json, then the default. The settings.json route is the only one that needs no relaunch — the sidecar reads it per command, so a change applies to the next one; an unknown value or an unparseable file means \"not configured\", never \"deny everything\".", security: true },
  { name: "CINDERPAW_AUTONOMOUS", type: "bool", default: false,
    description: "Walk-away mode: ask_user does not block for a human. It takes the recommended option (or the first) immediately and logs the decision, so a long task runs unattended. The end-of-turn summary reports every auto-decision. Off by default.", security: true },
  { name: "CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS", type: "list", default: null,
    description: "Comma-separated allowlist of app names control_app may target. Empty = fail closed. (Read by the Rust host, not CinderpawAgent/src.)", security: true },
  { name: "CINDERPAW_FETCH_DOMAINS", type: "list", default: null,
    description: "Comma-separated domain allowlist for fetch_url. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT.", security: true },
  { name: "CINDERPAW_HTTP_DOMAINS", type: "list", default: null,
    description: "Comma-separated domain allowlist for http_request. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT.", security: true },
  { name: "CINDERPAW_EXTERNAL_WRITE_BUDGET", type: "int", default: 50,
    description: "How many STATE-CHANGING external requests (POST/PUT/PATCH/DELETE) one session may make before the egress proxy stops it. Bounds a runaway loop that keeps changing things outside this machine — ad spend, published posts, CRM rows — during an unattended run. It caps VOLUME, not severity: one wrong write is inside any budget. 0 disables the cap.", security: true },
  { name: "CINDERPAW_DRY_RUN", type: "bool", default: false,
    description: "Log every STATE-CHANGING external request (POST/PUT/PATCH/DELETE) and do NOT send it. The agent is told the call was a dry run rather than handed a fake success, so it cannot build its next step on a write that never happened. The honest first run against a real ad or social account: let it do the whole task, then read exactly what it would have changed.", security: true },
  { name: "CINDERPAW_WRITE_CONFIRM_HOSTS", type: "list", default: null,
    description: "Hosts whose STATE-CHANGING requests are REFUSED while running unattended (CINDERPAW_AUTONOMOUS). Reads are unaffected. Declared by the operator, never by the model — this is the guard that does not depend on the agent realising a call is expensive. Deliberately a human-declared list rather than built-in patterns for known money endpoints: a pattern list fails open for every API not on it while reading as though everything is covered.", security: true },
  { name: "CINDERPAW_TRUSTED_LOCAL_ORIGINS", type: "list", default: null,
    description: "Comma-separated exact origins (scheme+host+port) on loopback/private addresses that the SSRF guard may reach, for services the OPERATOR runs themselves. Exact-origin match only — trusting http://127.0.0.1:8080 does not trust any other local port — and the tool's own allowedDomains still applies. Extends the single CINDERPAW_SEARXNG_URL exemption to any self-hosted backend.", security: true },
  { name: "CINDERPAW_TOOL_ALLOWED_DOMAINS", type: "list", default: null,
    description: "Set BY the sidecar ON a forged tool's child process — not something a user configures. Carries the hostnames that tool declared via tool_forge's `allowed_domains`; the runner turns it into an EgressProxy-backed globalThis.fetch, so a tool that declared nothing has no network. Setting it in the parent environment has no effect: createCustomTool always overwrites it from the tool's own record.", security: true },
  { name: "CINDERPAW_TRUSTED_BASE_URLS", type: "list", default: null,
    description: "Extra base URLs the inference router may call beyond loopback.", security: true },
  { name: "CINDERPAW_SHELL_WHITELIST", type: "list", default: null,
    description: "RESTRICTS shell_exec to a named set of binaries (e.g. \"git,node\"). Unset means any binary, which is the default: the old default list had the OS shells on it, so `sh -c \"…\"` ran anything anyway and the list only failed direct calls to unlisted tools like ffmpeg or docker. \"*\" is accepted as the historical spelling of \"no restriction\" and additionally selects full_access (see CINDERPAW_PERMISSION_MODE).", security: true },
  { name: "CINDERPAW_SHELL_PATH_EXTRA", type: "list", default: null,
    description: "Extra directories appended to the PATH every spawned child sees, on top of the well-known install locations (Git bin, nodejs, npm global on Windows; /usr/local/bin, homebrew, ~/.local/bin, ~/.bun/bin, ~/.cargo/bin elsewhere). Needed because the agent inherits whatever PATH launched the gateway, so a tool a terminal finds can be invisible here — that is what made `bash` fail with a permissions-sounding error. Appended, never prepended, so it cannot change which binary an already-working call resolves to. Directories that do not exist are ignored.", security: true },
  { name: "CINDERPAW_SHELL_DENYLIST", type: "list", default: null,
    description: "Overrides the built-in shell_exec denylist (dangerous binaries refused even in YOLO mode).", security: true },
  { name: "CINDERPAW_PROACTIVE_ENABLED", type: "bool", default: false,
    description: "Master enable for the proactive/mood-engine loop.", security: true },
  { name: "CINDERPAW_INNER_THOUGHTS_ENABLED", type: "bool", default: false,
    description: "Sub-flag enabling the inner-thoughts loop.", security: true },

  // ---- Inference / model selection ----------------------------------------
  { name: "CINDERPAW_MODEL", type: "string", default: "qwen2.5:7b",
    description: "Model id sent to the inference provider.", security: false },
  { name: "CINDERPAW_PROVIDER", type: "string", default: "openai_compatible",
    description: "Provider family adapter to use.", security: false },
  { name: "CINDERPAW_BASE_URL", type: "string", default: "http://127.0.0.1:11435",
    description: "Inference base URL the sidecar points at.", security: false },
  { name: "CINDERPAW_API_KEY", type: "string", default: null,
    description: "Bearer token for the primary provider.", security: false },
  { name: "CINDERPAW_BYOK_PROVIDER", type: "string", default: null,
    description: "Wizard-saved BYOK provider id; RSI's live-router model id falls back to this.", security: false },
  { name: "CINDERPAW_LOCAL_BASE_URL", type: "string", default: null,
    description: "Loopback address of the bundled local engine, set by the host. Used ONLY as the degrade-to-local fallback when the primary is a cloud provider; ignored when not loopback.", security: false },
  { name: "CINDERPAW_LOCAL_MODEL", type: "string", default: null,
    description: "Model id the bundled local engine serves (fallback target companion to CINDERPAW_LOCAL_BASE_URL).", security: false },
  { name: "CINDERPAW_LOCAL_API_KEY", type: "string", default: null,
    description: "Bearer token for the loopback local engine (the host's local API token).", security: true },
  { name: "CINDERPAW_RATE_LIMIT_RPM", type: "int", default: 0,
    description: "Requests-per-minute cap applied to every inference endpoint, overriding the built-in published caps (NVIDIA NIM free tier = 40). 0 uses those defaults. Set this if you are on a paid tier with a different limit, or share one API key with something outside Cinderpaw.", security: false },
  { name: "CINDERPAW_FALLBACK_PROVIDER", type: "string", default: "ollama",
    description: "Provider to fall back to if the primary is unreachable.", security: false },
  { name: "CINDERPAW_FALLBACK_MODEL", type: "string", default: null,
    description: "Model to fall back to.", security: false },
  { name: "CINDERPAW_FALLBACK_BASE_URL", type: "string", default: "http://localhost:11434",
    description: "Base URL for the fallback provider.", security: false },
  { name: "CINDERPAW_FALLBACK_API_KEY", type: "string", default: null,
    description: "Bearer token for the fallback provider.", security: false },
  { name: "CINDERPAW_OLLAMA_NUM_CTX", type: "int", default: null,
    description: "Override Ollama's num_ctx.", security: false },
  { name: "CINDERPAW_MAX_CONTEXT", type: "int", default: 8192,
    description: "Hard ceiling on context length the router allows.", security: false },
  { name: "CINDERPAW_SHELL_MAX_TIMEOUT_MS", type: "int", default: 300_000,
    description: "Ceiling on shell_exec's per-call timeout_ms (clamped to 60s..60min). Raise it when a real build — cargo, gradle, a cold docker layer — legitimately runs past 5 minutes; the process is hard-killed at this bound and the agent cannot tell that apart from a genuine failure.", security: true },
  { name: "CINDERPAW_TURN_BUDGET_MS", type: "int", default: 1_200_000,
    description: "Wall-clock budget for ONE agent turn (clamped to 60s..6h). The iteration ceiling bounds tool-call count, not time; this bounds time. Only stops NEW iterations, so an in-flight tool is never cut off. Matters most on connectors, which have no Stop button.", security: false },
  { name: "CINDERPAW_SUMMARY_EXCERPT_CHARS", type: "int", default: 24_000,
    description: "Characters of the compacted transcript fed to the working-memory summarizer (head+tail sampled). Raise on big-context models so long tool-heavy tasks keep more detail in the summary note.", security: false },
  { name: "CINDERPAW_UNATTENDED_CONTINUATIONS", type: "int", default: 24,
    description: "Automatic continuations allowed after a turn hits the wall-clock budget during an UNATTENDED run (cron job, or a connector message answered while nobody is watching). 0 disables continuation and restores the old behaviour, where a long task simply stopped half-done and was reported as finished. Total wall clock is roughly (this + 1) x CINDERPAW_TURN_BUDGET_MS, additionally capped by CINDERPAW_MISSION_DEADLINE_MS, and by CINDERPAW_CRON_JOB_TIMEOUT_MS for cron. The default of 3 was a ceiling nobody chose: (3+1) x 20min is 80 minutes, which was recorded for weeks as an observed limit on how long the agent could work before someone read the arithmetic. It is sized at the deadline now, so the counter is the safety net and the deadline is the term.", security: false },
  { name: "CINDERPAW_MISSION_DEADLINE_MS", type: "int", default: 28_800_000,
    description: "Wall-clock deadline for a whole UNATTENDED run, across all its continuations. Default 8 hours — a working day, which is the promise: give it a task, leave, come back to it done. 0 means no deadline at all, which is NOT the safe setting: the counter above is a counter, not a term, and without a deadline a wedged run keeps its whole continuation budget to burn tokens in. Checked between turns, so an in-flight turn is never cut off — the real stop time can overrun by up to one turn budget.", security: false },
  { name: "CINDERPAW_ATTACHMENT_MAX_CHARS", type: "int", default: 12_000,
    description: "Characters kept from ONE inbound attachment (a .txt/.md/code file, or the text extracted from a PDF) before it is truncated into the prompt. The default is sized for an 8k local context; raise it on a big-context cloud model so a whole document arrives in one message instead of a head slice.", security: false },
  { name: "CINDERPAW_TOOL_GRAMMAR", type: "string", default: null,
    description: "Optional GBNF grammar to constrain tool-call output. Presence alone also toggles useToolGrammar (default on; set to literal \"false\" to disable — inverse-toggle var, not migrated).", security: false },
  { name: "CINDERPAW_VERSION", type: "string", default: null,
    description: "Reported in startup logs; set by installer.", security: false },

  // ---- Embed / GPU ----------------------------------------------------------
  { name: "CINDERPAW_EMBED_GPU_LAYERS", type: "int", default: null,
    description: "Embedding-model layers offloaded to GPU. 0 = CPU-only.", security: false },
  { name: "CINDERPAW_EMBED_MODEL", type: "path", default: null,
    description: "Path to the embed GGUF; auto-discovered when unset.", security: false },
  { name: "CINDERPAW_EMBED_CHUNK", type: "int", default: null,
    description: "Embedder input chunk size (tree-builder.ts).", security: false },

  // ---- Budgets ---------------------------------------------------------------
  { name: "CINDERPAW_BUDGET_CONVERSATION", type: "int", default: 5_000_000,
    description: "Per-conversation token ceiling.", security: false },
  { name: "CINDERPAW_BUDGET_DAY", type: "int", default: 50_000_000,
    description: "Per-day token ceiling.", security: false },
  { name: "CINDERPAW_BUDGET_POLICY", type: "string", default: "compress_and_continue",
    description: "\"stop\" or \"compress_and_continue\".", security: false },
  { name: "CINDERPAW_RSI_MAX_COST_USD", type: "string", default: null,
    description: "RSI background USD cap (float). Unset = local-only.", security: false },
  { name: "CINDERPAW_CLOUD_TRANSCRIPT_BUDGET", type: "int", default: 200_000,
    description: "Cloud-specific transcript-size budget (AgentLoop.CLOUD_TRANSCRIPT_BUDGET fallback).", security: false },

  // ---- Performance -------------------------------------------------------------
  { name: "CINDERPAW_TTFT_DEADLINE_MS", type: "int", default: null,
    description: "Time-to-first-token cap (perf-policy.ts, positive int only).", security: false },
  { name: "CINDERPAW_TOTAL_DEADLINE_MS", type: "int", default: null,
    description: "Whole-completion cap.", security: false },
  { name: "CINDERPAW_STALL_MS", type: "int", default: null,
    description: "Inter-token stall cap; wins over CINDERPAW_CLOUD_IDLE_TIMEOUT_MS when both set.", security: false },
  { name: "CINDERPAW_CLOUD_IDLE_TIMEOUT_MS", type: "int", default: 60_000,
    description: "Legacy cloud-only idle-stream timeout back-compat knob.", security: false },

  // ---- Memory (FMS) ------------------------------------------------------------
  { name: "CINDERPAW_FMS_MAX_LEAVES", type: "int", default: null,
    description: "Cap on the FMS leaf store size.", security: false },
  { name: "CINDERPAW_FMS_DEDUP_SPAN_MS", type: "int", default: 30 * 24 * 60 * 60 * 1000,
    description: "Minimum age gap between two near-identical memories before the cross-session pass will collapse them. It is a floor, not a window: leaves recorded FURTHER APART than this merge, and recent ones deliberately do not, because the per-write cosine merge already handles same-session duplicates. Raise it to keep more separate copies of a fact, lower it to collapse more aggressively. The old description said \"whose last touch is within this window\", which is the opposite of what the code does and of what the pass is for.", security: false },
  { name: "CINDERPAW_FMS_MERGE_THRESHOLD", type: "string", default: "0.92",
    description: "Cosine threshold (float) above which leaves merge.", security: false },
  { name: "CINDERPAW_FMS_EVICTION", type: "string", default: null,
    description: "Eviction strategy. Only \"none\" (or \"noeviction\") is a real choice: it turns eviction off. Anything else, including the \"lru\" this line used to give as its example, selects the default age-and-hit-count policy — a value that is not understood now says so on stderr and falls back, instead of being silently ignored.", security: false },
  { name: "CINDERPAW_MERGE_THRESHOLD", type: "string", default: null,
    description: "Deprecated alias for CINDERPAW_FMS_MERGE_THRESHOLD. Both names now feed BOTH merge paths (the per-write cosine merge and the cross-session dedup pass); until 2026-09-02 they fed one each, so setting the canonical name moved one threshold and left the other at its default, in the same process, with nothing on screen to say so.", security: false },
  { name: "CINDERPAW_FMS_QUERY_TOPK", type: "int", default: 20,
    description: "Semantic candidates the tree descent returns before re-rank. Raising it widens what recall can consider, at more cosine work per query.", security: false },
  { name: "CINDERPAW_FMS_QUERY_BEAM", type: "int", default: 20,
    description: "How many tree nodes survive at each level of the descent, and so the primary control on recall versus tail latency. At 2700 memories and branch 8 the first level holds ~338 clusters, so the default of 20 discards roughly 94% of the corpus before any single memory is scored: that is what makes the search cheap, and it is also its recall ceiling. Never applied below CINDERPAW_FMS_QUERY_TOPK, since a narrower beam would silently truncate the result rather than shrink the search.", security: false },
  { name: "CINDERPAW_TREE_BRANCH", type: "int", default: null,
    description: "Branching factor for fractal tree build.", security: false },
  { name: "CINDERPAW_TREE_CLUSTER_MAX_CHARS", type: "int", default: null,
    description: "Max cluster size in chars.", security: false },
  { name: "CINDERPAW_TREE_ITEM_MAX_CHARS", type: "int", default: null,
    description: "Max item size in chars.", security: false },
  { name: "CINDERPAW_PII_REDACTION", type: "string", default: "on",
    description: "Master switch for PII redaction in memory writes; \"off\" disables (inverse-toggle var).", security: false },
  { name: "CINDERPAW_JINA_API_KEY", type: "string", default: null,
    description: "Jina Reader key for read_webpage / deep_research.", security: false },
  { name: "CINDERPAW_SEARXNG_URL", type: "string", default: null,
    description: "Base URL of a SearXNG instance backing web_search (e.g. http://127.0.0.1:8888). A loopback/private origin here is trusted by the egress SSRF guard for web_search ONLY — set it only to an instance you run.", security: true },
  { name: "CINDERPAW_DDG_MIN_INTERVAL_MS", type: "int", default: 5000,
    description: "Minimum gap between DuckDuckGo queries on the keyless web_search fallback. DDG throttles by rate, not volume: measured from one IP, 12 back-to-back queries got 7 served then a >10min anti-bot block, while the same queries paced 3s/5s/10s apart all succeeded. The limit is per-IP and shared with everything else on the connection, so raise this if you see rate_limited; ~3s is the floor. 0 disables pacing. Ignored when CINDERPAW_SEARXNG_URL is set.", security: false },

  // ---- RSI / dream cycle / governance -------------------------------------------
  { name: "CINDERPAW_RSI_PASSIVE", type: "bool", default: true,
    description: "RSI supervisor passive mode. \"false\" disables (read via injected env in passive-supervisor.ts).", security: false },
  { name: "CINDERPAW_RSI_ALLOW_CLOUD", type: "bool", default: false,
    description: "Opt-in: allow RSI to call cloud providers (anti-burn guard).", security: false },
  { name: "CINDERPAW_RSI_MAX_ITER", type: "int", default: null,
    description: "Pin the episode iteration cap; unset = dynamic (genome/policy-derived).", security: false },
  { name: "CINDERPAW_RSI_MAX_TOKENS", type: "int", default: null,
    description: "Per-call token cap for RSI evaluations.", security: false },
  { name: "CINDERPAW_RSI_EVAL_TOKEN_BUDGET", type: "int", default: null,
    description: "Per-eval token budget in rsi/sidecar.ts.", security: false },
  { name: "CINDERPAW_RSI_CONCURRENCY", type: "int", default: 1,
    description: "Concurrent RSI evaluations.", security: false },
  { name: "CINDERPAW_RSI_COOLDOWN_MS", type: "int", default: 600_000,
    description: "Quiet period after a successful iteration.", security: false },
  { name: "CINDERPAW_RSI_IDLE_MS", type: "int", default: 180_000,
    description: "Quiet period before RSI wakes up.", security: false },
  { name: "CINDERPAW_RSI_POLL_MS", type: "int", default: null,
    description: "Manual poll cadence override.", security: false },
  { name: "CINDERPAW_RSI_ERROR_THRESHOLD", type: "int", default: 3,
    description: "Consecutive error count that triggers a sleep.", security: false },
  { name: "CINDERPAW_RSI_ERROR_WINDOW_MS", type: "int", default: 900_000,
    description: "Sliding window for the error counter.", security: false },
  { name: "CINDERPAW_RSI_EPISODE_MS", type: "int", default: null,
    description: "Max wall-clock per episode.", security: false },
  { name: "CINDERPAW_RSI_PLATEAU_ITERS", type: "int", default: null,
    description: "Iters-with-no-improvement before RSI bails.", security: false },
  { name: "CINDERPAW_RSI_MAX_UNANSWERED_RATIO", type: "string", default: "0.5",
    description: "Fraction of evaluations that may come back with no gradable answer before the episode is stopped. Evolution needs measurements; when most of the suite goes unanswered the engine is comparing genomes on questions none of them answered, and every token after that is wasted. Set to 1 to disable the breaker.", security: false },
  { name: "CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE", type: "int", default: 8,
    description: "Evaluations that must run before the unanswered-response breaker can trip, so a couple of unlucky calls at the start of an episode cannot abort it.", security: false },
  { name: "CINDERPAW_RSI_SCHEDULE_MS", type: "int", default: null,
    description: "Force a fixed schedule (e.g. weekly wake).", security: false },
  { name: "CINDERPAW_RSI_STAGNATION_THRESHOLD", type: "int", default: null,
    description: "Hard stagnation threshold.", security: false },
  { name: "CINDERPAW_RSI_STOP_ON_ACTIVITY", type: "bool", default: false,
    description: "Pause RSI when the user is active.", security: false },
  { name: "CINDERPAW_RSI_TELEMETRY", type: "path", default: null,
    description: "Telemetry JSONL file path override (default ~/.cinderpaw/rsi/dream.jsonl). Type is a path, not a bool — the existing doc mislabeled it as a bool switch.", security: false },
  { name: "CINDERPAW_CODE_RSI_REPO", type: "path", default: null,
    description: "Source repo for code-RSI to propose/apply against; without it, code-RSI rounds and live-apply are unavailable.", security: false },

  // ---- L4 modules ----------------------------------------------------------------
  { name: "CINDERPAW_MODULE_SEED", type: "int", default: 1,
    description: "Deterministic seed for module selection (module-host.ts).", security: false },

  // ---- Cron / proactive / inner thoughts ------------------------------------------
  { name: "CINDERPAW_CRON_TICK_MS", type: "int", default: 30_000,
    description: "Tick interval for the cron scheduler.", security: false },
  { name: "CINDERPAW_CRON_JOB_TIMEOUT_MS", type: "int", default: 3_600_000,
    description: "Max wall-clock for a single cron job, and the deadline handed to its unattended run. The old default of 5 minutes predates the agent doing multi-step work on a reasoning model, where one completion alone can take two: a scheduled job was cut off mid-task and the partial recorded as the result. One hour leaves room for a real job while still bounding a wedged one far below the mission deadline. Raise it for a scheduled overnight mission.", security: false },
  { name: "CINDERPAW_HEARTBEAT_INTERVAL_MS", type: "int", default: 30_000,
    description: "Watchdog / liveness heartbeat cadence.", security: false },
  { name: "CINDERPAW_THOUGHTS_COOLDOWN_MS", type: "int", default: 14_400_000,
    description: "Quiet period between thoughts (4h).", security: false },
  { name: "CINDERPAW_THOUGHTS_MIN_IDLE_MS", type: "int", default: 600_000,
    description: "User must be idle this long before a thought fires (10m).", security: false },
  { name: "CINDERPAW_THOUGHTS_INTERVAL_MS", type: "int", default: 120_000,
    description: "Wake-and-evaluate cadence (2m).", security: false },
  { name: "CINDERPAW_THOUGHTS_DAILY_CAP", type: "int", default: 3,
    description: "Hard cap on thoughts per user-day.", security: false },
  { name: "CINDERPAW_THOUGHTS_MOOD_THRESHOLD", type: "string", default: "0.5",
    description: "Mood gate (float); thoughts fire only above this score.", security: false },

  // ---- Connectors -------------------------------------------------------------------
  // (no CINDERPAW_DISCORD_CLIENT_ID read in CinderpawAgent/src today — Rust/UI side.)

  // ---- Brain Stack ------------------------------------------------------------------
  { name: "CINDERPAW_BRAIN", type: "bool", default: false,
    description: "Force-enable Brain Stack; if brain.json is missing, loadBrainConfig throws (read via injected env in brain-config.ts).", security: false },

  // ---- Workspace / paths / state -----------------------------------------------------
  { name: "CINDERPAW_HOME", type: "path", default: null,
    description: "Override the agent's profile dir (default ~/.cinderpaw/, resolved via homedir() when unset).", security: false },
  { name: "CINDERPAW_BENCHMARK_RUN_ID", type: "string", default: null,
    description: "Turns on BENCHMARK MODE for this process. Two effects, both about keeping one measured run from contaminating the next: (1) the profile dir moves to <home>/runs/<runId>/, so skills, memory, journals and DB from run N are invisible to run N+1 (invariant I13); (2) the network is restricted to CINDERPAW_BENCHMARK_ALLOW_HOSTS and nothing else — every other destination is refused at both network exits (tool egress proxy and inference router). Unset = off, normal behaviour. Must be path-safe (letters, digits, dot, underscore, hyphen).", security: true },
  { name: "CINDERPAW_BENCHMARK_ALLOW_HOSTS", type: "list", default: null,
    description: "The ONLY hosts reachable while benchmark mode is on. Comma/semicolon separated, matched like a domain allowlist (\"api.example.com\" matches that host and its subdomains). Ignored when CINDERPAW_BENCHMARK_RUN_ID is unset. Empty while benchmark mode is on means NOTHING is reachable — deliberately fail-closed, and every refusal names this variable so the fix is on screen rather than in a log.", security: true },
  { name: "CINDERPAW_DB", type: "path", default: "<profile>/data/cinderpaw.db",
    description: "Override the SQLite DB path. Defaults to data/cinderpaw.db INSIDE the profile dir (CINDERPAW_HOME, ~/.cinderpaw by default), so the database follows the profile rather than the working directory; it used to default to a relative path resolved against the cwd, which gave a standalone CLI a separate database per directory it was started from. A relative value set here is still resolved against the cwd, because that is what typing a relative path means. \":memory:\" is a sentinel and is not path-resolved. Falls back to a pre-rename data/feral.db when that is the file this install actually has.", security: false },
  { name: "CINDERPAW_AGENT_BASE_PROMPT", type: "string", default: null,
    description: "Universal operating manual injected into every model call; usually bundled.", security: false },

  // ---- Subagents ---------------------------------------------------------------------
  { name: "CINDERPAW_OPENROUTER_PROVIDER", type: "string", default: null,
    description: "Pin OpenRouter routing to a comma-separated list of endpoints, in preference order, with `allow_fallbacks: false` — routing may move within the list and may never leave it. One model id is served by many endpoints running different quantisations of the same weights, so the model id alone does not say which model answered; unpinned routing swung identical tau2 runs by 40 points. A single name is a single point of failure (measured 2026-09-02: one endpoint answered a third of its probes, and a task scored zero on a 429 from it), so name a primary and one or two as a net. Which endpoint actually served each call is reported back, so a fallback is a declared fact rather than a silent confound. Ignored unless the base URL is openrouter.ai; unset is right for ordinary use, where falling back freely is what keeps the agent answering.", security: false },
  { name: "CINDERPAW_SHUTDOWN_FLUSH_MS", type: "int", default: 8000,
    description: "How long a shutdown may spend writing what the last turn learned before the database closes. Memory extraction waits for the agent to be idle, which never arrives in a short-lived process (a cron job, a connector reply, a benchmark task), so without this the lesson dies with the process. Bounded because the caller kills us shortly after asking: a shutdown that hangs loses more than the lesson it was saving. 0 disables the flush.", security: false },
  { name: "CINDERPAW_RECALL_INJECTION", type: "bool", default: true,
    description: "Look memory up for the agent on every turn and put the hits in the prompt, instead of waiting for the model to call the `recall` tool. Off restores the old behaviour, where a run that never called the tool never read memory at all.", security: false },
  { name: "CINDERPAW_RECALL_INJECTION_MAX_CHARS", type: "int", default: 4000,
    description: "Cap on the injected recall block. A similarity search has no natural bound on how much it can match, so the block is cut on a line boundary at this size.", security: false },
  { name: "CINDERPAW_SUBAGENT_MAX_SUMMARY_CHARS", type: "int", default: 4000,
    description: "Cap on subagent summary length returned to parent (negative = unlimited).", security: false },
  { name: "CINDERPAW_ENABLE_SUBAGENTS", type: "bool", default: true,
    description: "Set `false` to withhold the `delegate_task` tool entirely. Each subagent spends its own model budget, so a run with a hard cost ceiling needs the capability gone, not discouraged — the model decides to delegate on its own. Withholds the TOOL only; `rlm()` still uses the same Subagent machinery.", security: false },
  { name: "CINDERPAW_MAX_COWORKERS", type: "int", default: null,
    description: "Cap on roster size for `cowork_create_teammate`. Unset = no cap. Every teammate runs its own loop on its own budget, so on a metered run the roster size is the cost multiplier. `0` forbids teammates outright.", security: false },

  // ---- LoRA trainer --------------------------------------------------------------------
  { name: "CINDERPAW_LORA_TRAINER_BIN", type: "path", default: null,
    description: "Absolute path to the trainer binary.", security: false },
  { name: "CINDERPAW_LORA_TRAIN_TIMEOUT_MS", type: "int", default: null,
    description: "Wall-clock cap on a single trainer invocation.", security: false },

  // ---- Build / dev / smoke --------------------------------------------------------------
  { name: "CINDERPAW_RUN_FRACTAL_BENCH", type: "bool", default: false,
    description: "Run the fractal benchmark as part of boot.", security: false },
  { name: "CINDERPAW_FRACTAL_BENCH_COUNT", type: "int", default: 50,
    description: "Benchmark corpus size.", security: false },
  { name: "CINDERPAW_FRACTAL_BENCH_SEED", type: "int", default: 1,
    description: "Benchmark RNG seed.", security: false },
  { name: "CINDERPAW_FRACTAL_BENCH_QUERIES", type: "path", default: null,
    description: "Override the benchmark query set.", security: false },
  { name: "CINDERPAW_FRACTAL_BENCH_MAX_LEAVES", type: "int", default: 0,
    description: "Cap the benchmark/dev fractal-memory leaf-store size (0 = unlimited / full corpus).", security: false },
  { name: "CINDERPAW_NO_COLOR", type: "bool", default: false,
    description: "Disable ANSI colour output in the TUI.", security: false },
];

/**
 * Read a configuration variable, under either name.
 *
 * Every `CINDERPAW_*` variable is becoming `CINDERPAW_*`. Someone who put one in a
 * shell profile, a systemd unit or a CI job months ago must not have it quietly
 * stop working because the app changed its name: a variable read under a name
 * nobody set looks exactly like a variable nobody set, and the symptom is "the
 * setting I configured does nothing", with no error anywhere to explain it.
 *
 * One helper here rather than at 130 call sites, because all five accessors
 * below funnel through this single read.
 */
const warnedLegacyNames = new Set<string>();

/**
 * The `CINDERPAW_`-prefixed name a `CINDERPAW_`-prefixed one used to have.
 *
 * The codebase names every variable by its CURRENT name; the old one survives
 * here, in one function, and nowhere else. That direction matters: while the
 * call sites were spelled `CINDERPAW_*`, "rename the variable" and "keep the old
 * one working" were the same edit, so every new call site had to remember to
 * pass a name the product no longer uses.
 */
function legacyName(name: string): string {
  return name.startsWith("CINDERPAW_") ? `FERAL_${name.slice(10)}` : name;
}

export function readEnv(name: string): string | undefined {
  const preferred = process.env[name];
  if (preferred !== undefined) return preferred;
  const legacy = legacyName(name);
  const value = process.env[legacy];
  if (value !== undefined && legacy !== name && !warnedLegacyNames.has(legacy)) {
    warnedLegacyNames.add(legacy);
    console.warn(
      `[cinderpaw] ${legacy} is the old name for ${name} and still works, but it ` +
        "will stop working in a future release — rename it when convenient.",
    );
  }
  return value;
}

function findEntry(name: string): ConfigEntry {
  const e = CONFIG_SCHEMA.find((c) => c.name === name);
  if (!e) throw new Error(`config.ts: ${name} not in CONFIG_SCHEMA — add a schema row first`);
  return e;
}

export function cfgBool(name: string): boolean {
  const entry = findEntry(name);
  const raw = readEnv(name);
  if (raw === undefined) return entry.default as boolean;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function cfgInt(name: string): number {
  const entry = findEntry(name);
  const raw = readEnv(name);
  if (raw === undefined) return entry.default as number;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? (entry.default as number) : n;
}

export function cfgPath(name: string): string | null {
  const entry = findEntry(name);
  return readEnv(name) ?? (entry.default as string | null);
}

export function cfgList(name: string): string[] {
  const entry = findEntry(name);
  const raw = readEnv(name);
  if (raw === undefined) return entry.default ? [entry.default as string] : [];
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The agent's profile dir. CINDERPAW_HOME was documented in the schema above but
 * never honored — three call sites (boot, connectors, self_describe) resolved
 * `~/.feral` from homedir() directly, so an isolated profile still read the
 * real one's connectors and secrets. Single resolver; import it instead of
 * re-deriving the path.
 */
export function cinderpawHome(): string {
  const base = resolve(cfgPath("CINDERPAW_HOME") ?? defaultHomeDir());
  const run = benchmarkRunId();
  // INVARIANT I13: a benchmark run gets its own profile dir, so nothing it
  // learns can be read by the next run. Scoping HERE and not at the twenty
  // call sites is the point — `paths()`, the DB, the journal, the skill sink
  // and the connector store all derive from this one function, so they all
  // move together or none of them do.
  return run ? join(base, "runs", run) : base;
}

/**
 * Where the agent's SQLite database lives when nothing overrides it:
 * `<profile>/data/cinderpaw.db`, or the pre-rename `data/feral.db` when that is
 * the file this install actually has. Nothing is copied or moved; the file that
 * exists is the file that gets opened.
 *
 * It lives here, beside `cinderpawHome()`, because it is a path rule and every
 * other path rule in this sidecar is here. It used to live in `boot.ts` and
 * return the RELATIVE string "data/cinderpaw.db", which `loadConfig` then
 * resolved against `process.cwd()`.
 *
 * That was invisible on the desktop, where the Rust host passes `CINDERPAW_DB`
 * explicitly and is the only thing in the tree that sets it. On the
 * npm-installed CLI (`cinderpaw`, `feral` in package.json) there is no such
 * host, so starting it from ~/Documents and then from ~ built two unrelated
 * databases with two unrelated writer locks. Every memory, conversation,
 * teammate and cost record belonged to whichever directory the shell was in,
 * and nothing errored: the agent simply did not know you.
 *
 * The fractal tree, the leaf store, the tool observation log and the migration
 * marker all live in `dirname(dbPath)`, so they come home with it.
 */
export function defaultDbPath(): string {
  const dataDir = join(cinderpawHome(), "data");
  const current = join(dataDir, "cinderpaw.db");
  const legacy = join(dataDir, "feral.db");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Brand names for the profile dir. Mirrors `crates/cinderpaw-core/src/brand.rs`. */
const APP_HOME_DIR_NAME = ".cinderpaw";
const LEGACY_HOME_DIR_NAME = ".feral";
/** Written into the OLD dir by the Rust migration once it has copied it. */
const MIGRATION_MARKER = ".migrated-to-cinderpaw";

let cachedDefaultHome: string | undefined;

/**
 * Where the profile dir lives when nothing overrides it.
 *
 * This function exists because the sidecar did not follow the rename and the
 * two halves of the app ended up on two different directories. The Rust host
 * migrates `~/.feral` to `~/.cinderpaw` on boot (`migrate_home.rs`, which
 * copies and then marks the source — it never deletes) and reads
 * `~/.cinderpaw` from then on. The sidecar kept `join(homedir(), ".feral")`
 * hardcoded, so after any migrated boot the host and the sidecar were reading
 * and writing two different profiles: on this dev box `~/.feral/connectors.json`
 * had gained two connectors that `~/.cinderpaw/connectors.json` had never
 * heard of. Nothing errored. The person just sees settings that do not stick.
 *
 * Resolution mirrors the Rust side:
 *   1. `~/.cinderpaw` if it exists — the post-rename home, and what the host uses.
 *   2. `~/.feral` if only that exists — a pre-migration install, or the sidecar
 *      running standalone (CLI/TUI) before the host has ever booted. Reading
 *      the legacy dir is right here: it is where that machine's data actually is.
 *   3. `~/.cinderpaw` on a fresh machine, where neither exists.
 *
 * The migration itself stays the Rust side's job — one implementation that
 * copies, verifies and marks, not two that race each other.
 */
function defaultHomeDir(): string {
  if (cachedDefaultHome !== undefined) return cachedDefaultHome;
  const modern = join(homedir(), APP_HOME_DIR_NAME);
  const legacy = join(homedir(), LEGACY_HOME_DIR_NAME);
  const modernExists = existsSync(modern);
  const legacyExists = existsSync(legacy);

  if (modernExists && legacyExists && existsSync(join(legacy, MIGRATION_MARKER))) {
    // Both dirs, and the old one was migrated — so anything written into it
    // AFTER the marker was written by something that never learned the new
    // name. Say so on screen: the symptom otherwise is "my connectors/settings
    // reverted", with nothing anywhere explaining it.
    warnIfLegacyDivergedFrom(legacy);
  }
  cachedDefaultHome = pickHomeDir(modern, legacy, modernExists, legacyExists);
  return cachedDefaultHome;
}

/**
 * Every directory that is the agent's own profile on this machine.
 *
 * More than one, because the rename migration (`migrate_home.rs`) copies
 * `~/.feral` into `~/.cinderpaw` and never deletes the source: on a migrated
 * machine the old directory keeps a full copy of the connector tokens, the
 * byok.json API keys and the conversations, indefinitely. Anything that walls
 * off "the agent's home" has to wall off both, or it protects whichever one
 * the app happens to be using and leaves the user's keys in the other.
 *
 * Includes `cinderpawHome()` first so an explicit CINDERPAW_HOME
 * override is covered too. Duplicates are removed; a directory that does not
 * exist is harmless in a deny list.
 */
export function agentProfileDirs(): string[] {
  return [
    ...new Set([
      cinderpawHome(),
      resolve(join(homedir(), APP_HOME_DIR_NAME)),
      resolve(join(homedir(), LEGACY_HOME_DIR_NAME)),
    ]),
  ];
}

/** The choice itself, pure so it can be tested without a home directory. */
export function pickHomeDir(
  modern: string,
  legacy: string,
  modernExists: boolean,
  legacyExists: boolean,
): string {
  return modernExists || !legacyExists ? modern : legacy;
}

function warnIfLegacyDivergedFrom(legacy: string): void {
  try {
    const markerAt = statSync(join(legacy, MIGRATION_MARKER)).mtimeMs;
    const newer = readdirSync(legacy).filter((name) => {
      if (name === MIGRATION_MARKER) return false;
      try {
        return statSync(join(legacy, name)).mtimeMs > markerAt;
      } catch {
        return false;
      }
    });
    if (newer.length === 0) return;
    console.error(
      `[cinderpaw] ${legacy} was migrated to ${join(homedir(), APP_HOME_DIR_NAME)}, ` +
        `but ${newer.length} entr${newer.length === 1 ? "y has" : "ies have"} been written ` +
        `there since: ${newer.slice(0, 6).join(", ")}${newer.length > 6 ? ", …" : ""}. ` +
        "Those changes are NOT in the directory the app now uses. Nothing has been " +
        "deleted — copy across what you still want, then remove the old directory.",
    );
  } catch {
    // Diagnostics must never be the reason boot fails.
  }
}

/**
 * The active benchmark run id, or null when this is an ordinary session.
 *
 * Read from the environment every time rather than memoized: tests set and
 * clear the variable between cases, and a cached "off" from the first import
 * would make every later case silently unscoped — which is exactly the
 * contamination this is here to prevent.
 */
export function benchmarkRunId(): string | null {
  const raw = cfgPath("CINDERPAW_BENCHMARK_RUN_ID");
  if (raw === null || raw.trim() === "") return null;
  assertValidRunId(raw);
  return raw;
}

/**
 * The agent's scratchpad — where it may write freely without touching anything
 * of the user's.
 *
 * It is the ONE writable path under the profile dir; `loadWorkspaceRoots` creates it
 * at boot and exempts it from the wall that refuses every other root inside the
 * agent's own home. Resolved here, next to `cinderpawHome`, for the same reason that
 * one exists: two callers deriving it separately is how an isolated profile ends
 * up writing into the real one's directory.
 */
export function scratchRoot(): string {
  return join(cinderpawHome(), "workspace");
}

/**
 * The operator's SearXNG instance backing `web_search`, or null when unset.
 *
 * Returns the ORIGIN only (scheme + host + port) — never a path, query, or
 * credentials. That matters: the origin is what the egress proxy exempts from
 * its loopback/private SSRF guard, and an exemption keyed on anything looser
 * than an exact origin would be a hole. A malformed value is treated as unset
 * (fail closed: no search backend beats a badly-scoped SSRF exemption).
 */
export function searxngOrigin(): string | null {
  const raw = cfgPath("CINDERPAW_SEARXNG_URL");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}
