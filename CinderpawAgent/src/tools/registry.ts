/**
 * Tool registry — the gate every tool call passes through.
 *
 * Registration validates the manifest (rejecting inconsistent ones) so the
 * registry only ever holds safe tools. Invocation is the single choke point
 * where the sandbox is applied:
 *   - unknown tool name  → blocked + audited, structured error returned
 *   - known tool         → given a ToolContext carrying a fetch bound to *its*
 *                          permissions and the audit logger, then executed
 * The agent can only reach tools through this registry, so a tool can never be
 * invoked outside the sandbox and can never exercise an undeclared permission.
 *
 * Retry policy (P0-#5): tools that declare `manifest.retry` get up to
 * `attempts` retries with linear backoff (250ms × attempt) when the failure
 * matches a category in `on`. Tools without a `retry` manifest behave
 * exactly as before — a single attempt, no retry.
 *
 *   - "http"    → retry when the tool returned { ok: false, error: "http_error" | "network_error" }
 *   - "process" → retry when the tool.execute() call threw
 *   - "any"     → retry on any failure (http OR process)
 *
 * Each attempt (including the failed ones) is audited and observed. The
 * audit/observation rows let an operator reconstruct *why* a tool eventually
 * failed, not just the final outcome. Backoff sleeps are linear (250, 500,
 * 750, … ms) — exponential would be appropriate for cloud APIs but the
 * transport here is mostly local loopback where shorter backoffs recover
 * faster and the added wall-clock per attempt is trivial.
 */

import type { EgressProxy } from "../egress/egress-proxy.ts";
import type { AuditLog } from "../egress/audit-log.ts";
import { validateManifest } from "../egress/tool-permissions.ts";
import { readEnv } from "../config.ts";
import type {
  AskUserBridge,
  DesktopControlBridge,
  CapabilityBridge,
  AdminBridge,
  ProcessSandbox,
  Tool,
  ToolCallOptions,
  ToolContext,
  ToolParameter,
  ToolResult,
  ToolRetryCategory,
  ToolRetryPolicy,
  ToolProgressEvent,
} from "../types.ts";
import type { ToolObservationLog } from "../telemetry/tool-observations.ts";
import { CircuitBreaker } from "../egress/circuit-breaker.ts";

/**
 * Is process execution switched off?
 *
 * Read per call rather than cached at import: tests flip it, and a value frozen
 * at module load makes a security switch depend on import order.
 */
