/**
 * Cinderpaw Agent — entry point.
 *
 * Wires the four layers together and starts the selected transport:
 *   Sandbox (audit → egress → inference) → Memory → Tools → Agent core → Transport
 *
 * Security is constructed first: the audit log, egress proxy, and inference
 * router exist before any tool is registered or any message is handled.
 */

import { resolve, join, delimiter } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { openDatabase } from "./db.ts";
import { SIDECAR_PROTOCOL } from "./protocol.ts";
import { dispatchMessage } from "./dispatch.ts";
import { agentProfileDirs, benchmarkRunId, cfgBool, cfgInt, cfgList, cfgPath, cinderpawHome, defaultDbPath, readEnv, scratchRoot, searxngOrigin } from "./config.ts";
import { AuditLog } from "./egress/audit-log.ts";
import { EgressProxy } from "./egress/egress-proxy.ts";
import { RealProcessSandbox } from "./egress/process-sandbox.ts";
import { pathWithin } from "./egress/tool-permissions.ts";
import { InferenceRouter } from "./egress/inference-router.ts";
import { EpisodicMemory } from "./memory/episodic.ts";
import { isRestrictedSession } from "./core/session-visibility.ts";
import { SemanticMemory, memoryScope } from "./memory/semantic.ts";
import { RecallEngine } from "./memory/recall.ts";
import { MemoryExtractor, isJunkFactKey } from "./memory/extractor.ts";
import { Reconciler } from "./memory/reconciler.ts";
import { runMigration } from "./memory/fractal/migration.ts";
import { MemoryGraph } from "./memory/graph.ts";
import { MemoryGraphCleaner } from "./memory/graph-cleaner.ts";
import { getActiveWorkspaceId } from "./memory/workspaces.ts";
import { setCurrentTask, touchLastActive } from "./memory/resume.ts";
import { maxContinuations, resumePrompt, runUnattended } from "./core/unattended.ts";
import {
  createSafetyPoints,
  safetyColumns,
  changedSince,
  changeFingerprint,
  safetyPointsFrom,
  type SafetyPoint,
} from "./core/safety-point.ts";
import type { DoneWhen } from "./cron/done-when.ts";
import type { TurnRecord, UnattendedResult } from "./core/unattended.ts";
import type { RunSurface } from "./transports/connectors.ts";
import { renderDigest } from "./core/digest.ts";
import { CHEAP_CHECKS, verifyDoneWhen } from "./cron/done-when.ts";
import { RunStore, type RunRow, type RunStatus, type RunStopReason } from "./core/run-store.ts";
import { deliverAndMark, drainUndelivered, type DeliveryOutcome } from "./core/run-delivery.ts";
import { intentSummary, clearIntents } from "./core/command-intent.ts";
import { installUserHooks, userHooksPath } from "./core/user-hooks.ts";
import { resumeInterruptedRuns, madeNoProgress, STALL_TURNS } from "./core/run-resume.ts";
import { turnBudgetMs } from "./core/agent-loop.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { McpManager } from "./egress/mcp-manager.ts";
import { createReadFileTool } from "./tools/builtin/read-file.ts";
import { createWriteFileTool } from "./tools/builtin/write-file.ts";
import { createListDirectoryTool } from "./tools/builtin/list-directory.ts";
import { createEditFileTool } from "./tools/builtin/edit-file.ts";
import { createFileSearchTool } from "./tools/builtin/file-search.ts";
import { createGrepTool } from "./tools/builtin/grep.ts";
import {
  createNotebookTool,
  createNotifyParentTool,
  NOTEBOOK_CHILD_TOOLS,
  NOTIFY_PARENT_TOOL_NAME,
  type ChildRegistries,
} from "./tools/builtin/notebook.ts";
import { Subagent } from "./core/subagent.ts";
import { createShellExecTool } from "./tools/builtin/shell-exec.ts";
import { createToolForgeTool, registerPersistedCustomTools } from "./tools/builtin/tool-forge.ts";
import { createTodoWriteTool, TodoStore } from "./tools/builtin/todo-write.ts";
import { CheckpointStore } from "./memory/checkpoint.ts";
import { createGitStatusTool, createGitDiffTool, createGitLogTool, createGitCommitTool, createGitBranchTool } from "./tools/builtin/git.ts";
import { createHttpRequestTool } from "./tools/builtin/http-request.ts";
import { createTimeDateTool } from "./tools/builtin/time-date.ts";
import { createCalculatorTool } from "./tools/builtin/calculator.ts";
import { createWebSearchTool } from "./tools/builtin/web-search.ts";
import { createFetchUrlTool } from "./tools/builtin/fetch-url.ts";
import { createReadWebpageTool } from "./tools/builtin/read-webpage.ts";
import { createDeepResearchTool } from "./tools/builtin/deep-research.ts";
import { createToolHealthTool } from "./tools/builtin/tool-health.ts";
import { createScanWorkspaceTool } from "./tools/builtin/scan-workspace.ts";
import { createReadSkillTool } from "./tools/builtin/read-skill.ts";
import { createListSkillsTool } from "./tools/builtin/list-skills.ts";
import { createCapabilityTools } from "./tools/builtin/capability.ts";
import { createCinderpawAdminTools } from "./tools/builtin/cinderpaw-admin.ts";
import { createProductInfoTool } from "./tools/builtin/product-info.ts";
import { createCodeQualityTool } from "./tools/builtin/code-quality.ts";
import { ToolObservationLog } from "./telemetry/tool-observations.ts";
import { createDelegateTaskTool } from "./tools/builtin/delegate-task.ts";
import { createRecallTool } from "./tools/builtin/recall.ts";
import { createRememberTool, NOTE_PREFIX, POSITION_KEY } from "./tools/builtin/remember.ts";
import { createSelfTools } from "./tools/builtin/self.ts";
import { createCoworkTeamTool, createCoworkSendTool } from "./tools/builtin/cowork.ts";
import { createCoworkCreateTool } from "./tools/builtin/cowork-create.ts";
import { createTokenUsageTool } from "./tools/builtin/token-usage.ts";
import { createConnectorsManageTool } from "./tools/builtin/connectors-manage.ts";
import { AgentLoop } from "./core/agent-loop.ts";
import { HeartbeatLoop } from "./core/heartbeat.ts";
import { HookRegistry } from "./core/hook-registry.ts";
import { CronJobsRepo, CronScheduler, deliverCron } from "./cron/index.ts";
import { CoworkAgentRepo } from "./cowork/agent-store.ts";
import { CoworkMailboxRepo } from "./cowork/mailbox.ts";
import { CoworkHandoffService } from "./cowork/handoff.ts";
import { CoworkRuntime } from "./cowork/runtime.ts";
import {
  CoworkApprovalRepo,
  CoworkApprovalService,
} from "./cowork/approval.ts";
import { TauriTransport } from "./transports/tauri.ts";
import { ConnectorManager } from "./transports/connectors.ts";
// Imported for the side effect: each transport module registers itself with
// the registry at load. Without the import the catalog offers a connector
// this build cannot start — which is exactly what the registry exists to
// make visible, but it should never happen for one we ship.
import "./transports/matrix.ts";
import "./transports/mattermost.ts";
import "./transports/twitch.ts";
import { bootstrapOnce } from "./rsi/mod.ts";
import { RsiBridge } from "./rsi/infra/bridge.ts";
import { setEmbedInvoker, rsiBridgeEmbed, embed } from "./memory/fractal/embed.ts";
import { summarizeFromRouter, routerInfer } from "./memory/fractal/summarize.ts";
import { FractalMemory, type FractalActivity } from "./memory/fractal/fractal-memory.ts";
import { LEAF_STORE_FILENAME } from "./memory/fractal/leaf-store.ts";
import { DEFAULT_SYSTEM_PROMPT, RsiSidecar } from "./rsi/sidecar.ts";
import { PROMPT_STYLE_POOL } from "./rsi/l1-config/prompt-pool.ts";
import { hitsToItems, itemsToHits, liveModuleRegistry, liveSeamAdapter, onModuleQuarantine } from "./rsi/l4-modules/seam-runtime.ts";
import { shouldAutostartPassive, isPlaceholderModel } from "./rsi/l1-config/passive-supervisor.ts";
import { createDreamCycle } from "./rsi/l1-config/dream-cycle.ts";
import { defaultJournalPath } from "./rsi/infra/journal.ts";
import { ActivityMonitor } from "./rsi/l1-config/activity-monitor.ts";
import { resolveDreamConfig, dreamCloudGate } from "./rsi/l1-config/dream-config.ts";
import { episodeStartOptions, episodeBudgetCaps } from "./rsi/l1-config/episode-options.ts";
import { MetaEvolution } from "./rsi/l6-meta/meta-evolution.ts";
import { effectiveGates, loadPolicy } from "./rsi/l5-gov/governance.ts";
import { ensureGenesisPolicy, GovernanceLifecycle } from "./rsi/l5-gov/governance-lifecycle.ts";
import {
  mapGenomeToAgentConfig,
  readChampion,
  defaultChampionPath,
} from "./rsi/l1-config/champion.ts";
import { loadSoul, watchSoul, resolveSoulPaths } from "./core/soul-loader.ts";
import { loadUserConfig } from "./core/user-loader.ts";
import { AskUserBridgeImpl } from "./core/ask-user-bridge.ts";
import { HostToolBridge, loadHostTools } from "./core/host-tool-bridge.ts";
import { setHostToolNames } from "./tools/tiers.ts";
import { createAskUserTool } from "./tools/builtin/ask-user.ts";
import { DesktopControlBridgeImpl } from "./core/desktop-control-bridge.ts";
import { RequestBridge } from "./core/request-bridge.ts";
import { createControlAppTool } from "./tools/builtin/control-app.ts";
import { LeadDesk } from "./core/lead-desk.ts";
import { createCaptureLeadTool } from "./tools/builtin/capture-lead.ts";
import { createEscalateToHumanTool } from "./tools/builtin/escalate-to-human.ts";
import { createScheduleMeetingTool } from "./tools/builtin/schedule-meeting.ts";
import type { InferenceConfig, ModelTarget, Transport } from "./types.ts";
import { CircuitBreaker } from "./egress/circuit-breaker.ts";
import { BrainStack } from "./brain/brain-stack.ts";
import {
  brainConfigFileExists,
  deriveDefaultConfig,
  loadBrainConfig,
} from "./brain/brain-config.ts";

interface AppConfig {
  transport: "tauri";
  dbPath: string;
  /**
   * Every fs/shell/git tool is scoped to these roots. Multiple roots so the
   * agent can work across the project, a scratch dir, and any extra paths the
   * user whitelists — without re-configuring per project.
   */
  workspaceRoots: string[];
  inference: InferenceConfig;
}

/** The agent's own home: RSI git substrate, SQLite db, SOUL/identity. */
const CINDERPAW_HOME = cinderpawHome();

/**
 * Sidecar version, surfaced verbatim in the runtime identity doc emitted
 * by `self_describe` and used as the L4 manifest `compat.runtime` floor.
 * VERSION and log() now live in `runtime-meta.ts` (a leaf module) so a
 * short-lived invocation can read them without evaluating this file's
 * module graph. Re-exported here because this was their public home.
 */
import { log, VERSION } from "./runtime-meta.ts";
/**
 * The one line the host waits for. Mirrored by `READY_MARKER` in
 * `crates/cinderpaw-core/src/cinderpaw_agent.rs`, which matches it exactly — the
 * two halves of one protocol, in two languages.
 *
 * The rename broke this pair: the Rust side moved to `cinderpaw-agent-ready`
 * and this line did not, so the host waited for a sentence the sidecar never
 * said. Nothing failed loudly — the app just never became ready, and the
 * "waking up" banner stayed on screen for the rest of the session. Each side
 * had a test, and each test checked its own constant against itself.
 * `protocol_drift.rs` now reads this file and compares the two literals, which
 * is the check that would have caught it.
 */
const READY_MARKER = "::cinderpaw-agent-ready::";
export { VERSION, log } from "./runtime-meta.ts";

/** When this sidecar process started, for uptime reports. */
const BOOT_EPOCH_MS = Date.now();

/**
 * Leaves a single fractal rebuild may summarise when the active model is a
 * CLOUD provider and the operator set no explicit cap.
 *
 * ponytail: 200 is the number the old warning told operators to use, so it is
 * the value already known to work; the point of the constant is that we now
 * apply it instead of asking. Local primaries are uncapped — see
 * `fractalMaxLeaves`. Raise via CINDERPAW_FRACTAL_BENCH_MAX_LEAVES on a
 * long-context provider where the whole corpus does fit.
 */
const CLOUD_REBUILD_LEAF_CAP = 200;

/**
 * Resolve the agent's filesystem sandbox roots.
 *
 * - `CINDERPAW_WORKSPACE` is a path-list (`;` on Windows, `:` elsewhere). When
 *   unset it defaults to the launch cwd PLUS the user's home directory — the
 *   agent is a local assistant and should be able to work anywhere the user
 *   can, not just in one project folder. Set CINDERPAW_WORKSPACE to RESTRICT.
 * - A dedicated scratch dir under ~/.cinderpaw/workspace is ALWAYS added, so a
 *   task always has somewhere it fully owns to read/write even if cwd is
 *   read-only.
 * - Self-protection wall: broad roots are fine because the real guarantee
 *   moved to CALL TIME — resolveAllowedPath (tool-permissions.ts) denies any
 *   target inside ~/.cinderpaw (except scratch), ~/.ssh, or CINDERPAW_FS_DENY on every
 *   single access. Here we only drop roots that sit ENTIRELY inside ~/.cinderpaw
 *   (every call through them would fail anyway — better to warn at boot).
 */

/** True iff `child` is `parent` or lies beneath it. Appends a separator before
 *  the prefix test so a filesystem root (`"/"` / `"C:\\"`, which already ends
 *  in a separator) doesn't produce a double-separator prefix that never
 *  matches — the trailing-separator bug that let `CINDERPAW_WORKSPACE=/` slip the
 *  self-protection wall. */

export function loadWorkspaceRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CINDERPAW_WORKSPACE;
  const requested = raw && raw.trim()
    ? raw.split(delimiter).map((s) => s.trim()).filter(Boolean)
    : [process.cwd(), homedir()];
  const roots = requested.map((p) => resolve(p));

  // Same resolver the file tools use to decide whether a write is "scratchpad"
  // or "the user's project" — they must never disagree about where it is.
  const scratch = scratchRoot();
  try { mkdirSync(scratch, { recursive: true }); } catch { /* best effort */ }
  roots.push(scratch);

  const guarded = roots.filter((r) => {
    if (pathWithin(r, scratch)) return true; // scratch subtree — the one allowed path under ~/.cinderpaw
    // Only drop roots that sit INSIDE ~/.cinderpaw (RSI repo, db, SOUL): every
    // access through them would be refused by the call-time deny wall in
    // resolveAllowedPath, so registering them just produces confusing tools.
    // Ancestors of ~/.cinderpaw (home, drive root) are ALLOWED — the deny wall
    // guards the brain per-access, not per-root.
    // Both profile dirs: the rename migration never deletes ~/.feral, so on a
    // migrated machine it still holds agent state and the call-time deny wall
    // refuses it. Warning about only the current one meant a root under the
    // other registered fine and then failed on every single access.
    const home = agentProfileDirs().find((h) => pathWithin(r, h));
    if (home !== undefined) {
      console.warn(
        `[config] dropping workspace root "${r}" — it is inside ${home} ` +
          `(agent state/identity). Point CINDERPAW_WORKSPACE at a project dir instead.`,
      );
      return false;
    }
    return true;
  });
  return [...new Set(guarded)];
}

/** True when a base URL points at a loopback (local) host. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function loadConfig(): AppConfig {
  const env = process.env;
  const workspaceRoots = loadWorkspaceRoots(env);

  // ":memory:" is a SQLite sentinel and must not be path-resolved.
  //
  // The default file was renamed with the app. An install that predates the
  // rename has its whole history in `data/feral.db`, and simply changing the
  // default would start it on an empty database sitting next to a full one —
  // which presents itself to the person as every conversation being gone. So
  // the old file wins whenever it is there and the new one is not.
  const dbEnv = env.CINDERPAW_DB ?? defaultDbPath();
  const dbPath = dbEnv === ":memory:" ? ":memory:" : resolve(dbEnv);

  return {
    transport: "tauri", // only transport wired in V1
    dbPath,
    workspaceRoots,
    inference: {
      primary: {
        // Default to the bundled Rust/llama.cpp engine (OpenAI-compatible API on
        // 11435). Override with CINDERPAW_PROVIDER/CINDERPAW_BASE_URL to target external
        // Ollama (11434) or any other OpenAI-compatible server.
        provider: env.CINDERPAW_PROVIDER ?? "openai_compatible",
        // The id is still substituted so every downstream config field has a
        // shape, but the readiness line below no longer presents it as a model
        // that exists — see `isPlaceholderModel`.
        model: env.CINDERPAW_MODEL ?? "qwen2.5:7b",
        baseUrl: env.CINDERPAW_BASE_URL ?? "http://127.0.0.1:11435",
        // Optional API key for cloud providers (OpenAI-compatible
        // / Anthropic / Nvidia NIM). Ignored for `ollama`.
        //
        // Set CINDERPAW_TRUSTED_BASE_URLS below to bound where this key can
        // travel: with a list configured, neither boot nor a later
        // `set_model` can point inference outside it. WITHOUT one — the
        // default — the only gate is the host channel that carries
        // `set_model`, which is loopback-only + bearer token (`api.rs`).
        // Do not read the allowlist as protection you have not enabled.
        ...(env.CINDERPAW_API_KEY ? { apiKey: env.CINDERPAW_API_KEY } : {}),
      },
      ...(env.CINDERPAW_FALLBACK_MODEL
        ? {
            fallback: {
              provider: env.CINDERPAW_FALLBACK_PROVIDER ?? "ollama",
              model: env.CINDERPAW_FALLBACK_MODEL,
              baseUrl: env.CINDERPAW_FALLBACK_BASE_URL ?? "http://localhost:11434",
              ...(env.CINDERPAW_FALLBACK_API_KEY
                ? { apiKey: env.CINDERPAW_FALLBACK_API_KEY }
                : {}),
            },
          }
        : {}),
      tokenBudget: {
        // P1-#1: relaxed-but-real cap. The user wants infinite-feeling
        // conversations but a runaway agent that loops in retry hell or
        // burns $50 in 10 minutes has to be stopped somewhere. These
        // defaults are deliberately generous:
        //
        //   5M per conversation  ≈ 2,500–10,000 normal turns, or ~50–200
        //                          deep-research turns. A real user never
        //                          hits this; a runaway agent does.
        //   50M per day          ≈ ~$15/day on Haiku, ~$150 on Sonnet,
        //                          ~$750 on Opus. Bankrupting only by
        //                          genuine abuse or a bug.
        //
        // Behavior at limit: `onExhausted: "stop"` — finish the current
        // turn cleanly and surface a `budget_exceeded` event so the UI
        // can ask the user whether to continue. No silent bricking.
        //
        // Override: CINDERPAW_BUDGET_CONVERSATION / CINDERPAW_BUDGET_DAY / *_POLICY
        // env vars. Pass an explicit number to lower (or raise) the cap;
        // pass `Infinity` (the previous default) for the unbounded
        // pre-P1-#1 behavior if a power user really wants it.
        perConversation: Number(env.CINDERPAW_BUDGET_CONVERSATION ?? 5_000_000),
        perDay: Number(env.CINDERPAW_BUDGET_DAY ?? 50_000_000),
        onExhausted:
          env.CINDERPAW_BUDGET_POLICY === "stop" ? "stop" : "compress_and_continue",
      },
      // Requests-per-minute cap. Unset (0) means the router uses the published
      // caps it knows about — NVIDIA NIM's free tier is 40 RPM — and leaves
      // every other endpoint, the local engine above all, unthrottled.
      rateLimitRpm: Number(env.CINDERPAW_RATE_LIMIT_RPM ?? 0),
      // Comma-separated allowlist of inference endpoints. Omitted → defaults to
      // exactly the configured primary/fallback targets.
      ...(env.CINDERPAW_TRUSTED_BASE_URLS
        ? {
            trustedBaseUrls: env.CINDERPAW_TRUSTED_BASE_URLS.split(",")
              .map((u) => u.trim())
              .filter(Boolean),
          }
        : {}),
    },
  };
}

function buildTransport(kind: AppConfig["transport"]): Transport {
  switch (kind) {
    case "tauri":
      return new TauriTransport();
    default:
      // Exhaustive: V2 transports are stubbed and not selectable yet.
      throw new Error(`unsupported transport: ${kind}`);
  }
}

/**
 * Boot sequence — wires the full agent stack (sandbox → memory → tools →
 * agent core → transport) and returns the context the per-message dispatch
 * switch (`dispatch.ts`) needs. Renamed from `main` (R7); `index.ts` keeps a
 * thin `main()` wrapper so `src/tui/chat.ts`'s `await import("../index.ts")`
 * / `.main` contract is unchanged.
 *
 * @param transportOverride — when set, use this transport instead of building
 *   the default TauriTransport. Used by the TUI chat loop (src/tui/chat.ts)
 *   which passes a TuiTransport so events fan out in-process instead of
 *   writing JSON to stdout.
 */