function spawnDisabled(): boolean {
  return readEnv("CINDERPAW_ENABLE_SHELL_EXEC") === "false";
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #egress: EgressProxy;
  readonly #audit: AuditLog;
  readonly #process: ProcessSandbox;
  readonly #observations: ToolObservationLog | null;
  readonly #askUser: AskUserBridge | null;
  readonly #desktopControl: DesktopControlBridge | null;
  readonly #capabilities: CapabilityBridge | null;
  readonly #admin: AdminBridge | null;
  /**
   * Per-tool circuit breaker (P2-#2). Tracks consecutive failures and
   * short-circuits calls to tools that are clearly sick. Saves LLM
   * round-trips on flaky downstream APIs / runaway subprocesses.
   * Read-only inspection via `breakerStateOf(tool)` for debugging.
   */
  readonly #breaker: CircuitBreaker;
  /**
   * Optional hook registry (P0-4). `before_tool_call` handlers can
   * block a call; `after_tool_call` handlers are informational.
   * Default no-op so unit tests and the bare-minimum wiring don't
   * need to know about hooks.
   */
  readonly #hooks: import("../core/hook-registry.ts").HookRegistry | null;

  constructor(
    egress: EgressProxy,
    audit: AuditLog,
    process: ProcessSandbox,
    observations?: ToolObservationLog,
    askUser?: AskUserBridge,
    breaker?: CircuitBreaker,
    hooks?: import("../core/hook-registry.ts").HookRegistry,
    desktopControl?: DesktopControlBridge,
    capabilities?: CapabilityBridge,
    admin?: AdminBridge,
  ) {
    this.#egress = egress;
    this.#audit = audit;
    this.#process = process;
    this.#observations = observations ?? null;
    this.#askUser = askUser ?? null;
    this.#breaker = breaker ?? new CircuitBreaker();
    this.#hooks = hooks ?? null;
    this.#desktopControl = desktopControl ?? null;
    this.#capabilities = capabilities ?? null;
    this.#admin = admin ?? null;
  }


  /**
   * The single post-execution tail every `call()` return point goes through:
   * release the timer/listener, fire `after_tool_call`, then try the fallback
   * chain. Both the fast path and the retry path use it, so a tool's observable
   * behavior no longer depends on whether it happens to declare `manifest.retry`.
   *
   * `allowFallback` is false for aborted/cancelled outcomes: the call was
   * interrupted, the tool did not return a failure, and starting a fallback tool
   * after the user pressed Stop would defeat the cancellation.
   */
  async #settle(
    name: string,
    tool: Tool,
    raw: ToolResult,
    args: Record<string, unknown>,
    sessionId: string,
    opts: ToolCallOptions,
    startedAt: number,
    ac: AbortController,
    timer: ReturnType<typeof setTimeout>,
    onCallerAbort: () => void,
    allowFallback: boolean,
  ): Promise<ToolResult> {
    const result = finalize(raw, ac, timer, opts.signal, onCallerAbort);
    if (this.#hooks) {
      try {
        await this.#hooks.fire("after_tool_call", {
          tool: name,
          args,
          result: { ok: result.ok, content: result.content, error: result.error },
          sessionId,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        process.stderr.write(`[tools] after_tool_call hook fire failed: ${String(err)}\n`);
      }
    }
    if (!allowFallback) return result;
    return await this.#tryFallbackChain(name, tool, result, args, sessionId, opts);
  }

  /**
   * Cinderpaw-WIP #2: try the fallback chain declared in `tool.manifest.fallback`.
   *
   * Returns a new ToolResult if a fallback succeeded, or null if the chain
   * either had no fallbacks, all fallbacks failed, or the primary result
   * was already a success. When all fallbacks fail, the original `result`
   * is returned with an "(fallbacks ... also failed)" suffix.
   *
   * Re-enters `this.call()` for each fallback so the same sandbox / retry
   * / circuit-breaker pipeline is applied.
   */
  async #tryFallbackChain(
    name: string,
    tool: Tool,
    result: ToolResult,
    args: Record<string, unknown>,
    sessionId: string,
    opts: ToolCallOptions,
  ): Promise<ToolResult> {
    if (result.ok) return result;
    const fallbacks = tool.manifest.fallback;
    if (!fallbacks || fallbacks.length === 0) return result;
    // The chain so far, including this tool. A fallback that leads back to
    // something already tried is a cycle, and a cycle here is a stack overflow
    // rather than a failed tool call.
    const chain: readonly string[] = [...(opts.fallbackChain ?? []), name];
    const MAX_FALLBACK_DEPTH = 4;
    if (chain.length > MAX_FALLBACK_DEPTH) {
      return {
        ...result,
        content: `${result.content} (fallback chain stopped after ${MAX_FALLBACK_DEPTH} hops: ${chain.join(" → ")})`,
      };
    }
    for (const fb of fallbacks) {
      const fbName = typeof fb === "string" ? fb : fb.name;
      const fbTool = this.#tools.get(fbName);
      if (!fbTool) continue;
      if (chain.includes(fbName)) continue; // already tried in this chain
      const fbArgs = typeof fb === "object" && fb.argMap ? fb.argMap(args) : args;
      // A fresh signal per fallback: reusing `opts` handed the fallback the
      // abort signal that had ALREADY fired for the primary, so the retry was
      // cancelled before it started and reported as if it had been tried.
      const { signal: _dead, ...rest } = opts;
      const fbResult = await this.call(fbName, fbArgs, sessionId, {
        ...rest,
        fallbackChain: chain,
      });
      if (fbResult.ok) {
        return {
          ok: true,
          content: fbResult.content,
          data: {
            ...(fbResult.data ?? {}),
            fallbackFrom: name,
            fallbackChain: [name, ...fallbacks.map((f) => (typeof f === "string" ? f : f.name))],
          },
        };
      }
    }
    return {
      ...result,
      content: result.content + " (fallbacks " + fallbacks.map((f) => (typeof f === "string" ? f : f.name)).join(",") + " also failed)",
    };
  }

  /**
   * Bumped on every registration/unregistration. The tool set is NOT static
   * for the process lifetime: MCP servers connect asynchronously and register
   * their tools seconds after boot, and unregister on teardown. Anything that
   * derives a cached view of the registry (schemas, grammar, system prompt)
   * must compare this against the version it built from, or it will advertise
   * a tool set that is missing every late arrival — which is exactly how MCP
   * tools became discoverable-but-uncallable.
   */
  #version = 0;

  /** @see #version */
  get version(): number {
    return this.#version;
  }

  /** Register a tool after validating its manifest. Throws on bad manifests. */
  readonly #withheld: string[] = [];

  register(tool: Tool): void {
    validateManifest(tool.manifest);
    if (this.#tools.has(tool.manifest.name)) {
      throw new Error(`tool "${tool.manifest.name}" already registered`);
    }
    // CINDERPAW_ENABLE_SHELL_EXEC=false means no process execution, and it has
    // to mean that here rather than at each registration site. It was written
    // as an `if` around two registrations in boot.ts, so the ten tools added
    // later outside it kept running programs with the switch off: the five
    // code-quality tools (whose own docstring says "same security model as
    // shell_exec") and the five git tools, under a comment that literally
    // reads "process-spawn tools for the workspace". Ten tools, one forgotten
    // `if`, and a promise in PROMISES.md that did not hold.
    //
    // The manifest already declares what a tool does. Gating on that instead of
    // on where somebody remembered to put a brace is the difference between a
    // switch that works and a switch that works until the next tool.
    if (spawnDisabled() && tool.manifest.permissions.includes("process:spawn")) {
      this.#withheld.push(tool.manifest.name);
      return;
    }
    this.#tools.set(tool.manifest.name, tool);
    this.#version++;
  }

  /**
   * Tools refused because process execution is switched off.
   *
   * Read by boot so the reason lands on the operator's screen. A security
   * control that silently removes half the tool surface teaches people the
   * product is broken; one that says what it withheld teaches them it works.
   */
  get withheldForShellExec(): readonly string[] {
    return this.#withheld;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Remove a dynamically-registered tool (MCP servers on teardown).
   *  Returns false if the name was not registered. */
  unregister(name: string): boolean {
    const removed = this.#tools.delete(name);
    if (removed) this.#version++;
    return removed;
  }

  /** All registered tools, for prompt construction. */
  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /**
   * Invoke a tool by name within the sandbox. Never throws: every failure
   * (unknown tool, permission denial, execution error) is caught, audited, and
   * returned as a structured ToolResult.
   *
   * Honors `tool.manifest.retry` (P0-#5): up to `attempts` extra calls with
   * linear backoff when the failure matches one of the `on` categories.
   * Tools without a retry manifest take the single-attempt path.
   *
   * Honors `opts.signal` + `opts.timeoutMs` (P0-#3): the registry creates a
   * per-call AbortController that combines the caller's signal with an
   * internal timeout, then hands the resulting signal to the tool via
   * `ctx.signal`. If the caller's signal aborts (AgentLoop.stop) or the
   * timeout fires, the tool's `ctx.signal` becomes aborted AND the registry
   * returns a structured error so the agent loop sees a clean stop / timeout
   * even if the tool itself never resolves.
   */
  async call(
    name: string,
    args: Record<string, unknown>,
    sessionId: string,
    opts: ToolCallOptions = {},
  ): Promise<ToolResult> {
    const start = Date.now();
    // A weak model sometimes serialises the WHOLE call into the name slot and
    // leaves the arguments empty: name = '{"name":"get_reservation_details",
    // "args":{"reservation_id":"OWZ4XL"}}', args = {}. Reporting that as
    // `unknown_tool` is true but useless — the model has no way to see that the
    // NAME was the problem, so it retries the same shape with different
    // whitespace. Observed doing exactly that four times in a row on one task,
    // never recovering. Unwrapping costs nothing and is done here because
    // `call` is the one door every caller comes through.
    ({ name, args } = unwrapDoubleEncodedCall(name, args, (n) => this.#tools.has(n)));
    const tool = this.#tools.get(name);

    if (!tool) {
      this.#audit.log({
        sessionId,
        actionType: "blocked",
        toolName: name,
        argsJson: safeJson(args),
        result: "blocked",
        blockedReason: `unknown or unregistered tool "${name}"`,
      });
      // A call to a tool that does not exist is the one UNAMBIGUOUS capability
      // gap the runtime can observe: the model named a capability it needed and
      // we do not have it. Everything else ("I can't do that") is a text
      // heuristic that breaks across languages. This used to be audited only,
      // so the signal never reached the observation log where tool_health and
      // the pruning pass can see it. `argsKeys` is kept because the shape of
      // the arguments says what the missing tool was expected to take.
      this.#observations?.append({
        sessionId,
        tool: name,
        success: false,
        durationMs: 0,
        error: "unknown_tool",
        argsKeys: Object.keys(args),
      });
      return {
        ok: false,
        content: `Tool "${name}" is not available.`,
        error: "unknown_tool",
      };
    }

    // P0-4: before_tool_call hook. A blocking handler aborts the call
    // with a structured error and an audit row tagged with the reason.
    // The hook never throws (the registry catches + logs); a block is
    // a deliberate `{ block: true, reason }` return.
    if (this.#hooks) {
      const hookResult = await this.#hooks.fire("before_tool_call", {
        tool: name,
        args,
        sessionId,
      });
      if (hookResult?.block) {
        this.#audit.log({
          sessionId,
          actionType: "blocked",
          toolName: name,
          argsJson: safeJson(args),
          result: "blocked",
          blockedReason: `hook: ${hookResult.reason}`,
        });
        return {
          ok: false,
          content: `Tool "${name}" blocked by hook: ${hookResult.reason}`,
          error: "blocked_by_hook",
        };
      }
    }

    // P2-#2: per-tool circuit breaker. If the tool is currently in
    // OPEN or has a HALF_OPEN probe in flight, short-circuit with a
    // structured error so the LLM gets a clean "this tool is sick"
    // signal without burning a 60s timeout.
    const breakerCheck = this.#breaker.check(name);
    if (!breakerCheck.allow) {
      this.#audit.log({
        sessionId,
        actionType: "blocked",
        toolName: name,
        argsJson: safeJson(args),
        result: "blocked",
        blockedReason: breakerCheck.reason ?? "circuit_open",
      });
      this.#observations?.append({
        sessionId,
        tool: name,
        success: false,
        durationMs: 0,
        error: breakerCheck.reason ?? "circuit_open",
        argsKeys: Object.keys(args),
      });
      return {
        ok: false,
        content: `Tool "${name}" short-circuited: ${breakerCheck.reason}. Try a different approach or wait for recovery.`,
        error: "circuit_open",
      };
    }

    // Per-call abort controller. Combines:
    //   1. caller-supplied signal (e.g. AgentLoop.stop() / a test's abort)
    //   2. internal timeout (default 60s, overridable per call)
    // The combined signal is what the tool sees via `ctx.signal`.
    const ac = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort("timeout"), timeoutMs);
    const onCallerAbort = () => ac.abort("cancelled");
    if (opts.signal) {
      if (opts.signal.aborted) {
        ac.abort("cancelled");
      } else {
        opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const ctx: ToolContext = {
      sessionId,
      signal: ac.signal,
      manifest: tool.manifest,
      fetch: this.#egress.forTool(tool.manifest, sessionId),
      audit: this.#audit.logger,
      // Only expose the process sandbox to tools that declared
      // `process:spawn`. Other tools receive `undefined` so a typo or
      // a misconfigured call site fails loudly at the property access,
      // not silently.
      process: tool.manifest.permissions.includes("process:spawn")
        ? this.#process
        : undefined,
      // askUser is always available when the registry was constructed
      // with a bridge; the ask_user tool checks ctx.askUser is defined
      // and refuses to run otherwise.
      askUser: this.#askUser ?? undefined,
      desktopControl: this.#desktopControl ?? undefined,
      capabilities: this.#capabilities ?? undefined,
      admin: this.#admin ?? undefined,
      progress: opts.onProgress
        ? (event) => {
            const full: ToolProgressEvent = {
              type: "tool_progress",
              sessionId,
              tool: name,
              ...event,
            };
            opts.onProgress?.(full);
          }
        : undefined,
    };

    const policy = tool.manifest.retry;

    // Fast path: no retry policy → original single-attempt behavior. Kept
    // separate so the hot path stays zero-overhead for tools that don't opt in.
    if (!policy || policy.attempts <= 0) {
      const outcome = await raceWithAbort(
        () => this.#executeOnce(name, tool, ctx, args, sessionId, start),
        ac.signal,
      );
      if (typeof outcome === "object" && outcome !== null && "kind" in outcome && outcome.kind === "aborted") {
        return await this.#settle(
          name,
          tool,
          {
            ok: false,
            content: `Tool "${name}" aborted: ${outcome.reason}`,
            error: outcome.reason === "timeout" ? "timeout" : "cancelled",
          },
          args,
          sessionId,
          opts,
          start,
          ac,
          timer,
          onCallerAbort,
          false,
        );
      }
      // Unreachable while #executeOnce catches internally, but kept in-band so a
      // rejecting producer degrades to a tool error instead of hanging the loop.
      if (typeof outcome === "object" && outcome !== null && "kind" in outcome && outcome.kind === "thrown") {
        return await this.#settle(
          name,
          tool,
          {
            ok: false,
            content: `Tool "${name}" failed: ${String(outcome.error)}`,
            error: "execution_error",
          },
          args,
          sessionId,
          opts,
          start,
          ac,
          timer,
          onCallerAbort,
          true,
        );
      }
      return await this.#settle(
        name,
        tool,
        outcome as ToolResult,
        args,
        sessionId,
        opts,
        start,
        ac,
        timer,
        onCallerAbort,
        true,
      );
    }

    // Retry path: try up to attempts+1 times, sleeping backoffMs * attempt
    // between failed attempts. The last observed result (or thrown error) is
    // returned if all attempts are exhausted.
    const maxAttempts = policy.attempts + 1;
    let lastFailedResult: ToolResult | null = null;
    let lastThrown: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Honour caller cancellation between attempts too — no point retrying
      // a tool the user has already stopped.
      if (ac.signal.aborted) {
        return await this.#settle(
          name,
          tool,
          {
            ok: false,
            content: `Tool "${name}" cancelled after ${attempt - 1} attempt(s).`,
            error: "cancelled",
          },
          args,
          sessionId,
          opts,
          start,
          ac,
          timer,
          onCallerAbort,
          false,
        );
      }
      if (attempt > 1) {
        await sleep(RETRY_BACKOFF_MS * (attempt - 1));
      }
      const outcome = await raceWithAbort(
        () => this.#executeOnceCapture(name, tool, ctx, args, sessionId, start),
        ac.signal,
      );
      if (outcome.kind === "ok") {
        return await this.#settle(
          name, tool, outcome.result, args, sessionId, opts,
          start, ac, timer, onCallerAbort, true,
        );
      }
      if (outcome.kind === "result") {
        lastFailedResult = outcome.result;
        if (!isRetryable(policy, outcome.result)) {
          // Non-retryable failure — exactly the case `manifest.fallback` is
          // documented to cover, so the chain must be tried here and not only
          // after retries are exhausted.
          return await this.#settle(
            name, tool, outcome.result, args, sessionId, opts,
            start, ac, timer, onCallerAbort, true,
          );
        }
      } else if (outcome.kind === "thrown") {
        // "thrown" — recorded as an execution_error inside #executeOnceCapture
        lastThrown = outcome.error;
        if (!isRetryable(policy, "thrown")) {
          return await this.#settle(
            name,
            tool,
            {
              ok: false,
              content: `Tool "${name}" failed: ${String(outcome.error)}`,
              error: "execution_error",
            },
            args, sessionId, opts, start, ac, timer, onCallerAbort, true,
          );
        }
      } else {
        // "aborted" — the timeout or caller signal fired. The agent loop
        // gets a clean stop/timeout result so it can keep moving.
        return await this.#settle(
          name,
          tool,
          {
            ok: false,
            content: `Tool "${name}" aborted: ${outcome.reason}`,
            error: outcome.reason === "timeout" ? "timeout" : "cancelled",
          },
          args, sessionId, opts, start, ac, timer, onCallerAbort, false,
        );
      }
    }

    // Retries exhausted. Prefer the last structured result (preserves the
    // tool's own error code) over the synthetic execution_error wrapper.
    const finalResult: ToolResult = lastFailedResult ?? {
      ok: false,
      content: `Tool "${name}" failed: ${String(lastThrown)}`,
      error: "execution_error",
    };
    // P0-4: after_tool_call hook + fallback chain, via the shared tail so this
    // path stays identical to every other return point.
    return await this.#settle(
      name, tool, finalResult, args, sessionId, opts,
      start, ac, timer, onCallerAbort, true,
    );
  }

  /**
   * Single attempt: run the tool, audit + observe the outcome, return the
   * structured result. Catches throws and converts them to a synthetic
   * `{ok:false, error: "execution_error"}` result so the retry loop above
   * can inspect them through a single code path.
   *
   * Returned shape is a discriminated union so the retry loop can tell
   * "tool returned a structured failure" from "tool threw" without a second
   * try/catch.
   */
  async #executeOnce(
    name: string,
    tool: Tool,
    ctx: ToolContext,
    args: Record<string, unknown>,
    sessionId: string,
    startedAt: number,
  ): Promise<ToolResult> {
    const outcome = await this.#executeOnceCapture(name, tool, ctx, args, sessionId, startedAt);
    if (outcome.kind === "ok" || outcome.kind === "result") return outcome.result;
    return {
      ok: false,
      content: `Tool "${name}" failed: ${String(outcome.error)}`,
      error: "execution_error",
    };
  }

  async #executeOnceCapture(
    name: string,
    tool: Tool,
    ctx: ToolContext,
    args: Record<string, unknown>,
    sessionId: string,
    startedAt: number,
  ): Promise<
    | { kind: "ok"; result: ToolResult }
    | { kind: "result"; result: ToolResult }
    | { kind: "thrown"; error: unknown }
  > {
    try {
      const result = await tool.execute(args, ctx);
      const durationMs = Date.now() - startedAt;
      this.#audit.log({
        sessionId,
        actionType: "tool_call",
        toolName: name,
        argsJson: safeJson(args),
        result: result.ok ? "success" : "error",
        blockedReason: result.ok ? undefined : result.error,
        durationMs,
      });
      this.#observations?.append({
        sessionId,
        tool: name,
        success: result.ok,
        durationMs,
        error: result.ok ? null : (result.error ?? result.content.slice(0, 120)),
        argsKeys: Object.keys(args),
      });
      // P2-#2: feed the circuit breaker. A success resets the failure
      // log; a structured failure counts as a failure. The breaker
      // opens after `failureThreshold` consecutive failures.
      //
      // Exception: a `recoverable` error is an explicit "try again" signal
      // (e.g. control_app's stale element handle after the UI moved, or a
      // transient UIA hiccup) — fast and EXPECTED during exploration. The
      // breaker exists to trade *long* repeated waits for a fast signal, so
      // tripping it on a local, instant tool's recoverable friction only
      // injects a needless 30–60s OPEN stall. Don't count those; genuine
      // (unrecoverable) failures still trip the breaker exactly as before.
      if (result.ok) {
        this.#breaker.recordSuccess(name);
      } else if (result.error !== "recoverable") {
        this.#breaker.recordFailure(name);
      }
      return result.ok
        ? { kind: "ok", result }
        : { kind: "result", result };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.#audit.log({
        sessionId,
        actionType: "tool_call",
        toolName: name,
        argsJson: safeJson(args),
        result: "error",
        blockedReason: String(err),
        durationMs,
      });
      this.#observations?.append({
        sessionId,
        tool: name,
        success: false,
        durationMs,
        error: String(err).slice(0, 120),
        argsKeys: Object.keys(args),
      });
      // P2-#2: a thrown error is also a failure for the breaker.
      this.#breaker.recordFailure(name);
      return { kind: "thrown", error: err };
    }
  }

  /** A compact, model-facing description of all tools and their parameters. */
  describe(): string {
    return this.list()
      .map((tool) => {
        const params = Object.entries(tool.parameters)
          .map(([key, p]) => describeParam(key, p))
          .join(", ");
        return `- ${tool.manifest.name}(${params}): ${tool.manifest.description}`;
      })
      .join("\n");
  }

  /**
   * Inspect a tool's circuit-breaker state (P2-#2). Public for
   * debugging, observability, and the agent's self-diagnosis
   * (`tool_health` tool). Cheap O(1) lookup.
   */
  breakerStateOf(tool: string): "closed" | "open" | "half_open" {
    return this.#breaker.stateOf(tool);
  }
}

function describeParam(key: string, p: ToolParameter): string {
  const optional = p.required === false ? "?" : "";
  return `${key}${optional}: ${p.type} — ${p.description}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable args]"';
  }
}

/** Linear backoff base — see module docstring for rationale. */
const RETRY_BACKOFF_MS = 250;

/**
 * Default per-tool wall-clock timeout. Most V1 tools finish in well under
 * a second on local resources; 60s is a generous ceiling that still bounds
 * the agent loop against hung FS / hung fetch / runaway subprocesses. Callers
 * (tests, ad-hoc scripts) can override per-call via `opts.timeoutMs`.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * Cleanup helper invoked at every return point of `call()`. Releases the
 * timeout timer and the caller's abort listener so neither leaks across
 * multiple calls in the same session.
 *
 * Also handles the case where the tool's own result is from an aborted
 * race — in that case we replace the (potentially stale) `result` with a
 * structured timeout/cancellation error so the LLM sees a clear signal.
 */
function finalize(
  result: ToolResult,
  ac: AbortController,
  timer: ReturnType<typeof setTimeout>,
  callerSignal: AbortSignal | undefined,
  onCallerAbort: () => void,
): ToolResult {
  clearTimeout(timer);
  if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  // If the race was lost (timeout or caller-cancel) but the inner promise
  // eventually settled with a "success" result, downgrade to a structured
  // error so the LLM knows the call was interrupted, not successful.
  if (ac.signal.aborted) {
    const reason = ac.signal.reason;
    if (reason === "timeout") {
      return {
        ok: false,
        content: `Tool aborted: timeout`,
        error: "timeout",
      };
    }
    if (reason === "cancelled") {
      return {
        ok: false,
        content: `Tool aborted: cancelled`,
        error: "cancelled",
      };
    }
  }
  return result;
}

/**
 * Race a producer against an abort signal. The producer is invoked lazily
 * (so we don't start a tool call we know is already cancelled). When the
 * signal aborts first, we return an `"aborted"` outcome carrying the
 * abort reason (`"timeout"` | `"cancelled"`), so the caller can build a
 * structured error.
 *
 * The producer's underlying promise is intentionally not cancelled — JS
 * has no general way to cancel a promise. Tools that respect `ctx.signal`
 * will see the abort and unwind; tools that don't will resolve eventually
 * and the result will be discarded (slight memory pressure in pathological
 * cases, acceptable trade-off for keeping the agent loop responsive).
 *
 * A rejecting producer resolves as `{kind:"thrown"}` rather than rejecting.
 * Both current producers catch internally so this is unreachable today, but the
 * previous version removed the abort listener and then threw inside a `.then`
 * rejection handler — which left the outer promise permanently unsettled, so the
 * awaiting `call()` would hang forever with the timeout already disarmed. Keeping
 * the failure in-band means a future producer that CAN reject degrades to a
 * normal tool error instead of deadlocking the agent loop.
 */
async function raceWithAbort<T>(
  producer: () => Promise<T>,
  signal: AbortSignal,
): Promise<T | { kind: "aborted"; reason: string } | { kind: "thrown"; error: unknown }> {
  if (signal.aborted) {
    return { kind: "aborted", reason: String(signal.reason) };
  }
  return new Promise<
    T | { kind: "aborted"; reason: string } | { kind: "thrown"; error: unknown }
  >((resolve) => {
    const onAbort = () =>
      resolve({ kind: "aborted", reason: String(signal.reason) });
    signal.addEventListener("abort", onAbort, { once: true });
    producer().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "thrown", error: err });
      },
    );
  });
}

/** Resolves after `ms` milliseconds. Extracted so tests can stub it if needed. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classifies a failure as retry-eligible under the tool's retry policy.
 *
 *   - `"any"`     → always retry
 *   - `"thrown"`  → retry only when the policy lists `process`
 *   - `ok: false` → retry when the error is a recognized http-style error AND
 *                   the policy lists `http`
 *
 * Unknown error codes (e.g. `bad_args`, `not_found`, `permission_denied`) are
 * NEVER retried — they are deterministic, retrying would just burn budget.
 */
function isRetryable(
  policy: ToolRetryPolicy,
  failure: ToolResult | "thrown",
): boolean {
  const cats: readonly ToolRetryCategory[] = policy.on;
  if (cats.includes("any")) return true;
  if (failure === "thrown") return cats.includes("process");
  // Structured failure — only retry http-flavored errors.
  if (!failure.ok) {
    if (
      failure.error === "http_error" ||
      failure.error === "network_error"
    ) {
      return cats.includes("http");
    }
  }
  return false;
}

/**
 * Undo a call the model serialised twice.
 *
 * Only fires when the name does not resolve AND the inner name does — so a
 * genuinely missing tool still reports as missing, and a tool legitimately
 * named with a leading brace (there are none, but the registry does not
 * forbid it) still wins. Argument keys cover what the common wire formats
 * call the payload; a wrapper with none is still worth unwrapping, because
 * a no-argument tool is a real thing.
 */
export function unwrapDoubleEncodedCall(
  name: string,
  args: Record<string, unknown>,
  known: (name: string) => boolean,
): { name: string; args: Record<string, unknown> } {
  if (typeof name !== "string" || known(name)) return { name, args };
  const trimmed = name.trim();
  if (!trimmed.startsWith("{")) return { name, args };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { name, args };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { name, args };
  const obj = parsed as Record<string, unknown>;
  const inner = obj.name ?? obj.tool ?? obj.function;
  if (typeof inner !== "string" || !known(inner)) return { name, args };
  const payload = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input;
  const innerArgs =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : args;
  return { name: inner, args: innerArgs };
}