export async function boot(transportOverride?: Transport) {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  // Durable state for unattended runs. Created here, next to the database,
  // because the boot-time resume pass below needs it before anything else can
  // start a new run.
  const runStore = new RunStore(db.raw);

  // --- RSI bootstrap (Faza 0 — Keystone) ---
  // Boot the Bounded-RSI substrate. Two slices, two owners:
  //
  //   - Rust slice (git repo at ~/.cinderpaw/rsi/, PLAN.md, SandboxBounds,
  //     audit chain) — bootstrapped by Tauri's `setup()` hook in
  //     src-tauri/src/lib.rs BEFORE the sidecar process spawns. By
  //     the time we reach this line, that slice is already live.
  //
  //   - Sidecar slice (5 tables in cinderpaw.db, 4 initial
  //     strategy-genomes) — bootstrapped here. Idempotent: re-running
  //     is a no-op.
  //
  // This is fail-soft: a failed bootstrap here doesn't kill the
  // sidecar — chat still works, just without RSI. The error is
  // surfaced to the log so the operator can diagnose.
  try {
    const result = bootstrapOnce(db.raw);
    if (!result.allTablesPresent) {
      log(`RSI tables missing: ${result.missingTables.join(", ")} — migration may have failed`);
    }
    log(
      `RSI bootstrap → strategy_seeds=${result.strategyGenomesSeeded} ` +
        `tables_ok=${result.allTablesPresent}`,
    );
  } catch (err) {
    log(`RSI bootstrap failed (continuing without RSI): ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Identity: load SOUL.md (bundled default + user override). The loader
  // is the source of truth for the agent's tone, identity, and behavior; it
  // is wired in early so the system prompt is consistent on the first turn
  // and the watcher is alive before any user request lands. ---
  const soul = loadSoul();
  log(`soul loaded — source=${soul.source} version=${soul.version} ` +
    `~${soul.approxTokens.toLocaleString()} tokens`);

  // --- Personalization: read ~/.cinderpaw/onboarding.json (written by the React
  // onboarding wizard). The userName and agentName are injected as a USER
  // block in the system prompt so the model uses them in replies. If no
  // record exists yet (user skipped onboarding), the block is omitted and
  // the agent uses generic defaults. ---
  const user = loadUserConfig();
  if (user.hasOnboarded) {
    log(`user onboarded — userName="${user.userName}" agentName="${user.agentName}"`);
  } else {
    log(`user not onboarded — using generic defaults (no USER block)`);
  }
  const stopSoulWatcher = watchSoul(undefined, (fresh) => {
    // Hot-reload: only NEW sessions pick up the change. Active sessions
    // keep their original system prompt so the conversation stays coherent.
    log(`soul hot-reload — source=${fresh.source} version=${fresh.version} ` +
      `~${fresh.approxTokens.toLocaleString()} tokens (applies to new sessions)`);
  });
  if (stopSoulWatcher === (() => {})) {
    // Watcher returned the no-op stub — only happens when there is no user
    // override. Surface the bundled path so the user knows where to find it.
    const paths = resolveSoulPaths();
    log(`soul — using bundled default (no user override at ${paths.user})`);
  }

  // --- Layer 3: Sandbox (built first) ---
  const audit = new AuditLog(db.raw);
  // Loopback origins the SSRF guard may reach: the user's own SearXNG, plus
  // anything else they declared with CINDERPAW_TRUSTED_LOCAL_ORIGINS. Both come
  // from the operator's environment — never from the model, a tool argument or
  // a fetched page — and both are exact-origin, so trusting one local service
  // does not trust the rest of the loopback interface.
  const searxng = searxngOrigin();
  const declaredLocal = cfgList("CINDERPAW_TRUSTED_LOCAL_ORIGINS").map((o) =>
    o.replace(/\/$/, ""),
  );
  const egress = new EgressProxy(audit.logger, {
    trustedLocalOrigins: [...(searxng ? [searxng] : []), ...declaredLocal],
    externalWriteBudget: cfgInt("CINDERPAW_EXTERNAL_WRITE_BUDGET"),
    unattendedWriteDenyHosts: cfgList("CINDERPAW_WRITE_CONFIRM_HOSTS"),
    unattended: cfgBool("CINDERPAW_AUTONOMOUS"),
    dryRunWrites: cfgBool("CINDERPAW_DRY_RUN"),
  });
  if (cfgBool("CINDERPAW_DRY_RUN")) {
    log("egress: DRY RUN — state-changing requests will be logged, not sent");
  }
  // Benchmark mode changes two things a stranger would otherwise discover as
  // "why is the network broken" and "why did it forget everything". Say both
  // out loud, at the top, every time.
  const benchRun = benchmarkRunId();
  if (benchRun !== null) {
    const benchHosts = cfgList("CINDERPAW_BENCHMARK_ALLOW_HOSTS");
    log(`BENCHMARK MODE: run "${benchRun}"`);
    log(`  data dir: ${cinderpawHome()}  (isolated from other runs — invariant I13)`);
    log(
      benchHosts.length === 0
        ? "  network: NOTHING is reachable — CINDERPAW_BENCHMARK_ALLOW_HOSTS is empty"
        : `  network: only ${benchHosts.join(", ")}`,
    );
  }
  if (declaredLocal.length > 0) {
    log(`egress: ${declaredLocal.length} operator-declared local origin(s) trusted`);
  }
  // Always say which backend is live — "why is search failing" was previously
  // unanswerable from the log, because the unconfigured case printed nothing.
  log(
    searxng
      ? `web_search backend: SearXNG @ ${searxng}`
      : "web_search backend: DuckDuckGo (keyless default; set CINDERPAW_SEARXNG_URL for a self-hosted one)",
  );
  // NB: deliberately NOT named `process` to avoid shadowing the global
  // Node `process` object (which we still need below for process.env).
  const processSandbox = new RealProcessSandbox(audit.logger);
  const router = new InferenceRouter(config.inference, audit.logger, db.raw);

  // Bundled local engine used as an automatic fallback when the user hot-swaps
  // to a cloud model. A transient cloud failure (e.g. MiniMax 429 rate-limit)
  // then degrades to the on-device model instead of hard-failing the turn.
  //
  // This used to read CINDERPAW_MODEL / CINDERPAW_BASE_URL whenever the boot primary
  // was NOT loopback — but those env vars ARE the cloud route in exactly that
  // case (Rust boots the sidecar on the persisted BYOK route). So the "local
  // fallback" was a keyless copy of the boot-time CLOUD provider: after
  // switching to another provider, any error on the new one silently re-called
  // the old one, and the old one's failure was the error the user saw. That is
  // release blocker F9 ("switched to nvidia, still calls api.minimax.io").
  //
  // The bundled engine is on loopback and Rust passes its address+token
  // separately. No loopback target → no fallback, and a cloud failure surfaces
  // as itself.
  //
  // CINDERPAW_LOCAL_MODEL is required, not defaulted: Rust only sets it once the
  // engine has actually answered /v1/models. Guessing a model id here would
  // build a fallback that 404s on the one turn it exists to rescue, and its
  // failure would mask the real cloud error — the same class of bug as F9.
  const localBaseUrl = cfgPath("CINDERPAW_LOCAL_BASE_URL");
  const localModel = cfgPath("CINDERPAW_LOCAL_MODEL");
  const localFallbackTarget: ModelTarget | undefined = isLoopbackUrl(
    config.inference.primary.baseUrl,
  )
    ? config.inference.primary
    : localBaseUrl && localModel && isLoopbackUrl(localBaseUrl)
      ? {
          provider: "openai_compatible",
          model: localModel,
          baseUrl: localBaseUrl,
          apiKey: cfgPath("CINDERPAW_LOCAL_API_KEY") ?? undefined,
        }
      : undefined;

  // --- Layer 2: Memory ---
  // The 4th argument marks rows written by non-owner (restricted-profile)
  // sessions so they stay out of cross-session recall and the fractal tree.
  const episodic = new EpisodicMemory(
    db.raw,
    audit.logger,
    () => getActiveWorkspaceId(db.raw),
    isRestrictedSession,
  );
  const semantic = new SemanticMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, semantic);

  // --- Memory graph (moved up so tools can reference it at registry build time) ---
  const memoryGraph = new MemoryGraph();
  const graphCleaner = new MemoryGraphCleaner();
  graphCleaner.startSchedule();
  // Boot-time hygiene sweep: purge junk facts/nodes written by the old
  // colon-split extractor (keys like "- language", "1. user shared a link",
  // reasoning leakage). Runs every start so junk can never survive a restart
  // even if an older binary wrote it — deletions stay deleted.
  {
    let sweptFacts = 0;
    for (const fact of semantic.all()) {
      if (isJunkFactKey(fact.key)) {
        semantic.delete(fact.key);
        sweptFacts++;
      }
    }
    const sweptNodes = memoryGraph.sweepJunk((idText, label) =>
      isJunkFactKey(idText) || isJunkFactKey(label.toLowerCase()),
    );
    if (sweptFacts > 0 || sweptNodes > 0) {
      log(`memory hygiene: removed ${sweptFacts} junk fact(s), ${sweptNodes} junk graph node(s)`);
    }
  }
  // Surface accumulated graph facts in every recall so a brand-new session
  // starts with what the agent already knows about the user.
  recall.setGraph(memoryGraph);

  // --- ECC tool observation telemetry ---
  // The fractal tree, the leaf store, the observation log and the migration
  // marker all live beside the database, so this follows `dbPath` home. The
  // in-memory case had a relative `"data"` literal, which put an in-memory
  // run's tree in whatever directory it happened to start from.
  const dataDir =
    config.dbPath === ":memory:"
      ? join(CINDERPAW_HOME, "data")
      : require("node:path").dirname(config.dbPath);
  const observations = new ToolObservationLog(dataDir);

  // --- Fractal Memory Search (semantic recall over the RAPTOR tree) ---
  // Wraps the legacy RecallEngine: with a built tree + an embedding model it
  // serves the semantic + FTS5 hybrid; otherwise it transparently falls back
  // to RecallEngine, so there is zero regression before the model is on disk.
  // The tree is loaded from disk here; the first build runs in the background
  // after the embed bridge is wired (below), and is a no-op without a model.
  //
  // `loadLeaves` reuses the per-row embedding already stored in SQLite when
  // present — that's what makes subsequent rebuilds free of re-embedding.
  // `persistEmbeddings` is the write-back hook the tree builder calls after
  // each chunk, so freshly-computed vectors land on disk for next time
  // (crash-safe: rows that didn't get written just get re-embedded next run).
  // Organism pulse forwarder: FractalMemory emits recall/grow activity that
  // drives the living Mandelbrot. The transport doesn't exist yet, so route
  // through a holder wired to it below (same pattern as `sendHolder`).
  const fractalActivitySink: { current: (a: FractalActivity) => void } = {
    current: () => {},
  };
  // --- Rebuild cap ---
  // A rebuild summarises the corpus through the ACTIVE model. On a cloud
  // primary an uncapped rebuild ships ~2.7k leaves in one call, the provider
  // rejects it with "context window exceeds limit", and the tree is left EMPTY
  // — 0% recall on both engines, silently, until someone notices recall has
  // stopped working. This used to be only a warning telling the operator to
  // set an env var before launching; nobody reads a log line at boot, and the
  // failure it predicts is invisible. Cap it ourselves and say so.
  //
  // Local primaries stay uncapped: the summariser is on-device, a big rebuild
  // costs time rather than a hard provider rejection, and the full corpus
  // gives the best tree.
  const fractalMaxLeaves = ((): number => {
    const explicit = cfgInt("CINDERPAW_FRACTAL_BENCH_MAX_LEAVES");
    if (explicit > 0) return explicit;
    const baseUrl = cfgPath("CINDERPAW_BASE_URL") ?? "";
    const isLoopback = baseUrl === "" || /^(https?:\/\/)?(127\.|localhost)/i.test(baseUrl);
    if (isLoopback) return 0; // uncapped — on-device summariser
    log(
      `[bench-cap] cloud primary (${baseUrl}) with no CINDERPAW_FRACTAL_BENCH_MAX_LEAVES — ` +
        `capping the fractal rebuild at ${CLOUD_REBUILD_LEAF_CAP} leaves so the provider ` +
        `cannot reject the whole corpus and leave an empty tree (0% recall). ` +
        `Set CINDERPAW_FRACTAL_BENCH_MAX_LEAVES explicitly to override.`,
    );
    return CLOUD_REBUILD_LEAF_CAP;
  })();

  const fractalMemory = new FractalMemory({
    loadLeaves: () =>
      episodic.all().map((e) => ({
        id: e.id ?? 0,
        text: e.content,
        vec: e.embedding ?? new Float32Array(0), // reuse stored vec when present
        ts: e.timestamp,
        sessionId: e.sessionId,
      })),
    embed: (texts) => embed(texts),
    summarize: summarizeFromRouter(router),
    ftsSearch: (q, limit) => episodic.search(q, limit),
    fallback: recall,
    treePath: require("node:path").join(dataDir, "fractal-tree.json"),
    leafStorePath: require("node:path").join(dataDir, LEAF_STORE_FILENAME),
    // Dev-only subset cap for the benchmark gate: build/measure over the first
    // N leaves so we get real numbers in minutes on CPU instead of hours over
    // the full corpus. Unset in production (whole corpus). See FractalMemoryDeps.
    maxLeaves: fractalMaxLeaves,
    log,
    persistEmbeddings: (rows) => episodic.setEmbeddings(rows),
    clearEmbeddings: () => episodic.clearEmbeddings(),
    onActivity: (a) => fractalActivitySink.current(a),
  });

  // (The old [bench-cap] WARN lived here. It told the operator to set an env
  // var *before launching* — advice nobody can act on from a log line emitted
  // during launch, for a failure that is silent when it happens. `fractalMaxLeaves`
  // above now applies the cap itself and logs what it did.)

  fractalMemory.init();

  // --- Tools (each gated by the sandbox) ---
  // ask_user bridge is created up front so the registry can hand it to
  // every tool's context. The bridge emits `ask_user` events through a
  // mutable holder — we wire the holder's target to `transport.send` once
  // the transport is built (a few lines below). Before that, events are
  // silently dropped, which is fine because no tool can run before the
  // transport is started.
  const sendHolder: { current: (e: import("./types.ts").OutboundEvent) => void } = {
    current: () => {},
  };
  const askUser = new AskUserBridgeImpl((e) => sendHolder.current(e));

  // Host-owned tools (off unless CINDERPAW_HOST_TOOLS names a file). Same
  // sendHolder plumbing as askUser: the call goes out over the transport, the
  // host runs it, and `tool_response` routes the answer back. Always
  // constructed so the response wiring is unconditional; it registers nothing
  // until the host declares something.
  const hostTools = new HostToolBridge((e) => sendHolder.current(e));

  // Desktop-control bridge — structural OS control of native apps via the Rust
  // host. Same sendHolder plumbing as askUser: the request flows out over the
  // transport, the Rust host runs the OS action behind its security gate, and
  // the `desktop_control_response` is routed back to the bridge below. The
  // `control_app` tool is only registered when the user has opted in (see
  // CINDERPAW_ENABLE_DESKTOP_CONTROL); the bridge itself is always created so the
  // response-routing wiring is unconditional.
  const desktopControl = new DesktopControlBridgeImpl((e) => sendHolder.current(e));
  // Capability bridge. 60s rather than the desktop bridge's 30: an install
  // fetches a manifest and then a file over the network, and a timeout that
  // fires mid-download would leave the user staring at a failure for a request
  // the host is still happily servicing.
  const capabilityBridge = new RequestBridge(
    (e) => sendHolder.current(e),
    "capability",
    60_000,
  );
  // 180s: applying an update downloads an installer. A timeout that fires
  // mid-download reports failure for something the host is still doing, and
  // the user then tries again on top of a running install.
  const adminBridge = new RequestBridge(
    (e) => sendHolder.current(e),
    "admin",
    180_000,
  );

  // --- P0-4: hook registry. Shared singleton that every layer can
  // emit into and any plugin / future tool can subscribe to. The
  // tool registry receives it next so before_tool_call handlers can
  // block tool invocations.
  const hooks = new HookRegistry();

  // The user's own commands on the same events. Installed here, before any
  // tool can run, so a `before_tool_call` freeze check cannot be raced by the
  // first turn. Says how many it found: a hook system that gives no sign of
  // having read your file is one you debug by guessing.
  const userHookCount = installUserHooks(hooks, log);
  if (userHookCount > 0) {
    log(`hooks: ${userHookCount} user hook(s) installed from ${userHooksPath()}`);
  }

  // --- Reconciler (Pathway 3 step 2 Task 2 + Task 3) ---
  // Single subscriber to `after_memory_write`. Task 3 wires
  // `fractal.upsertLeaf(...)` for fact writes; Task 4 will additionally
  // mirror the result into `memoryGraph.reconcile(treeView)`. Started
  // here — after `fractalMemory.init()` and after `hooks` is built —
  // so the tree is ready before the first capture event arrives.
  const reconciler = new Reconciler({
    hooks,
    fractal: fractalMemory,
    graph: memoryGraph,
    embed,
  });
  reconciler.start();

  // NOTE: the fractal migration used to run HERE, ~400 lines before
  // `setEmbedInvoker(...)` was called. It therefore embedded with no invoker
  // configured, failed every time with "embed: no invoker configured", logged
  // "will retry next boot", and retried forever — so the pre-step1 facts were
  // never lifted into the reactive tree and semantic recall silently stayed
  // FTS5-only. It now runs immediately after the invoker is wired; see below.

  const registry = new ToolRegistry(egress, audit, processSandbox, observations, askUser, undefined, hooks, desktopControl, capabilityBridge, adminBridge);

  // R5: the sidecar is the single owner of live MCP connections (see
  // sandbox/mcp-manager.ts). Boot reconcile runs in the background — a
  // slow or broken extension must never delay agent startup. The desktop
  // pokes `mcp_reload` after every config change (install/toggle/remove).
  const mcpManager = new McpManager(registry, audit.logger);
  void mcpManager
    .reconcile()
    .then(() => {
      const running = mcpManager.status().filter((s) => s.running).length;
      if (running > 0) log(`mcp: ${running} server(s) connected`);
    })
    .catch((e) => log(`mcp: boot reconcile failed: ${String(e)}`));

  registry.register(createReadFileTool(config.workspaceRoots));
  registry.register(createWriteFileTool(config.workspaceRoots));
  registry.register(createListDirectoryTool(config.workspaceRoots));
  // edit_file: in-place string replacement (safer than overwriting)
  registry.register(createEditFileTool(config.workspaceRoots));
  // file_search: glob-style file finder under the workspace
  registry.register(createFileSearchTool(config.workspaceRoots));
  // grep: regex content search under the workspace
  registry.register(createGrepTool(config.workspaceRoots));
  // shell_exec: argv-only program runner (NO shell — no injection surface),
  // scoped to the workspace roots and a binary whitelist. On by default so the
  // agent can actually run things; set CINDERPAW_ENABLE_SHELL_EXEC=false to disable.
  if (readEnv("CINDERPAW_ENABLE_SHELL_EXEC") !== "false") {
    registry.register(createShellExecTool(config.workspaceRoots));
    // tool_forge: the agent creates/modifies/deletes its OWN tools. Same
    // trust class as shell_exec (arbitrary code in a sandboxed subprocess),
    // hence the same gate. Persisted tools are re-registered every boot.
    // `health` enables the boot-time pruning pass: forged tools that were
    // never called in 30 days, or that mostly fail, are deleted instead of
    // re-registered. Without it the tool surface only grows.
    const forgeDeps = { registry, workspaceRoots: config.workspaceRoots, health: observations };
    const restored = registerPersistedCustomTools(forgeDeps);
    if (restored.length > 0) log(`tool_forge: restored ${restored.length} custom tool(s): ${restored.join(", ")}`);
    registry.register(createToolForgeTool(forgeDeps));
  }
  // git_*: process-spawn tools for the workspace
  registry.register(createGitStatusTool(config.workspaceRoots));
  registry.register(createGitDiffTool(config.workspaceRoots));
  registry.register(createGitLogTool(config.workspaceRoots));
  registry.register(createGitCommitTool(config.workspaceRoots));
  registry.register(createGitBranchTool(config.workspaceRoots));
  // http_request: open egress by default ("*" = any public host; the egress
  // proxy still blocks loopback/private/link-local, rate-limits, and audits
  // every call). Set CINDERPAW_HTTP_DOMAINS to RESTRICT to a comma-separated list.
  const httpDomains = (readEnv("CINDERPAW_HTTP_DOMAINS") ?? "")
    .split(",").map((d) => d.trim()).filter(Boolean);
  registry.register(createHttpRequestTool(httpDomains.length > 0 ? httpDomains : ["*"]));
  // time_date + calculator: pure utilities, no permissions
  registry.register(createTimeDateTool());
  registry.register(createCalculatorTool());
  registry.register(createWebSearchTool({ searxngOrigin: searxng }));
  // fetch_url: open egress by default, same posture as http_request above.
  // Set CINDERPAW_FETCH_DOMAINS to RESTRICT.
  const fetchDomains = (readEnv("CINDERPAW_FETCH_DOMAINS") ?? "")
    .split(",").map((d) => d.trim()).filter(Boolean);
  registry.register(createFetchUrlTool(fetchDomains.length > 0 ? fetchDomains : ["*"]));
  // read_webpage: Jina Reader — extracts clean markdown from any URL (no API key needed)
  const jinaApiKey = readEnv("CINDERPAW_JINA_API_KEY");
  registry.register(createReadWebpageTool(jinaApiKey));
  // deep_research: DeepResearch-style iterative loop (search → read → extract → synthesize)
  registry.register(createDeepResearchTool(router, jinaApiKey));
  // tool_health: ECC-style health report — agent can diagnose its own tool reliability
  registry.register(createToolHealthTool(observations));
  // scan_workspace: ECC AgentShield — detect secrets + code security issues in workspace
  registry.register(createScanWorkspaceTool(config.workspaceRoots[0]!));
  // read_skill: Claude Code-style on-demand body loader for locally-installed
  // skills. The system prompt only carries a short menu; the LLM calls this
  // tool to load the full SKILL.md body of any skill it wants to apply.
  registry.register(createReadSkillTool(join(CINDERPAW_HOME, "skills")));
  // list_skills: the drawer index. Skills are no longer dumped into every
  // prompt; the model calls this to discover ids, then read_skill to load one.
  registry.register(createListSkillsTool(join(CINDERPAW_HOME, "skills")));
  // Capability acquisition. Registered unconditionally: the tools check for
  // the host bridge themselves and report "not available on this transport"
  // rather than vanishing, so a model that reasonably expects to be able to
  // install something gets an answer instead of silence.
  for (const t of createCapabilityTools()) registry.register(t);
  // The act half of the CLI — update, switch model. Registered alongside the
  // read-only self_* family so the agent has one obvious place to look.
  for (const t of createCinderpawAdminTools()) registry.register(t);
  // product_info: bundled PRODUCT.md — the agent's factual reference about
  // Cinderpaw itself (setup, connectors, commands). Zero permissions.
  registry.register(createProductInfoTool());

  // F7 — code-quality tools. Auto-detect project type and run the
  // appropriate command (npm test, cargo test, pytest, go test, make test,
  // etc.). All five share the same factory and the same exec allowlist
  // (resolved at module load time per F0.5 hardening).
  // todo_write: the agent's durable task list. Both the tool and its store
  // existed but were never instantiated or registered — the agent has been
  // running without a task list at all, which is why long tasks lose track of
  // what is already finished. The same store feeds the per-turn todo block in
  // WorkingMemory (see agent.setTodoStore below).
  const todoStore = new TodoStore(db.raw);
  registry.register(createTodoWriteTool(todoStore));
  registry.register(createCodeQualityTool("run_tests", config.workspaceRoots));
  registry.register(createCodeQualityTool("format_code", config.workspaceRoots));
  registry.register(createCodeQualityTool("lint_code", config.workspaceRoots));
  registry.register(createCodeQualityTool("install_deps", config.workspaceRoots));
  registry.register(createCodeQualityTool("build_project", config.workspaceRoots));

  // Say what the switch took away. Somebody who sets
  // CINDERPAW_ENABLE_SHELL_EXEC=false and then finds git_status missing has no
  // way to tell a working security control from a broken install, and the
  // difference decides whether they trust the switch or work around it.
  if (registry.withheldForShellExec.length > 0) {
    log(
      `CINDERPAW_ENABLE_SHELL_EXEC=false: ${registry.withheldForShellExec.length} tool(s) that run ` +
        `programs were not registered: ${registry.withheldForShellExec.join(", ")}`,
    );
  }

  // ask_user — interactive questions (Claude.ai-style). No permissions;
  // pure event emission through the AskUserBridge in the tool context.
  registry.register(createAskUserTool());

  // control_app — OS-level desktop control via the accessibility tree. This
  // is powerful (it can click/type into any non-denylisted app), so it is
  // OPT-IN, exactly like shell_exec: enable with CINDERPAW_ENABLE_DESKTOP_CONTROL=true.
  // The Rust host ALSO independently gates every call on the same flag plus an
  // app allow/deny policy, so even if this registration is reached the host is
  // the final authority. Default OFF.
  if (cfgBool("CINDERPAW_ENABLE_DESKTOP_CONTROL")) {
    registry.register(createControlAppTool());
    log("control_app enabled (CINDERPAW_ENABLE_DESKTOP_CONTROL=true) — OS desktop control is active");
  }

  // recall — read-only on-demand semantic search over past conversations,
  // backed by Fractal Memory Search. Capture stays reactive (MemoryExtractor);
  // this is the explicit-search counterpart to per-turn auto-injection.
  // L4 (§1.1): the search routes through the retrieval_strategy seam — a
  // promoted module replaces the ranking; with none promoted the builtin
  // fast-path calls FractalMemory.query directly (no process boundary).
  const retrievalSeam = liveSeamAdapter(
    "retrieval_strategy",
    async (_method, params) => {
      const p = params as { query: string; k: number };
      return hitsToItems(await fractalMemory.query(p.query, p.k));
    },
    log,
  );
  registry.register(
    createRecallTool(
      async (q, limit) =>
        itemsToHits(
          await retrievalSeam.invoke("retrieve", { query: q, k: limit, sessionId: "recall-tool" }),
          limit,
        ),
      semantic,
    ),
  );
  // remember — the write half. The extractor's capture is async and often
  // lands after the user has already moved on, so an explicit "remember X"
  // needs a synchronous path or the fact is simply lost.
  registry.register(createRememberTool(semantic));

  // P0-1: delegate_task — spawn a subagent for an isolated, bounded
  // task. The subagent inherits the parent's router / sandbox /
  // audit / hooks but gets its own WorkingMemory, filtered
  // registry, and budget.
  //
  // Each subagent spends its own model budget, so a run with a hard cost
  // ceiling may want the capability gone rather than merely discouraged: the
  // model decides to delegate on its own, and a prompt asking it not to is not
  // a limit. Set CINDERPAW_ENABLE_SUBAGENTS=false to withhold the tool.
  // Default ON — an ordinary install keeps delegation, which is the point of
  // having it. Note this withholds the TOOL only; `rlm()` still runs the same
  // Subagent machinery underneath, because that is a different feature.
  if (readEnv("CINDERPAW_ENABLE_SUBAGENTS") !== "false") {
  registry.register(createDelegateTaskTool({
    router,
    parentRegistry: registry,
    allTools: registry.list(),
    audit,
    egress,
    process: processSandbox,
    observations,
    episodic,
    hooks,
    parentSessionIdFor: (ctxSessionId) =>
      // The tool's ctx.sessionId is either the parent sessionId
      // itself (when the tool is called by the parent agent) or a
      // subagent's child sessionId (for nested delegation). We
      // surface the parent's id by stripping the subagent prefix.
      ctxSessionId.startsWith("subagent:")
        ? ctxSessionId.split(":")[1] ?? ctxSessionId
        : ctxSessionId,
  }));
  }

  // notebook: the RLM design — a persistent JS interpreter with every other
  // tool bound as an async function, so the agent composes tool calls in code
  // instead of one per turn. Off by default; CINDERPAW_ENABLE_NOTEBOOK=true.
  //
  // Registered after delegate_task so `registry.list()` is complete and the
  // notebook's children can reach the same tools a delegated subagent can.
  // `rlm()` is the recursion: it runs the same Subagent delegate_task uses, so
  // a child still gets its own working memory, filtered registry and budget —
  // read-only by default, exactly like delegate_task, so code that spawns
  // workers cannot quietly acquire write access the parent never granted.
  if (cfgBool("CINDERPAW_ENABLE_NOTEBOOK")) {
    const notebookSubagent = new Subagent({
      router,
      allTools: registry.list(),
      audit,
      egress,
      process: processSandbox,
      observations,
      episodic,
      hooks,
    });
    // Shared so a child can find the parent that admitted it.
    const childRegistries: ChildRegistries = new Map();
    registry.register(createNotifyParentTool(childRegistries));
    registry.register(createNotebookTool({
      registry: () => registry,
      registries: childRegistries,
      // Snapshots live beside the agent's other state so a notebook survives a
      // gateway restart — upstream persists its kernel namespace for the same
      // reason. Only JSON-round-trippable variables come back; see repl.ts.
      stateDir: join(cinderpawHome(), "notebooks"),
      // Worker telemetry out to the UI. `sendHolder` rather than the turn's
      // emitter: by the time a child does anything, the turn that spawned it
      // has ended — that is what `rlm()` is for.
      onChildEvent: (e) => sendHolder.current({ type: "rlm_child", ...e }),
      runChild: async (task, allowedTools, sessionId, onEvent, childId, signal) => {
        // A background worker used to leave exactly two traces in the log —
        // the two `tools: N of M` lines its AgentLoop prints on construction —
        // and nothing at all when it finished. Diagnosing a stuck fan-out meant
        // reading the process's open sockets to guess whether it was still
        // alive. Two lines fix that; they cost nothing and only appear when
        // somebody actually spawned a worker.
        const startedAt = Date.now();
        log(`rlm: child ${childId} started — ${task.slice(0, 80).replace(/\s+/g, " ")}`);
        const r = await notebookSubagent.run({
          task,
          signal,
          // The registry's id becomes the subagent id, so the child's session
          // carries it and notify_parent can route back to this entry.
          subagentId: childId,
          // notify_parent is always granted: a worker that cannot report is
          // the thing the mailbox exists to fix, and it reaches only the
          // parent that spawned it.
          allowedTools: [...(allowedTools ?? NOTEBOOK_CHILD_TOOLS), NOTIFY_PARENT_TOOL_NAME],
          budget: { maxTokens: 4096, maxIterations: 8 },
          parentSessionId: sessionId.startsWith("subagent:")
            ? sessionId.split(":")[1] ?? sessionId
            : sessionId,
          // Feeds `rlm.observe()`. Only the shape the parent can act on: what
          // kind of thing happened and a short detail, never the raw event.
          onEvent: (e) => {
            const ev = e as { type?: string; tool?: string; message?: string };
            onEvent(ev.type ?? "event", ev.tool ?? ev.message ?? "");
          },
        });
        log(
          `rlm: child ${childId} ${r.status} in ${Math.round((Date.now() - startedAt) / 1000)}s ` +
            `(${r.toolCalls} tool call(s))`,
        );
        return r;
      },
    }));
    log("notebook: enabled (CINDERPAW_ENABLE_NOTEBOOK=true), rlm() wired");
  }

  // Lead-handling tools for the public connector mode (WhatsApp "business"
  // persona). They are registered globally but only EXPOSED to the public
  // profile (see PUBLIC_ALLOWED_TOOLS in transports/connectors.ts). The shared
  // LeadDesk lets escalate/schedule reach the live connector (owner ping +
  // conversation pause); records land under ~/.cinderpaw/leads/.
  const leadsDir = join(CINDERPAW_HOME, "leads");
  const leadDesk = new LeadDesk();
  registry.register(createCaptureLeadTool(leadsDir));
  registry.register(createEscalateToHumanTool(leadDesk, leadsDir));
  registry.register(createScheduleMeetingTool(leadDesk, leadsDir));

  // --- Proactive subsystem (X1) ---
  // MoodEngine + InnerThoughtsLoop used to be wired into core by default
  // (CINDERPAW_INNER_THOUGHTS_ENABLED !== "false"). That burned inference on
  // every idle cycle, contended with the global MODEL mutex (P6), and
  // contradicted the "no-compromise privacy" pitch. They are now an
  // explicit, opt-in subsystem:
  //
  //   CINDERPAW_PROACTIVE_ENABLED=true  → load + wire mood + inner-thoughts
  //   default (unset / =false)        → neither module is loaded or run
  //
  // The modules themselves are kept on disk (mood.ts, inner-thoughts.ts)
  // for power users / future revival. They are loaded via dynamic import
  // so a sidecar that never opts in pays zero cost — no eager class
  // definitions, no startup work, no `setInterval` ticking, no router
  // contention, no audit-log writes from `#persistThought`.
  const proactiveEnabled = cfgBool("CINDERPAW_PROACTIVE_ENABLED");
  let mood: import("./core/mood.ts").MoodEngine | null = null;
  let innerThoughts: import("./core/inner-thoughts.ts").InnerThoughtsLoop | null = null;
  if (proactiveEnabled) {
    const { MoodEngine } = await import("./core/mood.ts");
    const { InnerThoughtsLoop } = await import("./core/inner-thoughts.ts");
    mood = new MoodEngine();
    log("mood engine enabled (CINDERPAW_PROACTIVE_ENABLED=true)");

    // Inner thoughts loop — heavily gated so it surfaces at most 2-3
    // messages per day, NEVER interrupts active conversations, and only
    // fires when there's genuine signal in mood + recent activity.
    // See InnerThoughtsLoop for gate details.
    innerThoughts = new InnerThoughtsLoop(router, episodic, mood, db.raw, {
      intervalMs: Number(readEnv("CINDERPAW_THOUGHTS_INTERVAL_MS") ?? 2 * 60 * 1000),
      // 10 min idle — definitely a real break, not just the user looking
      // away from the screen for a second.
      minIdleMs: Number(readEnv("CINDERPAW_THOUGHTS_MIN_IDLE_MS") ?? 10 * 60_000),
      // 4 hours between messages — caps cadence at ~1 per idle period.
      cooldownMs: Number(readEnv("CINDERPAW_THOUGHTS_COOLDOWN_MS") ?? 4 * 60 * 60_000),
      // Hard daily cap: 2-3 proactive messages per UTC day. The user
      // can override higher (CINDERPAW_THOUGHTS_DAILY_CAP=10) or lower (=0
      // to effectively disable emits). The four gates together produce
      // a maximally non-spammy agent when the user opts in.
      dailyCap: Number(readEnv("CINDERPAW_THOUGHTS_DAILY_CAP") ?? 3),
      moodGateThreshold: Number(readEnv("CINDERPAW_THOUGHTS_MOOD_THRESHOLD") ?? 0.5),
    });
    log("inner-thoughts loop enabled (opt-in via CINDERPAW_PROACTIVE_ENABLED)");
  }

  // --- Memory extractor (async, fire-and-forget after each turn) ---
  // Path 3 step 2: the extractor fires `after_memory_write` to the
  // shared HookRegistry on every fact / observation persistence. The
  // Reconciler (constructed earlier in this file) subscribes to the
  // event and keeps the fractal tree reactive. Without a registry
  // attached, the extractor silently no-ops the fires (pre-Path-3
  // behaviour).
  const extractor = new MemoryExtractor(router, semantic, episodic, hooks);
  extractor.setGraph(memoryGraph);

  // --- Layer 1: Agent core ---
  // Brain Stack wiring. A hand-written brain.json still wins — including
  // `enabled: false`, which stays the documented way to keep routing off.
  // When there is no file we DERIVE a config from the targets the router
  // is already configured with, so a fresh machine routes too.
  //
  // Until Phase 1 this line was `brainCfg ? … : null` with nothing in the
  // product ever writing brain.json, so every shipped copy of Cinderpaw ran
  // with model routing absent rather than degraded — and the only trace
  // was a comment in this file (see
  // docs/ui/2026-08-19-brain-current-state.md §3).
  //
  // Each BrainStack owns its own CircuitBreaker instance — tool-health and
  // model-health live in separate namespaces until S6 generalises the key.
  // `loadBrainConfig()` returns null for BOTH "no file" and "file says
  // enabled: false". Only the first may fall through to derivation — the
  // second is a decision the user made and we do not overrule it.
  // SAFE: malformed brain.json must not crash boot — log and fall back to derived or disabled.
  let brainCfg: import("./brain/brain-config.ts").BrainConfig | null = null;
  try {
    brainCfg =
      loadBrainConfig() ??
      (brainConfigFileExists()
        ? null
        : deriveDefaultConfig([
            config.inference.primary,
            config.inference.fallback,
          ]));
  } catch (e) {
    log(`brain: invalid brain.json — using derived config if available (${String(e)})`);
    try {
      brainCfg = brainConfigFileExists()
        ? null
        : deriveDefaultConfig([config.inference.primary, config.inference.fallback]);
    } catch {
      brainCfg = null;
    }
  }
  // Whether the config came from us or from the user. A model switch may
  // rebuild a DERIVED brain (see rebuildDerivedBrain); a hand-written
  // brain.json is a deliberate choice of models and is never overwritten.
  const brainDerived = brainCfg !== null && !brainConfigFileExists();
  // One breaker for the brain's lifetime, so a model switch does not also
  // reset what we have learned about which endpoints are unwell.
  const brainBreaker = new CircuitBreaker();
  const brain = brainCfg ? new BrainStack(brainCfg, brainBreaker, log) : null;
  const agent = new AgentLoop(
    router, registry, episodic,
    { onBudgetExhausted: config.inference.tokenBudget.onExhausted },
    fractalMemory,
    extractor,
    soul,
    user,
    hooks,
    brain,
  );

  // Memory Resume: persist what the user is working on so `resume_get` (the
  // WelcomeBack banner, the TUI last-task row) has something to read — before
  // this, nothing wrote these rows and both were always null (blocker F7).
  // The loop fires this for owner turns on every surface and filters out
  // machine sessions and public-persona profiles itself.
  // ponytail: the message text is the title; a model-generated label would
  // cost a completion per turn.
  agent.setTodoStore(todoStore);

  // The notebook read side. `semantic` already exists (line ~493); this only
  // gives the loop a filtered view of it.
  //
  // `own` rather than `all`: the notebook must show this session ONLY its own
  // notes. `all` folds the global rows in — right for facts, wrong for a
  // scratchpad, which would otherwise render the owner's in-flight notes into a
  // Discord member's prompt. See SemanticMemory.own.
  agent.setNotebookStore({
    notes: (scope) =>
      semantic
        .own(scope)
        .filter((f) => f.key.startsWith(NOTE_PREFIX))
        .map((f) => ({ key: f.key, value: f.value })),
  });

  // The compaction safety net (Task 5): refresh `note:position` from the
  // summarizer's own output when the agent stopped updating it itself.
  agent.setNotebookWriter((sessionId, position) => {
    semantic.upsert(POSITION_KEY, position, memoryScope(sessionId));
  });

  // Crash-resume checkpointing: the loop snapshots the transcript after each
  // tool call and rehydrates a session that died mid-turn. On boot, log any
  // in-flight turns left by a previous process so the crash is visible.
  const checkpoints = new CheckpointStore(db.raw);
  agent.setCheckpointStore(checkpoints);
  const stranded = checkpoints.incomplete();
  if (stranded.length > 0) {
    log(`checkpoint: ${stranded.length} session(s) left mid-turn by a prior process — will resume on next access`);
  }

  agent.setUserTurnObserver((_sessionId, userText) => {
    const now = Date.now();
    touchLastActive(db.raw, now);
    setCurrentTask(db.raw, {
      title: userText.trim().slice(0, 80),
      ts: now,
      workspaceId: getActiveWorkspaceId(db.raw),
    });
  });

  // --- Heartbeat loop (P2-#1) ---
  // Periodic OutboundEvent so the Tauri shell knows the sidecar is
  // alive. The transport's onMessage handler should treat absence of
  // heartbeats for N intervals as a hang signal.
  const heartbeat = new HeartbeatLoop({
    intervalMs: Number(readEnv("CINDERPAW_HEARTBEAT_INTERVAL_MS") ?? 30_000),
    getActiveSessions: () => agent.activeSessionCount,
  });

  // --- Cron scheduler (P0-3) ---
  // User-schedulable jobs that run in the background.
  //
  // X3 fix (cron-as-agent): each job now runs through the full `AgentLoop`
  // — the same tool registry (read_file / web_search / delegate_task all
  // resolve), the same budget gates, episodic memory, and audit trail as a
  // user-driven session. The `cron:${job.id}` sessionId gives every job its
  // own WorkingMemory, so cron runs never pollute a real user's transcript,
  // and the per-session mutex in `handle()` serializes overlapping runs of
  // the same job. Streaming events from the run are swallowed (there is no
  // live chat to render them); only the final answer is delivered, and
  // failures surface via `onJobError` below.
  // The scheduler's wall-clock cap must cover a full turn plus every automatic
  // continuation, or this timer fires first and a job that was working fine is
  // recorded as a timeout. Sized from the real budgets rather than a flat
  // constant, so raising either one does not silently break the other.
  const cronJobTimeoutMs = Number(
    readEnv("CINDERPAW_CRON_JOB_TIMEOUT_MS") ??
      turnBudgetMs() * (cfgInt("CINDERPAW_UNATTENDED_CONTINUATIONS") + 1) + 60_000,
  );
  /**
   * The world's opinion on "is it done", for a turn that claimed it was.
   *
   * Returns null when no assertion was given — with nothing to check, the
   * agent's word is all anyone has, and `runUnattended` accepts it exactly as
   * it did before. `checked: false` (an assertion that could not be evaluated)
   * is also null: an unrunnable check must not be read as a failing one, or a
   * bad path would trap a run in a continuation loop it can never leave.
   */
  async function verifyIfAsserted(
    doneWhen: DoneWhen | null,
    safety: SafetyPoint[],
  ): Promise<{ passed: boolean; detail: string } | null> {
    if (!doneWhen) return null;
    try {
      const check = await verifyDoneWhen(doneWhen, safety[0]?.root ?? null);
      return check.checked ? { passed: check.passed, detail: check.detail } : null;
    } catch {
      // A verifier that throws must not be the reason a finished run is sent
      // back round. Unknown is not failed.
      return null;
    }
  }

  /**
   * How many tasks are currently finished.
   *
   * This DOES match on a status string, which an earlier note here warned
   * against because statuses are free-form. That warning is out of date: the
   * per-turn todo drawer already splits on exactly `status !== "done"`
   * (WorkingMemory.setTodoList) and `TodoStore.add` defaults to `"todo"`, so
   * "done" is a convention the prompt side already commits to. Two places
   * disagreeing about what closed means would be worse than either choice.
   *
   * An unrecognized status simply counts as open — the guard then falls back to
   * `filesChanged`, which is where it was before this existed.
   */
  function countDoneTodos(): number {
    try {
      return todoStore.list().filter((t) => t.status.trim().toLowerCase() === "done").length;
    } catch {
      // Progress accounting must never be the reason a run stops.
      return 0;
    }
  }

  /**
   * Turn each finished turn into a row, with progress read off the disk rather
   * than taken from the turn's own account of itself. An agent that reports
   * success and wrote nothing looks identical from the inside; it does not look
   * identical to git.
   */
  function turnRecorder(row: RunRow, safety: SafetyPoint[], doneWhen: DoneWhen | null) {
    // Both are cumulative-since-run-start, so both are kept as "what it was
    // after the previous turn" and compared.
    let lastPrint: string | null = null;
    let lastTokens = router.conversationTokens(row.sessionId);
    let lastDone = countDoneTodos();
    return {
      record: async (t: TurnRecord & { startedAt: number; tokens: number }) => {
        const changed = await changedSince(safety);
        const print = changeFingerprint(changed);
        // Identical stamp = the workspace is in the same state it was in after
        // the previous turn, i.e. this turn produced nothing. That is the
        // question `decideResume`'s crash-loop guard asks.
        const advanced = lastPrint !== null && print !== lastPrint;
        const firstTurn = lastPrint === null;
        lastPrint = print;

        // ponytail: assertions resolve against the primary root, as they always
        // have. A done_when naming a file in a secondary root would miss — give
        // the assertion an explicit root if that ever comes up.
        const cheap = await verifyDoneWhen(doneWhen, safety[0]?.root ?? null, CHEAP_CHECKS);
        // The router counts tokens per conversation, cumulatively; a turn's cost
        // is the delta. It cannot be split into prompt/completion at this seam,
        // which is why the column is a single total.
        const total = router.conversationTokens(row.sessionId);
        const spent = Math.max(0, total - lastTokens);
        lastTokens = total;

        // Cumulative, like the token counter above, so a turn's contribution is
        // the delta. Clamped at 0: reopening a task is not negative progress,
        // it is a turn that closed nothing.
        const doneNow = countDoneTodos();
        const closed = Math.max(0, doneNow - lastDone);
        lastDone = doneNow;

        runStore.appendTurn({
          runId: row.id,
          startedAt: t.startedAt,
          durationMs: t.durationMs,
          outcome: t.outcome,
          toolCalls: t.toolCalls,
          continuation: t.continuation,
          replan: t.replan ?? false,
          tokens: spent,
          // The count is the cumulative one, which is what a report wants
          // ("14 files touched"); zero means this turn moved nothing, which is
          // what the guard wants. On the very first turn any change at all is
          // this turn's work.
          filesChanged:
            firstTurn || advanced ? (changed.available ? changed.files.length : 0) : 0,
          // Hardcoded 0 while `filesChanged` alone drove every decision. It no
          // longer does: `madeNoProgress` needs BOTH to be zero, so a permanent
          // zero here made the second half of the guard decorative — and a turn
          // that closed three tasks without touching a file counted as a stall.
          todosClosed: closed,
          doneWhenPass: cheap.checked ? cheap.passed : null,
        });
      },
    };
  }

  /**
   * Deliver a report for a run nobody is waiting on a reply for.
   *
   * A cron run has no chat to speak into, so it logs; a connector run goes back
   * to the channel it came from through the ask router, which already owns
   * "reach the chat behind this session". A delivery that cannot land is logged
   * rather than thrown — the run is already concluded either way, and losing the
   * other interrupted runs to one dead channel would be a worse outcome.
   */
  async function deliverRunReport(row: RunRow, text: string): Promise<DeliveryOutcome> {
    // cron, tui and desktop have no channel to speak into: the log IS the
    // delivery. They still get a row — a run without one has no stall guard and
    // no completion check, which is what the row actually pays for.
    const CHANNELLESS = new Set(["cron", "tui", "desktop"]);
    let outcome: DeliveryOutcome = "sent";
    if (row.delivery && !CHANNELLESS.has(row.delivery.kind)) {
      outcome = await connectors.askRouter.notify(row.delivery.sessionId, text);
      if (outcome === "sent") return outcome;
      log(`run ${row.id}: ${row.delivery.kind} ${outcome} — report only in the log for now`);
    }
    log(`run ${row.id} report:\n${text}`);
    return outcome;
  }

  /**
   * Conclude a run: write the terminal status WITH the text it owes, then hand
   * it over. Every site that ends a run goes through here, so the ordering
   * (see `run-delivery.ts`) is stated once rather than re-derived correctly
   * three times.
   */
  async function concludeRun(
    row: RunRow,
    status: RunStatus,
    reason: RunStopReason,
    text: string,
  ): Promise<void> {
    runStore.finish(row.id, status, reason, text);
    await deliverAndMark(runStore, row, text, deliverRunReport);
  }

  /**
   * The boot pass over runs whose process never came back.
   *
   * Resuming re-enters the ordinary loop on the run's own session, so the
   * durable task list, the transcript and the original safety point are all the
   * ones the run started with — a resumed run diffs against where the WHOLE run
   * began, not where the restart happened.
   */
  async function resumeInterrupted(): Promise<void> {
    // Debts first, then work. These are runs that finished — the process just
    // never got the message out.
    await drainUndelivered(runStore, deliverRunReport, { log });
    await resumeInterruptedRuns(
      runStore,
      Date.now(),
      async (row) => {
        log(`resuming interrupted run ${row.id} (attempt ${row.resumes}): ${row.mission}`);
        const safety = safetyPointsFrom(row);
        let runError: string | null = null;
        const run = await runUnattended(
          (text, messageId) =>
            agent.handleTurn(row.sessionId, text, messageId, (event) => {
              if (event.type === "error") runError = event.message;
            }),
          resumePrompt(row.mission),
          `resume-${row.id}-${Date.now()}`,
          {
            // The deadline is absolute, so what is left is what is left. A run
            // already past it never reaches this callback.
            deadlineMs: row.deadlineAt === null ? undefined : Math.max(1, row.deadlineAt - Date.now()),
            recorder: turnRecorder(row, safety, row.doneWhen),
            stalled: () =>
              row.safetyBefore !== null && madeNoProgress(runStore.turnsOf(row.id), STALL_TURNS),
            verify: () => verifyIfAsserted(row.doneWhen, safety),
          },
        );
        const changed = await changedSince(safety);
        const check = await verifyDoneWhen(row.doneWhen, safety[0]?.root ?? null);
        const finished = run.finished && check.passed;
        // Rendered BEFORE the row is concluded, so the status and the text it
        // owes are written together. See `concludeRun`.
        await concludeRun(
          row,
          finished ? "finished" : "unfinished",
          run.stoppedBecause,
          renderDigest(run, changed, check, safety, `it was interrupted and picked back up at startup${runError ? `, and hit an error: ${runError}` : ""}`, intentSummary(row.sessionId)),
        );
      },
      async (row, decision) => {
        log(`giving up on run ${row.id}: ${decision.reason}`);
        const safety = safetyPointsFrom(row);
        const changed = await changedSince(safety);
        const check = await verifyDoneWhen(row.doneWhen, safety[0]?.root ?? null);
        // Rendered from the persisted turns: the loop that produced them is gone,
        // so this is the only account of the run that still exists.
        const turns = runStore.turnsOf(row.id).map((t) => ({
          outcome: t.outcome,
          toolCalls: t.toolCalls,
          durationMs: t.durationMs,
          continuation: t.continuation,
          ...(t.replan ? { replan: true } : {}),
        }));
        await concludeRun(
          row,
          decision.status,
          decision.reason,
          renderDigest(
            {
              text: "",
              outcome: turns.at(-1)?.outcome ?? "no_answer",
              finished: false,
              turns,
              stoppedBecause: "not_continuable",
            },
            changed,
            check,
            safety,
            decision.why,
          ),
        );
      },
      { log },
    );
  }

  const cronRepo = new CronJobsRepo(db.raw);
  const cronScheduler = new CronScheduler({
    repo: cronRepo,
    runJob: async (job) => {
      const sessionId = `cron:${job.id}`;
      try {
        // `handleTurn()` never throws — on failure it emits an `error` event to
        // the sink and returns the error text. Capture that event and throw
        // so the scheduler records the run as failed (and onJobError fires)
        // instead of delivering the error string as a "result".
        let runError: string | null = null;
        // Safety point BEFORE any tool runs, so both "what did it change while
        // I was out" and "put it back" are answerable afterwards.
        const safety = await createSafetyPoints(
          `cron/${job.name}`,
          log,
          config.workspaceRoots,
        );
        const safetyCols = safetyColumns(safety);
        // The durable half: if this process dies mid-run, this row is the only
        // thing that says the run existed. Absent (null) when the session
        // already has one in flight, which for a cron job means the previous
        // firing is still going — let it finish rather than double it.
        const runRow = runStore.startRun({
          sessionId,
          mission: job.task,
          deadlineAt: Date.now() + cronJobTimeoutMs,
          continuationBudget: maxContinuations(),
          safetyRoot: safetyCols.root,
          safetyBefore: safetyCols.before,
          safetyGitDir: safetyCols.gitDir,
          doneWhen: job.doneWhen ?? null,
          delivery: { kind: "cron", target: job.id, sessionId },
        });
        // runUnattended, not handle(): a scheduled task that hits the turn
        // budget half-way gets continued rather than reported as finished.
        const run = await runUnattended(
          (text, messageId) =>
            agent.handleTurn(sessionId, text, messageId, (event) => {
              // No live chat is attached to a cron run — chunk/tool events
              // have nowhere to render; only failures matter here.
              if (event.type === "error") runError = event.message;
            }),
          "You are running as a scheduled background task. Complete the task " +
            "without asking for clarification; produce the final answer.\n\n" +
            `Task: ${job.task}`,
          `cron-${job.id}-${Date.now()}`,
          {
            deadlineMs: cronJobTimeoutMs,
            recorder: runRow ? turnRecorder(runRow, safety, job.doneWhen ?? null) : undefined,
            stalled: runRow
              ? () => runRow.safetyBefore !== null && madeNoProgress(runStore.turnsOf(runRow.id), STALL_TURNS)
              : undefined,
            verify: () => verifyIfAsserted(job.doneWhen ?? null, safety),
          },
        );
        if (runError) throw new Error(runError);
        const changed = await changedSince(safety);
        const check = await verifyDoneWhen(job.doneWhen, safety[0]?.root ?? null);
        const digest = renderDigest(run, changed, check, safety, undefined, intentSummary(sessionId));
        if (runRow) {
          // A cron run's delivery IS the log (it has no channel), so concluding
          // it here both records the report and discharges it. The scheduler's
          // own run history is a separate, already-durable record.
          await concludeRun(
            runRow,
            run.finished && check.passed ? "finished" : "unfinished",
            run.stoppedBecause,
            digest,
          );
        }
        return {
          text: digest,
          // The agent's own claim is not the authority. When a job declares a
          // done_when, that assertion decides whether the run finished.
          finished: run.finished && check.passed,
        };
      } finally {
        // N2 fix: the synthetic `cron:${job.id}` sessionId would otherwise
        // grow the router's per-conversation-token map forever (one entry
        // per scheduled job for the life of the sidecar). Evict it after
        // each run so a long-running Tauri session doesn't accumulate
        // thousands of stale cron entries.
        router.evictSession(sessionId);
        clearIntents(sessionId);
      }
    },
    // X3: failed/timed-out runs become a visible `cron_error` event in the
    // UI instead of dying silently in the run-history table.
    onJobError: (job, message) => {
      transport.send({
        type: "cron_error",
        jobId: job.id,
        jobName: job.name,
        message,
      });
    },
    deliver: (target, content, job, ctx) => {
      // Replace the default emit with transport.send for chat targets
      // and use the egress proxy (when one is registered) for webhooks.
      // For V1 the default fetch (globalThis.fetch) is fine — the
      // webhook URL is admin-controlled, not user-controlled.
      if (target.kind === "chat") {
        transport.send({
          type: "cron_fired",
          jobId: job.id,
          jobName: job.name,
          sessionId: target.sessionId,
          content,
        });
        return;
      }
      return deliverCron(target, content, job, ctx);
    },
    tickIntervalMs: Number(readEnv("CINDERPAW_CRON_TICK_MS") ?? 30_000),
    jobTimeoutMs: Number(readEnv("CINDERPAW_CRON_JOB_TIMEOUT_MS") ?? 5 * 60_000),
  });

  // --- Layer 4: Transport ---
  // Accept an override (e.g. TuiTransport for the terminal chat) or build
  // the default TauriTransport (newline-delimited JSON over stdin/stdout).
  const transport = transportOverride ?? buildTransport(config.transport);
  // Now that the transport exists, wire the ask_user bridge's emit target.
  // Every `ask_user` event from now on flows through the transport to the
  // React UI, and `ask_user_response` messages from the UI are routed back
  // to the bridge inside the `onMessage` handler below.
  sendHolder.current = (e) => transport.send(e);
  // Forward organism pulses as plain sidecar lines; Rust relays every line to
  // the frontend over `cinderpaw://agent-output`, where the organism filters for
  // `type: "fractal_activity"` (mirrors how RSI engine events travel). The
  // kind-discriminated `OutboundEvent` member added below makes this a typed
  // send — no `as unknown` cast needed for `recall` / `grow` / `seed`.
  fractalActivitySink.current = (a) =>
    transport.send({ type: "fractal_activity", ...a });

  // ── Agent Cowork runtime (S3.5) ───────────────────────────────────────────
  // Reactive A2A workers. Zero agents configured ⇒ the tick walks an empty
  // roster ⇒ zero behavior (fresh-install contract). The turn seam mirrors
  // cron's unattended-run shape minus durability extras: cowork threads are
  // conversational, one persistent session per agent so context compounds.
  const coworkAgents = new CoworkAgentRepo(db.raw);
  const coworkMailbox = new CoworkMailboxRepo(db.raw);
  // S4 — deterministic approval gate on the tool-call path. Registered on
  // the shared hook registry: it passes every non-cowork session through
  // untouched and every unclassifiable call through, so with zero cowork
  // agents this is a no-op for the whole product.
  const coworkApprovalService = new CoworkApprovalService({
    approvals: new CoworkApprovalRepo(db.raw),
    agents: coworkAgents,
    emitEvent: (event) => transport.send(event),
    timeoutMs: Number(readEnv("CINDERPAW_CRON_JOB_TIMEOUT_MS") ?? 5 * 60_000),
    log,
  });
  hooks.on("before_tool_call", coworkApprovalService.gate);
  // The one cowork tool that is ALWAYS present: without it a roster could
  // only be created by a seed script or by hand-editing SQLite, so nobody who
  // installed Cinderpaw could reach the feature at all. It registers the two
  // below itself once the roster stops being empty, which is what removes the
  // "requires a restart" caveat that used to live in this comment.
  registry.register(
    createCoworkCreateTool({ agents: coworkAgents, mailbox: coworkMailbox, registry, log }),
  );
  // The glass over the cost meter. buildCostReport/renderCostReport and the
  // router method that renders them had existed with no caller anywhere in the
  // product, so neither the person nor the agent could see the bill.
  registry.register(createTokenUsageTool({ costReport: () => agent.costReport() }));
  // S4.5 — the door from ordinary chat INTO the mailbox. Without these the
  // reactive runtime can never fire: nothing user-facing could write the
  // first message. Registered ONLY when teammates exist, so an install with
  // zero cowork agents gains no way to message one (fresh-install contract).
  if (coworkAgents.list().length > 0) {
    registry.register(createCoworkTeamTool(coworkAgents));
    registry.register(createCoworkSendTool(coworkAgents, coworkMailbox));
    log(`cowork: ${coworkAgents.list().length} teammate(s) configured — cowork_team/cowork_send exposed`);
  }
  const coworkRuntime = new CoworkRuntime({
    agents: coworkAgents,
    mailbox: coworkMailbox,
    handoffs: new CoworkHandoffService(db.raw),
    emitEvent: (event) => transport.send(event),
    runTurn: async (agentRec, prompt, sessionId) => {
      // Each teammate runs under its OWN operating profile: its standing
      // instructions as the system prompt, and only the tools it was created
      // with. This reuses the connector-profile seam rather than inventing a
      // second scoping mechanism — same restricted prompt + tool set, same
      // enforcement in the exec loop.
      //
      // It is also the speed fix. Unscoped, every teammate advertised the
      // whole registry, so each completion re-sent ~16.5k tokens of schema to
      // produce ~600 and spent 13-55 seconds in prefill before the first
      // token. A teammate created with four tools carries four tools.
      //
      // Registered per turn, not once: the roster is editable at runtime, and
      // a profile compiled at boot would pin an agent to whatever it was when
      // the app started. registerProfile only stores the allow-list, so this
      // is cheap and always current.
      const profileId = `cowork:${agentRec.id}`;
      agent.registerProfile(profileId, {
        systemPrompt: [
          `You are ${agentRec.name}${agentRec.role ? `, ${agentRec.role}` : ""}.`,
          agentRec.instructions,
          "You are a teammate inside someone's Cinderpaw install. You answer " +
            "the message you were sent and stop; you do not invent follow-up work.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        // undefined ⇒ the owner's full toolset, which is the pre-scoping
        // behaviour and stays the fallback for teammates created before the
        // column existed.
        allowedTools: agentRec.tools,
      });
      agent.setSessionProfile(sessionId, profileId);
      // `handleTurn()` never throws — it emits `error` events instead
      // (same contract cron relies on). Capture and rethrow so the worker
      // loop records a rejection rather than delivering an error string
      // as if it were the agent's answer.
      let runError: string | null = null;
      const run = await runUnattended(
        (text, messageId) =>
          agent.handleTurn(sessionId, text, messageId, (event) => {
            if (event.type === "error") runError = event.message;
          }),
        prompt,
        `${sessionId}-${Date.now()}`,
        { deadlineMs: Number(readEnv("CINDERPAW_CRON_JOB_TIMEOUT_MS") ?? 5 * 60_000) },
      );
      if (runError) throw new Error(runError);
      return { text: run.text, finished: run.finished };
    },
    log,
  });

  // --- RSI sidecar (Faza 1) ---
  // The bridge writes `rsi_request` lines via transport.send; the
  // `onMessage` switch routes `rsi_response` lines back to
  // `bridge.onResponse`. The sidecar builds the production engine
  // (real adapters, real taste miner, real escape tracker) and emits
  // `rsi_engine_event` outbound events that mirror into Rust's
  // `RsiEngineState` AND ack in-flight `rsi_start`/`rsi_stop`/
  // `rsi_set_concurrency` requests via the `RsiRequestRegistry`.
  const rsiBridge = new RsiBridge({
    send: (msg) => transport.send(msg as unknown as import("./types.ts").OutboundEvent),
  });
  // Fractal Memory Search (Phase 0): point the embed module at the live bridge
  // so embed(...) routes text → Rust `embed_text` → vectors. Until a model is
  // present Rust returns an error and callers fall back to FTS5; this just
  // makes the path available.
  setEmbedInvoker(rsiBridgeEmbed(rsiBridge));

  // --- Migration (Pathway 3 step 2 Task 4) ---
  // One-shot lift of the ~41 pre-step1 facts from SemanticMemory into the new
  // reactive tree. Idempotent via marker file; failure-tolerant (missing model
  // is non-fatal — the FTS5 fallback keeps the old facts reachable via
  // auto-inject). Best-effort, fire-and-forget.
  //
  // MUST stay below `setEmbedInvoker` — it embeds, and running it before the
  // invoker existed is what made it fail on every boot for good.
  void runMigration({
    semantic,
    fractal: fractalMemory,
    embed,
    dataDir,
  }).then((result) => {
    if (result.ran) {
      log(`migration: lifted ${result.facts} fact(s) into the reactive tree`);
    } else if (result.error) {
      log(`migration: skipped (${result.error}) — will retry next boot`);
    } else {
      log("migration: marker present, no-op");
    }
  }).catch((e) => {
    log(`migration: unexpected error: ${String(e)}`);
  });
  // RAPTOR tree build, in the background now that embed() can reach Rust.
  // `rebuildIfStale` is a no-op when init() already loaded a fresh tree from
  // disk, so we don't re-pay the (cloud) summary cost on every boot — it only
  // builds on first run or after the corpus grows materially.
  void fractalMemory
    .rebuildIfStale()
    .catch((e) => log(`fractal: initial rebuild error: ${String(e)}`));
  // Dev-only benchmark gate (CINDERPAW_RUN_FRACTAL_BENCH=1). Runs INSIDE the live
  // sidecar because embeddings only work here (the embed bridge needs Rust).
  // Builds the tree if needed, scores flat FTS5 vs the fractal hybrid on a
  // generated (or supplied) query set, writes a JSON report next to the tree,
  // and logs the ship/no-ship verdict. Never affects normal startup.
  if (readEnv("CINDERPAW_RUN_FRACTAL_BENCH")) {
    void (async () => {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        await fractalMemory.rebuildIfStale();
        if (!fractalMemory.hasTree) {
          log("fractal-bench: no tree (no embedding model on disk?) — skipping");
          return;
        }
        const queriesPath = readEnv("CINDERPAW_FRACTAL_BENCH_QUERIES");
        const report = await fractalMemory.benchmark({
          infer: routerInfer(router),
          querySetJsonl: queriesPath ? fs.readFileSync(queriesPath, "utf8") : undefined,
          count: Number(readEnv("CINDERPAW_FRACTAL_BENCH_COUNT")) || 50,
          seed: Number(readEnv("CINDERPAW_FRACTAL_BENCH_SEED")) || 1,
        });
        const outPath = require("node:path").join(dataDir, "fractal-bench-report.json");
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        const v = report.verdict;
        log(
          `fractal-bench: n=${report.n} k=${report.k} | ` +
            `recall@${report.k} fractal=${report.fractal.meanRecallAtK.toFixed(3)} ` +
            `fts=${report.fts.meanRecallAtK.toFixed(3)} | ` +
            `p99 fractal=${report.fractal.p99Ms.toFixed(1)}ms fts=${report.fts.p99Ms.toFixed(1)}ms | ` +
            `verdict=${v.ship ? "SHIP" : "HOLD"}${v.reasons.length ? " — " + v.reasons.join("; ") : ""} | ` +
            `report=${outPath}`,
        );
      } catch (e) {
        log(`fractal-bench: failed: ${String(e)}`);
      }
    })();
  }
  // Dream Cycle: event-driven scheduler replaces the old continuous
  // PassiveSupervisor loop. Config + activity monitor are built here so
  // the sidecar's onIdle can both feed telemetry and drive the scheduler's
  // sleep/cooldown. Late-bind `dream` through this holder (the scheduler
  // needs the sidecar to start it — break the cycle the same way passive did).
  const dreamCfg = resolveDreamConfig(process.env);
  const activityMonitor = new ActivityMonitor({ errorWindowMs: dreamCfg.errorWindowMs });
  const dreamTelemetryPath =
    readEnv("CINDERPAW_RSI_TELEMETRY") ??
    join(CINDERPAW_HOME, "rsi", "dream.jsonl");
  // Carries the in-flight episode's start time + trigger from the
  // scheduler's `start` callback to the run-end telemetry append.
  // Dream Cycle glue (telemetry + started/ended events + cooldown threading)
  // lives in createDreamCycle so the full idle→episode→telemetry→ended path is
  // exercised end-to-end in a test (audit D2), not just inline here.
  // One source of truth for the episode's bounded run config — reused for
  // the budget caps the journal reports against and for arming the engine.
  const episodeOpts = episodeStartOptions(process.env);
  // L5 Governance (spec 2026-07-04): first boot activates the genesis
  // policy (codifies the pre-L5 hardcoded defaults); every layer reads
  // the ACTIVE policy from disk through this accessor — rollbacks apply
  // at the next decision point, no restart (§6).
  ensureGenesisPolicy();
  const governancePolicy = () => loadPolicy().policy;
  {
    // §8: policy budgets are OUTER walls over the env-derived episode
    // config. Read once at startup like the env itself (episode knobs
    // are boot-scoped); maxIterations is clamped live in its getter.
    const b = governancePolicy().budgets;
    episodeOpts.maxTotalTokens = Math.min(episodeOpts.maxTotalTokens, b.episodeMaxTokens);
    episodeOpts.maxTotalCostUsd = Math.min(episodeOpts.maxTotalCostUsd, b.episodeMaxCostUsd);
    episodeOpts.maxWallClockMs = Math.min(episodeOpts.maxWallClockMs, b.episodeMaxWallClockMs);
    episodeOpts.maxIterations = Math.min(episodeOpts.maxIterations, b.episodeMaxIterations);
  }
  // L6 Meta Evolution — the MetaGenome that steers HOW the RSI searches
  // (docs/2026-07-04 spec). `dream_batch` drives the episode iteration
  // budget live (the getter re-reads the genome at each episode start)
  // unless the operator pinned it via CINDERPAW_RSI_MAX_ITER.
  const metaEvolution = new MetaEvolution({ log, policy: governancePolicy });
  if (readEnv("CINDERPAW_RSI_MAX_ITER") === undefined) {
    Object.defineProperty(episodeOpts, "maxIterations", {
      get: () =>
        Math.min(metaEvolution.current().dream_batch, governancePolicy().budgets.episodeMaxIterations),
      enumerable: true,
    });
  }
  const dreamCycle = createDreamCycle({
    send: (e) => transport.send(e),
    telemetryPath: dreamTelemetryPath,
    // BRSI §2.9 Evolution Journal: per-day rotating file under the
    // per-instance ~/.cinderpaw/rsi/journal dir. Resolved per write so a
    // process spanning UTC midnight rolls to the next day's file.
    journalPath: () => defaultJournalPath(),
    // BRSI §2.5: report honest remaining budget against the same limits
    // GoalConfig enforces for the episode.
    budgetCaps: episodeBudgetCaps(episodeOpts),
    activityMonitor,
    config: dreamCfg,
    // No model, no dream. The host answers from the truth it alone holds: a
    // GGUF resident in the engine, or a cloud active_route. Fail CLOSED — an
    // unanswered probe must not wake an episode, because the episode is exactly
    // what makes the local API lazily load a 5 GB model the user never picked.
    hasModel: async () => {
      try {
        const r = await rsiBridge.request<{ ready?: boolean }>("rsi_model_ready", {});
        return r?.ready === true;
      } catch (err) {
        log(`dream: model-ready probe failed (${String(err)}) — treating as no model`);
        return false;
      }
    },
    log,
  });
  // Faza 2 code-RSI round, piggybacked on the Dream Cycle: after each
  // dream episode ends, propose ONE patch over the agent's own rsi/
  // sources and run it through the full contract (walls → worktree →
  // Rust score → substrate ratchet → approval queue). Dev-mode: requires
  // CINDERPAW_CODE_RSI_REPO (the source monorepo) and a LOCAL primary model
  // (spec §2.5: no network during proposal). At most one round in flight.
  let codeRsiBusy = false;
  const maybeCodeRsiRound = async (): Promise<void> => {
    const repoRoot = cfgPath("CINDERPAW_CODE_RSI_REPO");
    if (!repoRoot || codeRsiBusy) return;
    if (!router.isPrimaryLocal) {
      log("code-rsi: skipped — proposal requires a LOCAL primary model (spec §2.5)");
      return;
    }
    codeRsiBusy = true;
    try {
      const { proposeCodePatch } = await import("./rsi/l3-code/code-proposer.ts");
      const { makeCodeStageAdapters, runCodeCandidate } = await import("./rsi/l3-code/code-rsi.ts");
      const { bunExec } = await import("./rsi/l3-code/code-sandbox.ts");
      const { readdir, readFile } = await import("node:fs/promises");
      const rsiDir = require("node:path").join(repoRoot, "CinderpawAgent", "src", "rsi");

      const genome = await proposeCodePatch({
        completeLocal: async ({ system, user, maxTokens }) => {
          const res = await router.complete({
            sessionId: "code-rsi-proposer",
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            maxTokens,
            temperature: 0.4,
            cachePrompt: false,
            skipBudgetCheck: false,
          });
          return res.content;
        },
        // R2: rsi/ is now layered into subdirs (l1-config/, l3-code/, …), so
        // this must recurse and return rsi/-relative paths (e.g.
        // "l1-config/mutation.ts") — readRsiFile/proposeCodePatch already
        // treat the listRsiFiles entries as opaque relative paths, not bare
        // basenames, so no other call site changes.
        listRsiFiles: async () =>
          (await readdir(rsiDir, { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\\/g, "/")),
        readRsiFile: (relPath) => readFile(require("node:path").join(rsiDir, relPath), "utf8"),
        baseCommit: async () =>
          (await bunExec(["git", "rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs: 30_000 }))
            .stdout.trim(),
      });
      if (!genome) {
        log("code-rsi: proposer declined (SKIP / nothing diff-shaped) — no candidate this round");
        return;
      }

      const { store, sendCodePatches } = await codePatchGate();
      const genomeId = crypto.randomUUID();
      log(`code-rsi: candidate ${genomeId.slice(0, 8)} targets ${genome.affectedFiles.join(", ")}`);
      const result = await runCodeCandidate({
        genomeId,
        genome,
        deps: makeCodeStageAdapters({ bridge: rsiBridge, repoRoot }),
        cycleId: `c-code-${new Date().toISOString()}`,
        pendingStore: store,
      });
      log(
        `code-rsi: ${result.decided?.action ?? "?"} (${result.decided?.reason ?? "no reason"})` +
          (result.advanced ? ` — PROMOTED score=${result.score?.toFixed(1)}, queued for approval` : ""),
      );
      if (result.advanced) sendCodePatches();
    } catch (e) {
      log(`code-rsi: round failed: ${String(e)}`);
    } finally {
      codeRsiBusy = false;
    }
  };

  const rsiSidecar = new RsiSidecar({
    router,
    db: db.raw,
    bridge: rsiBridge,
    // The SHARED prompt-style pool (champion bridge): eval grades genomes
    // under the same styles the live agent applies on promotion. Styles are
    // ADDENDA in both surfaces — base instruction + style — so id 0 (neutral)
    // is byte-identical to the historical default prompt.
    systemPrompts: Object.fromEntries(
      PROMPT_STYLE_POOL.map((text, id) => [id, text ? `${DEFAULT_SYSTEM_PROMPT} ${text}` : DEFAULT_SYSTEM_PROMPT]),
    ),
    send: (e) => transport.send(e as unknown as import("./types.ts").OutboundEvent),
    log,
    // L6: the live MetaGenome scales the PBT selection knobs and
    // (tighten-only) the confidence gate.
    metaParams: () => metaEvolution.current(),
    // L5: policy gates tighten the promotion gate further (§7).
    policyGates: () => effectiveGates(governancePolicy()),
    onIdle: (...args: Parameters<typeof dreamCycle.onEpisodeEnd>) => {
      dreamCycle.onEpisodeEnd(...args);
      void maybeCodeRsiRound();
    },
    // The Crux: a new ratcheted-best config is applied to the LIVE agent
    // (temperature today; the UI Controls override still wins per-session).
    onChampion: (record) => {
      const params = mapGenomeToAgentConfig(record.config);
      agent.applyChampionParams(params);
      log(`rsi champion: applied genome ${record.genomeId} (score=${record.score.toFixed(1)}) → agent ${JSON.stringify(params)}`);
    },
  });
  // Boot with the last persisted champion so the agent doesn't start
  // cold on every relaunch (resume the learned tuning immediately).
  {
    const champ = readChampion(defaultChampionPath());
    if (champ) {
      agent.applyChampionParams(mapGenomeToAgentConfig(champ.config));
      log(`rsi champion: loaded persisted champion ${champ.genomeId} (score=${champ.score.toFixed(1)})`);
    }
  }
  // Dream Cycle: the evolutionary engine runs ONE bounded episode per
  // trigger (idle / error), then sleeps until the next trigger. The
  // engine math is untouched — only the *when* changed. The standing
  // goal + bounded budgets come from episodeStartOptions; the trigger
  // signals from the activity monitor.
  const dream = dreamCycle.arm(rsiSidecar, episodeOpts);

  // Connector Surface (inbound): Discord/Telegram/… share this one agent.
  // The host writes ~/.cinderpaw/connectors.json and pokes us with
  // `connectors_reload`; reconcile here. Started in onReady once the agent and
  // tools are fully wired.
  /**
   * The host half of a connector's durable run: everything that knows about
   * SQLite, git and token counters lives here, and the connector only learns
   * "begin, record, done".
   *
   * A safety point is taken per run, not per message, and only when a workspace
   * root is configured — so "what did it change while I was out" is answerable
   * for a walk-away task, which is the whole promise.
   *
   * ponytail: that is one git snapshot per answered message, including "what's
   * the weather". Cheap next to an LLM turn, but if it ever shows up in the
   * latency of a chat reply, the fix is to snapshot lazily on the first write
   * tool rather than to drop the snapshot.
   */
  const runHooks = {
    async begin(
      sessionId: string,
      mission: string,
      surface: RunSurface,
      target: string,
      doneWhen: DoneWhen | null,
    ) {
      const safety = await createSafetyPoints(
        `${surface}/${target}`,
        log,
        config.workspaceRoots,
      );
      const safetyCols = safetyColumns(safety);
      const row = runStore.startRun({
        sessionId,
        mission,
        // The configured mission deadline, made ABSOLUTE here rather than left
        // for runUnattended to derive per invocation.
        //
        // It used to be null, on the reasoning that runUnattended falls back to
        // the same config anyway. True for this process — but a run that dies
        // and is picked up by `resumeInterruptedRuns` derives it again from the
        // moment of the RESUME, so each restart handed the run another full
        // term. The check that is supposed to stop a run for being out of time
        // reads this column, and a null cannot be out of time.
        deadlineAt: (() => {
          const ms = cfgInt("CINDERPAW_MISSION_DEADLINE_MS");
          return ms > 0 ? Date.now() + ms : null;
        })(),
        continuationBudget: maxContinuations(),
        safetyRoot: safetyCols.root,
        safetyBefore: safetyCols.before,
        safetyGitDir: safetyCols.gitDir,
        // Declared with `done_when:` on the message itself. Absent, the run is
        // honestly recorded as unverified rather than quietly as passing.
        doneWhen,
        delivery: { kind: surface, target, sessionId },
      });
      if (!row) {
        log(`${surface}: ${sessionId} already has a run in flight — not starting a second`);
        return null;
      }
      // Carried from `done` to `conclude`: the verdict is known before the full
      // reply is composed, but the row must not be concluded until the text it
      // owes exists. See `concludeRun` for why those cannot be the same moment.
      let verdictStatus: RunStatus = "unfinished";
      let verdictReason: RunStopReason = "not_continuable";
      return {
        recorder: turnRecorder(row, safety, doneWhen),
        stalled: () =>
          row.safetyBefore !== null && madeNoProgress(runStore.turnsOf(row.id), STALL_TURNS),
        verify: () => verifyIfAsserted(doneWhen, safety),
        done: async (run: UnattendedResult): Promise<string | null> => {
          // The assertion is the authority, not the agent's closing paragraph.
          // A run that claimed success and cannot show it is recorded
          // `unfinished`, and the person is told in the same message — a
          // verdict only the database knows about is the silence this exists
          // to end.
          const check = await verifyDoneWhen(doneWhen, safety[0]?.root ?? null);
          verdictStatus = run.finished && check.passed ? "finished" : "unfinished";
          verdictReason = run.stoppedBecause;
          clearIntents(sessionId);
          if (!check.checked) return null;
          return check.passed
            ? `✅ _Checked: ${check.detail}_`
            : `❌ **The check you declared did not pass.** ${check.detail}\n` +
              "_Treat the answer above as unverified._";
        },
        // The row leaves `running` HERE, holding the exact text the connector is
        // about to send. Until the connector reports back, this run counts as
        // owed, and a boot that finds it will send it.
        conclude: (reply: string) => {
          runStore.finish(row.id, verdictStatus, verdictReason, reply);
        },
        // The connector says this once the message is actually out. Until then
        // the run is owed, and a boot will re-send it.
        delivered: () => {
          runStore.markDelivered(row.id);
        },
      };
    },
  };

  const connectors = new ConnectorManager(agent, log, leadDesk, runHooks);
  // ask_user for connector sessions is asked IN the channel (Discord/Slack/
  // WhatsApp text message; the next reply answers it) instead of emitting a
  // desktop card the chat user can never see.
  askUser.setDelegate(connectors.askRouter);

  // connectors_manage — the agent's self-service door for connecting itself
  // to Discord/Slack/WhatsApp on user request. Writes ~/.cinderpaw/connectors.json
  // (the one deliberate exception to the deny wall) and hot-reloads the manager.
  registry.register(createConnectorsManageTool(connectors));

  // F6 — self.* runtime introspection tools (the agent's mental model of
  // its own substrate). Registered after `connectors` so the connector
  // handle is in scope for `self_connectors` / `self_health`, and after
  // `router` / `registry` are built (both are constructed earlier in this
  // file). No filesystem permissions — these tools read internal state
  // files directly, and the audit log records every call.
  const brainStackEnabled = brain !== undefined && brain !== null;
  for (const t of createSelfTools({
    router,
    registry,
    connectors,
    brainStackEnabled,
    version: VERSION,
    bootedAt: BOOT_EPOCH_MS,
  })) {
    registry.register(t);
  }

  // Host-owned tools, LAST so they displace rather than collide.
  //
  // `registry.register` throws on a duplicate name, so registering these before
  // the built-ins would turn any overlap into a dead sidecar at boot — and the
  // overlap is not hypothetical: tau2's airline domain ships a `calculate`, and
  // the names a host uses are usually fixed by its own policy document rather
  // than chosen to avoid ours. The host is the authority on the tools it says
  // it owns, so it wins, and every displacement is named on screen — a tool
  // that quietly stopped being the tool it used to be is the kind of thing
  // nobody discovers until it has already produced a wrong answer.
  const hostToolsPath = cfgPath("CINDERPAW_HOST_TOOLS");
  if (hostToolsPath) {
    // Deliberately not caught: an unreadable or malformed declaration leaves
    // the agent unable to do the only job it was started for, and that failure
    // is indistinguishable from a bad model unless it is said out loud here.
    const tools = loadHostTools(hostToolsPath, hostTools);
    const displaced: string[] = [];
    for (const t of tools) {
      if (registry.unregister(t.manifest.name)) displaced.push(t.manifest.name);
      registry.register(t);
    }
    // Flip the tiering default: the host's tools are the job, Cinderpaw's own
    // go behind the drawer. Capability is untouched — `list_tools`/`load_tool`
    // still reach every one of them — but they stop being re-sent on every
    // completion. See setHostToolNames for the measurement that motivated it.
    setHostToolNames(tools.map((t) => t.manifest.name));
    log(`host tools: ${tools.length} from ${hostToolsPath} — ${tools.map((t) => t.manifest.name).join(", ")}`);
    log(`host tools: built-ins demoted to the on-demand drawer for this run (list_tools/load_tool still reach them)`);
    if (displaced.length > 0) {
      log(`host tools: replaced built-in ${displaced.join(", ")} — the host's implementation is now the one that runs`);
    }
  }

  // Faza 2 Slice 5: the code-patch approval gate, created lazily on first
  // IPC touch (installs that never use code-RSI pay nothing). One store per
  // process, persisted next to the journal.
  let codePatchGatePromise: Promise<{
    store: import("./rsi/l3-code/pending-patches.ts").PendingPatchStore;
    sendCodePatches: () => void;
  }> | null = null;
  const codePatchGate = () => {
    codePatchGatePromise ??= (async () => {
      const { PendingPatchStore, defaultPendingPatchesPath } = await import(
        "./rsi/l3-code/pending-patches.ts"
      );
      const store = new PendingPatchStore(defaultPendingPatchesPath());
      const sendCodePatches = (): void => {
        transport.send({
          type: "code_patches",
          patches: store.list().map((p) => ({
            id: p.id,
            status: p.status,
            score: p.score,
            rationale: p.genome.proposal.rationale,
            affectedFiles: p.genome.affectedFiles,
            patch: p.genome.patch,
            commitHash: p.commitHash,
            createdAt: p.createdAt,
            ...(p.note ? { note: p.note } : {}),
          })),
          manualWindowOpen: store.requiresManualApproval(),
          appliedCount: store.appliedCount(),
        });
      };
      return { store, sendCodePatches };
    })();
    return codePatchGatePromise;
  };

  // Slice A5 (L5 Governance) — the policy FSM. Lazy singleton, sync init
  // (GovernanceLifecycle has no async deps; only the journal dir resolution
  // touches the filesystem and that's deferred to the first read). Same
  // discipline as `codePatchGate` above: installs that never touch
  // governance (the majority of them) pay nothing.
  let glInstance: GovernanceLifecycle | null = null;
  const governanceGate = () => {
    glInstance ??= new GovernanceLifecycle({ log });
    return glInstance;
  };

  // Phase B (L4 Architecture Evolution) — the module lifecycle. Lazy
  // singleton over the SAME registry the live seam adapters read
  // (`liveModuleRegistry`), so an approve here is visible to the recall
  // tool's next request without a restart (§6). One eval at a time —
  // the paired suite fights for the model exactly like LoRA training.
  let mlInstance: import("./rsi/l4-modules/module-lifecycle.ts").ModuleLifecycle | null = null;
  let moduleEvalBusy = false;
  const modulesGate = async () => {
    if (!mlInstance) {
      const { ModuleLifecycle } = await import("./rsi/l4-modules/module-lifecycle.ts");
      mlInstance = new ModuleLifecycle({
        registry: liveModuleRegistry(),
        runtimeVersion: VERSION,
        log,
      });
    }
    return mlInstance;
  };
  // Watchdog auto-quarantine (§8.2) → desktop toast, unpaired event.
  onModuleQuarantine((moduleId, reason) => {
    transport.send({
      type: "modules_result",
      id: "",
      op: "quarantined",
      ok: true,
      moduleId,
      reason,
    });
  });

  // Faza 4 (L2 LoRA) — the personal-adaptation gate, same lazy-on-first-touch
  // discipline as the code-patch gate. Registry + review inbox persist next
  // to the journal; `sendLoraReviews` is the one shape the UI card renders.
  let loraGatePromise: Promise<{
    registry: import("./rsi/l2-adapt/lora-registry.ts").LoraRegistry;
    reviews: import("./rsi/l2-adapt/lora-pipeline.ts").LoraReviewStore;
    sendLoraReviews: () => void;
  }> | null = null;
  const loraGate = () => {
    loraGatePromise ??= (async () => {
      const { LoraRegistry } = await import("./rsi/l2-adapt/lora-registry.ts");
      const { LoraReviewStore, loraStats } = await import("./rsi/l2-adapt/lora-pipeline.ts");
      const registry = new LoraRegistry();
      const reviews = new LoraReviewStore();
      const sendLoraReviews = (): void => {
        transport.send({
          type: "lora_reviews",
          reviews: reviews.list().map((c) => {
            const rec = registry.get(c.adapterId);
            return {
              id: c.adapterId,
              domain: c.domain,
              status: c.status,
              verdict: c.gate.verdict,
              reason: c.gate.reason,
              metrics: c.metrics,
              adapterPath: rec?.adapterPath ?? "",
              baseModel: rec?.baseModel ?? "",
              createdAt: c.createdAt,
            };
          }),
          champions: registry
            .list()
            .filter((a) => a.status === "champion")
            .map((a) => ({ domain: a.domain, id: a.id, adapterPath: a.adapterPath })),
          stats: loraStats(registry.list(), reviews.list()),
        });
      };
      return { registry, reviews, sendLoraReviews };
    })();
    return loraGatePromise;
  };
  // One training cycle at a time — training is the heaviest thing this
  // process can trigger, and a second concurrent cycle would fight the
  // first for the model (the eval runner reloads it).
  let loraTrainBusy = false;


  // R7: everything `dispatchMessage` (dispatch.ts) needs from the boot
  // sequence, threaded explicitly instead of via closure. `moduleEvalBusy` /
  // `loraTrainBusy` are plain `let` flags that the switch (now in
  // dispatch.ts) reads AND reassigns across separate calls, so they live on
  // this shared, mutable `ctx` object rather than being destructured by
  // value on the other side.
  const ctx = {
    config, db, user, audit, router, localFallbackTarget, episodic, dataDir, fractalMemory, extractor, askUser, hostTools, desktopControl, capabilityBridge, adminBridge, registry, mcpManager, mood, innerThoughts, agent, cronRepo, transport, rsiBridge, activityMonitor, metaEvolution, rsiSidecar, dream, connectors, codePatchGate, governanceGate, modulesGate, loraGate,
    // Agent Cowork S4 — the chat-side approval resolver (dispatch routes
    // `cowork_approval_resolve` here).
    coworkApprovals: coworkApprovalService,
    // S6 — the panel talks to teammates DIRECTLY (`cowork_user_message`).
    // Routing a message the person already typed through the main agent costs
    // a whole model turn to retype it, and lets it be paraphrased on the way.
    coworkMailbox,
    coworkAgents,
    // Not connector-only, despite where they are built: an autonomous turn over
    // the sidecar transport is the same kind of unattended work and needs the
    // same guards. Passed through so `dispatch` stops being the one live path
    // running without a stall guard or a completion check.
    runHooks,
    moduleEvalBusy, loraTrainBusy,
    // set_model needs both to keep a derived brain pointed where the router is.
    brainDerived, brainBreaker,
  };
  transport.onMessage((msg) => {
    void dispatchMessage(ctx, msg).catch((e) => log(`dispatch: unhandled error: ${String(e)}`));
  });


  transport.onReady(() => {
    // R1: the very first line of protocol traffic — before any other stdout
    // write — so the host can pin the sidecar's wire version. Skipped when
    // `transportOverride` is set (TUI mode fans events out in-process, not
    // over real stdout, so a raw JSON line here would just pollute the
    // terminal). `transport.onReady` fires on the next microtask after
    // `start()`, which is the earliest point the transport itself considers
    // safe to receive/emit — writing any earlier risks racing its own setup.
    if (!transportOverride) {
      // The persona rides along because a voice call has no other way to get
      // it. In a speech-to-speech call the conversational brain is Gemini, not
      // this agent loop, so SOUL.md — which every text turn is built on — never
      // reached the caller at all: the call was briefed with identity, tool
      // rules and a list of formatting prohibitions, and nothing about who it
      // is. It answered like a polite appliance, correctly, exactly as briefed.
      //
      // Sent on `hello` rather than fetched on demand: the host already reads
      // this line, it is the one message guaranteed to arrive before any call
      // can start, and a request/response round trip for a value that changes
      // only on hot-reload would be more moving parts for the same string.
      console.log(JSON.stringify({
        type: "hello",
        protocol: SIDECAR_PROTOCOL,
        // `persona`, not `content`: WHO without the working manual. See SoulDoc.
        persona: soul.persona,
      }));
    }
    // Say which of the two states this is. A fresh install has no model, and
    // announcing "ready, model=qwen2.5:7b" for one is how a first run becomes a
    // dead end: the app looks up, names a model, and refuses the first message
    // with "no model loaded". The user is not told what to do because nothing
    // ever admitted there was a problem.
    const noModel = isPlaceholderModel(readEnv("CINDERPAW_MODEL"));
    log(
      `ready — transport=${config.transport} ` +
        (noModel
          ? "NO MODEL CONFIGURED — chat will fail until one is chosen " +
            "(Models page, or set a cloud key in Settings) "
          : `model=${config.inference.primary.model} `) +
        `workspace=${config.workspaceRoots.join(", ")}`,
    );
    // X1 fix: inner-thoughts is opt-in via CINDERPAW_PROACTIVE_ENABLED.
    if (innerThoughts) {
      innerThoughts.setEmit((event) => transport.send(event));
      innerThoughts.start();
    }
    // P2-#1: heartbeat always on — even when the proactive loop is off.
    // The transport's onMessage handler should treat absence of
    // heartbeats for ≥3 intervals as a hang signal.
    heartbeat.setEmit((event) => transport.send(event));
    heartbeat.start();
    // P0-3: cron scheduler. Same pattern as inner-thoughts — start
    // after the transport is up so a job that fires immediately can
    // deliver through the transport.
    cronScheduler.start();
    log(`cron scheduler enabled (${cronRepo.list().length} job(s) loaded)`);

    // Agent Cowork (S3.5): start the reactive worker loop after the
    // transport is up, same pattern as cron. Silent when no agents exist.
    coworkRuntime.start();
    const coworkCount = new CoworkAgentRepo(db.raw).list().length;
    if (coworkCount > 0) {
      log(`cowork runtime enabled (${coworkCount} agent(s) active)`);
    }

    // The one line the host waits for.
    //
    // Until now there was no ready protocol at all: the host matched the
    // substring "ready" against every stderr line the sidecar ever printed.
    // `dream: model-ready probe failed` contains it. So does `already has a
    // run in flight`. So does the word "not ready". Any of them flipped the
    // app to "the agent is up" whether it was or not — and if no such line
    // happened to be printed, the startup banner never went away at all.
    //
    // An exact marker, printed once, at the point where the transport is up
    // and the tools are live. Match it exactly on the other side.
    //
    // Deliberately not shaped like an environment variable: the env-var
    // documentation check scans the source for that shape and would demand
    // this be documented as a setting, which it is not.
    log(READY_MARKER);
    // Start any enabled inbound connectors (Discord, …) now that the agent and
    // its tools are live. Best-effort: failures log to stderr, never crash.
    //
    // The interrupted-run pass is chained onto it rather than run alongside:
    // a run resumed here reports back over the same connector it came in on, and
    // that connector's sender is only registered once the client has logged in.
    // Chaining on the reload promise waits for the real signal instead of
    // guessing with a timer.
    void connectors.reload().then(() => resumeInterrupted());

    // Dream Cycle: arm the event-driven scheduler ONLY when the user opted
    // in (CINDERPAW_DREAMS_ENABLED=true, the master switch from Settings)
    // AND a real model is configured. Off when CINDERPAW_RSI_PASSIVE=false or
    // only a placeholder model is present (avoids spinning on empty
    // responses). On a cloud (non-loopback) endpoint, dreaming is
    // additionally refused unless CINDERPAW_RSI_ALLOW_CLOUD is explicitly set
    // (anti-burn). `start()` only arms the trigger poll — it does NOT
    // launch an episode immediately.
    //
    // The master switch is new and DEFAULTS OFF: dreaming used to arm on
    // every machine with a model configured, which is a background engine
    // most people did not know existed, running unasked. Opt-in, local or
    // cloud alike.
    if (readEnv("CINDERPAW_DREAMS_ENABLED") !== "true") {
      log("rsi dream: not arming scheduler (dreaming is opt-in — enable it in Settings → Agent → Cinderpaw's Dreams)");
    } else {
    const decision = shouldAutostartPassive(process.env);
    if (!decision.enabled) {
      log(`rsi dream: not arming scheduler (${decision.reason})`);
    } else {
      const baseUrl = cfgPath("CINDERPAW_BASE_URL") ?? "";
      let isLoopback = baseUrl === "";
      try {
        const h = new URL(baseUrl).hostname;
        isLoopback = h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
      } catch {
        // Unparseable/empty baseUrl → keep the `baseUrl === ""` default
        // (empty means the in-process loopback default).
      }
      const gate = dreamCloudGate(process.env, { isLoopback });
      if (!gate.enabled) {
        log(`rsi dream: not arming scheduler (${gate.reason})`);
      } else {
        log(`rsi dream: arming event-driven scheduler (${decision.reason}; ${gate.reason})`);
        dream?.start();
      }
    }
    }
  });

  // Persist final audit state on unexpected termination.
  const shutdown = async () => {
    // Break the Dream Cycle trigger loop so we don't launch an episode
    // into a closing process.
    dream?.shutdown();
    // X1 fix: only stop the inner-thoughts loop if it was actually
    // started (i.e. the proactive subsystem is on).
    innerThoughts?.stop();
    heartbeat.stop();
    // Awaited: a cron job in flight must finish (or be given 5s to) before the
    // database closes underneath it.
    await cronScheduler.stop();
    void connectors.stopAll();
    graphCleaner.stop();
    try {
      stopSoulWatcher();
    } catch {
      // watcher may already be closed; safe to ignore
    }
    try {
      askUser.cancelAll("shutdown");
      hostTools.cancelAll("shutdown");
    } catch {
      // ignore — bridge may already be empty
    }
    try {
      desktopControl.cancelAll("shutdown");
      capabilityBridge.cancelAll("shutdown");
      adminBridge.cancelAll("shutdown");
    } catch {
      // ignore — bridge may already be empty
    }
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  transport.start();

  return ctx;
}

/** Everything dispatchMessage() needs from the boot sequence — see ctx above. */
export type BootContext = Awaited<ReturnType<typeof boot>>;

