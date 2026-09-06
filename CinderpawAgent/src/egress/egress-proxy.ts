/**
 * Egress proxy — the single network exit for the entire agent.
 *
 * Non-negotiable constraint: no network request may bypass `cinderpawFetch`. Tools
 * receive a *bound* fetch from `EgressProxy.forTool()` that enforces, for every
 * request:
 *   - the host is in the calling tool's `allowedDomains` whitelist
 *   - the host is not localhost / loopback
 *   - the host is not a private / link-local IP range
 *   - the calling tool's rate limit has not been exceeded
 *   - the per-session budget for STATE-CHANGING requests is not spent
 * Every attempt — allowed or blocked — is written to the audit log.
 */

import { lookup } from "node:dns/promises";
import { benchmarkRunId, cfgList } from "../config.ts";
import type {
  AuditLogger,
  CinderpawFetch,
  CinderpawFetchInit,
  CinderpawFetchResponse,
  ToolManifest,
} from "../types.ts";

/**
 * Hard ceiling on a response body, in bytes.
 *
 * Above every tool's own truncation limit (fetch_url 32 KB, read_webpage
 * 400 KB, http_request 256 KB) so it never changes what a well-behaved server
 * returns, and far below what would exhaust the sidecar. It exists for the
 * case nobody's per-tool limit covered: a server that keeps sending.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body up to `max` bytes, then hang up.
 *
 * The naive `await res.text()` has already downloaded everything by the time
 * any length check runs, so a `Content-Length` of 10 GB — or no header at all
 * and an endless stream — is an OOM with the tool's own cap looking on. This
 * stops pulling instead, and tells the caller it truncated in the only way the
 * body can: the text simply ends.
 */
async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = max - total;
    if (value.length >= room) {
      chunks.push(value.subarray(0, room));
      total = max;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

export interface EgressProxyConfig {
  /**
   * Max requests allowed inside the rolling window, PER TOOL.
   *
   * Was a single global budget shared by every tool, which made the limiter a
   * starvation source rather than a safety net: one `deep_research` call
   * spends dozens of requests, and the next `web_search` in the same minute —
   * a different tool, doing legitimate work — was refused with a message that
   * reads like a security block. On a long unattended run that is a silent
   * derail, because the agent has no way to tell "you are being throttled"
   * from "this host is forbidden".
   *
   * Per-tool is a deliberate loosening (N tools × this, not this in total), so
   * the number came down with it. The guard that actually matters for safety
   * is the domain whitelist plus the SSRF check, both of which run before this
   * and neither of which this affects.
   */
  maxRequests: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Default per-request timeout when a tool does not specify one. */
  defaultTimeoutMs: number;
  /**
   * Exact origins (scheme + host + port) the OPERATOR has declared they run
   * themselves — the only way a loopback/private destination is ever reachable.
   * Exists for self-hosted sidecar services (a SearXNG instance backing
   * web_search, `CINDERPAW_SEARXNG_URL`), which live on localhost by design and
   * would otherwise be blocked by our own SSRF guard.
   *
   * The exemption is deliberately narrow:
   *   - exact-origin match, never a suffix/host match — `http://127.0.0.1:8888`
   *     does not license `http://127.0.0.1:9000` or any other internal port;
   *   - it waives ONLY the private-address guard. The tool's `allowedDomains`
   *     whitelist is still enforced, so a tool that never declared the host
   *     cannot reach it even when it is exempt;
   *   - it is re-checked per hop, so a redirect off the origin lands back
   *     under the full guard;
   *   - it comes from process env, i.e. the human running the process — never
   *     from the model, a tool argument, or a fetched page.
   */
  trustedLocalOrigins: string[];
  /**
   * The underlying fetch the proxy performs the request WITH. Defaults to the
   * global one, which is right everywhere except in the custom-tool child:
   * there the guard replaces `globalThis.fetch` with a proxy-backed one, so a
   * proxy that resolved `fetch` at call time would call itself, once per hop,
   * until the rate limiter stopped it. Capture the native fetch, inject it.
   */
  underlyingFetch: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * How many STATE-CHANGING external requests (POST/PUT/PATCH/DELETE) one
   * session may make before the proxy stops it.
   *
   * Every other guard in this file protects THIS MACHINE from the agent: the
   * SSRF check, the deny wall, the process sandbox. None of them protect the
   * outside world — and for an agent that manages ad campaigns, posts to
   * social accounts or writes to a CRM, the outside world is where the damage
   * is. A wrong file gets rewritten; money spent on an ad platform is spent, a
   * published post is public, a polluted CRM record is in the CRM.
   *
   * This is a VOLUME backstop, and it matters to be precise about what it does
   * and does not buy:
   *   - it DOES stop a runaway loop, which is the failure an unattended run
   *     actually produces: the same POST fired two hundred times;
   *   - it does NOT stop a single wrong write. One request that sets a budget
   *     to the wrong number is inside any budget. Severity needs a human, or a
   *     per-host write allowlist — see the ponytail note on #fetch.
   *
   * Deliberately generous by default so no existing setup breaks: the point is
   * to bound a runaway, not to police normal use. Tune with
   * CINDERPAW_EXTERNAL_WRITE_BUDGET; 0 disables the cap.
   */
  externalWriteBudget: number;
  /**
   * Hosts whose STATE-CHANGING requests may not happen unattended.
   *
   * The operator names them; the model cannot. That is the whole point — the
   * write budget bounds volume and `forceEscalate` covers the agent's own
   * hard calls, but neither helps when the agent simply does not realise a
   * call is expensive. This does, because it does not consult the agent about
   * anything.
   *
   * Deliberately an allowlist of SENSITIVE hosts declared by a human, not a
   * built-in pattern list of "known money endpoints". A pattern list is a
   * denylist wearing a safety hat: it fails open for every API not on it —
   * your CRM, a new ad platform, whatever a forged tool reaches — while
   * reading as though everything is covered. Rotting quietly is the worst
   * property a safety control can have.
   *
   * Reads are never affected: the agent can look at your ad account all it
   * likes, it just cannot change it while you are away.
   */
  unattendedWriteDenyHosts: string[];
  /**
   * True when nobody is at the machine (mirrors CINDERPAW_AUTONOMOUS). Only
   * consulted for `unattendedWriteDenyHosts`.
   */
  unattended: boolean;
  /**
   * Log every state-changing request and DO NOT send it.
   *
   * The honest first run against a real ad account: let it do the whole task,
   * then read exactly what it would have changed. The agent is told the call
   * was a dry run rather than being handed a fake success, because an agent
   * that believes a write landed will build its next step on a fiction.
   */
  dryRunWrites: boolean;
}

/**
 * HTTP methods that change state on the far end.
 *
 * Classified by METHOD, not by tool: a forged tool, an MCP server and
 * `http_request` all reach the same APIs, so a guard that trusts the caller
 * guards nothing. GET/HEAD/OPTIONS are reads; anything else is assumed to
 * change something — including verbs we do not recognise, because the safe
 * default for an unknown method is to count it.
 */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isWriteMethod(method: string | undefined): boolean {
  return !READ_METHODS.has((method ?? "GET").toUpperCase());
}

const DEFAULT_CONFIG: EgressProxyConfig = {
  maxRequests: 20,
  windowMs: 60_000,
  defaultTimeoutMs: 15_000,
  trustedLocalOrigins: [],
  underlyingFetch: (url, init) => fetch(url, init),
  externalWriteBudget: 50,
  unattendedWriteDenyHosts: [],
  unattended: false,
  dryRunWrites: false,
};

export class EgressProxy {
  readonly #audit: AuditLogger;
  readonly #config: EgressProxyConfig;
  /**
   * Tool name → timestamps of its recent requests (rolling-window limiter).
   * Keyed by TOOL, not by tool+session: two surfaces running `web_search`
   * concurrently share one budget, which is the conservative reading and keeps
   * the ceiling from multiplying by however many sessions happen to be live.
   */
  readonly #recent = new Map<string, number[]>();
  /** sessionId → state-changing requests already made in this session. */
  readonly #writes = new Map<string, number>();

  constructor(audit: AuditLogger, config: Partial<EgressProxyConfig> = {}) {
    this.#audit = audit;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Produce a fetch bound to a single tool's permissions. The returned function
   * is the only network primitive a tool is ever given.
   */
  forTool(manifest: ToolManifest, sessionId: string): CinderpawFetch {
    return (url: string, init?: CinderpawFetchInit) =>
      this.#fetch(manifest, sessionId, url, init);
  }

  async #fetch(
    manifest: ToolManifest,
    sessionId: string,
    url: string,
    init?: CinderpawFetchInit,
  ): Promise<CinderpawFetchResponse> {
    const start = Date.now();

    const block = (reason: string): never => {
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "blocked",
        toolName: manifest.name,
        argsJson: JSON.stringify({ url }),
        result: "blocked",
        blockedReason: reason,
        durationMs: Date.now() - start,
      });
      throw new EgressBlockedError(reason);
    };

    // 1. The tool must actually be permitted to use the network at all.
    if (!manifest.networkAccess) {
      block(`tool "${manifest.name}" has no network access`);
    }

    const allowed = manifest.allowedDomains ?? [];

    // Validate a single URL hop: scheme, SSRF host guard (by hostname string
    // AND by every resolved IP), and the tool's domain whitelist. Run on the
    // initial URL *and* on every redirect target — `fetch(redirect:"follow")`
    // would chase a 3xx to an internal address without re-checking anything,
    // turning any whitelisted (or compromised) host into an SSRF pivot.
    const validateHop = async (raw: string): Promise<URL> => {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return block(`malformed URL: ${raw}`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        block(`disallowed scheme: ${parsed.protocol}`);
      }
      const host = parsed.hostname.toLowerCase();
      // An operator-declared self-hosted origin (see `trustedLocalOrigins`)
      // waives the private-address guard for THIS hop only. Exact-origin
      // match: the port is part of the identity, so trusting one local
      // service does not trust the rest of the loopback interface. The
      // domain whitelist below still applies — this is not an open door.
      const trustedLocal = this.#config.trustedLocalOrigins.includes(parsed.origin);
      if (!trustedLocal) {
        // SSRF guard by hostname string (literal IPs, localhost, ULA/link-local).
        if (isBlockedHost(host)) {
          block(`destination is loopback/private/link-local: ${host}`);
        }
        // SSRF guard by resolved IP — defeats DNS rebinding and any hostname
        // that points into a private range. Every A/AAAA answer must be public.
        for (const ip of await resolveHostIps(host)) {
          if (isBlockedHost(ip.toLowerCase())) {
            block(`host "${host}" resolves to a blocked address: ${ip}`);
          }
        }
      }
      // Domain whitelist enforcement.
      if (!hostMatchesWhitelist(host, allowed)) {
        block(`host "${host}" not in allowedDomains for "${manifest.name}"`);
      }
      // Benchmark mode narrows every tool's allowlist to one shared list.
      // Last, so an ordinary session pays nothing for it, and so a host that
      // was already going to be refused is refused for its own reason.
      const benchRefusal = benchmarkHostRefusal(host, `tool "${manifest.name}"`);
      if (benchRefusal !== null) block(benchRefusal);
      return parsed;
    };

    // 2-4. Validate the first hop before anything touches the network.
    let parsed = await validateHop(url);

    // 5. State-changing-request budget. Placed AFTER the host checks so a
    //    forbidden host still reports as forbidden, and BEFORE the rate
    //    limiter so a blocked write does not also consume rate budget.
    //
    // ponytail: a per-SESSION volume cap, not a per-host write allowlist and
    // not a spend limit. It bounds "the loop posted 200 times"; it does not
    // bound "the one POST set the wrong number". Upgrade path when that
    // matters: an `allowedWriteDomains` on the manifest, defaulting to empty,
    // so a tool must declare which hosts it may mutate — a bigger change,
    // because every existing tool would need the declaration.
    const isWrite = isWriteMethod(init?.method);

    // Operator-declared sensitive host + nobody watching → refused outright.
    // Checked before the budget so the reason the agent gets is the real one.
    if (
      isWrite &&
      this.#config.unattended &&
      hostMatchesWhitelist(parsed.hostname.toLowerCase(), this.#config.unattendedWriteDenyHosts)
    ) {
      block(
        `"${parsed.hostname}" may not be CHANGED while running unattended — the owner ` +
          `listed it as consequential (CINDERPAW_WRITE_CONFIRM_HOSTS). Reading it is fine. ` +
          `Do the parts of the task that do not change it, then stop and report what ` +
          `needs a human.`,
      );
    }

    if (isWrite && this.#config.externalWriteBudget > 0) {
      const spent = this.#writes.get(sessionId) ?? 0;
      if (spent >= this.#config.externalWriteBudget) {
        block(
          `external write budget spent for this session: ` +
            `${this.#config.externalWriteBudget} state-changing request(s). ` +
            `This is a SAFETY STOP, not a permission denial — ${parsed.hostname} is allowed, ` +
            `but an unattended run should not keep changing things outside this machine ` +
            `without a human seeing the result. Report what you have done so far and stop. ` +
            `Raise CINDERPAW_EXTERNAL_WRITE_BUDGET if this workload genuinely needs more.`,
        );
      }
      this.#writes.set(sessionId, spent + 1);
    }

    // 6. Rate limit (rolling window, per tool). Counts the request once
    //    regardless of how many redirects it follows.
    const window = this.#pruneWindow(manifest.name, start);
    if (window.length >= this.#config.maxRequests) {
      // Name the tool and say it is temporary. The old wording was
      // indistinguishable from a permission block, so an agent that hit it
      // concluded the host was forbidden and stopped trying, instead of
      // waiting or reaching for another tool.
      block(
        `rate limit exceeded for "${manifest.name}": ${this.#config.maxRequests} req / ` +
          `${this.#config.windowMs}ms. Temporary throttling, NOT a permission denial — ` +
          `the host is allowed. Wait and retry, or use a different tool.`,
      );
    }
    window.push(start);

    // 6. Perform the request with an enforced timeout, following redirects
    //    MANUALLY so every hop is re-validated by `validateHop`.
    const controller = new AbortController();
    const timeoutMs = init?.timeoutMs ?? this.#config.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onCallerAbort: (() => void) | undefined;
    if (init?.signal) {
      onCallerAbort = () => controller.abort(init.signal?.reason);
      if (init.signal.aborted) {
        onCallerAbort();
      } else {
        init.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const MAX_REDIRECTS = 5;

    try {
      // Dry run: record the intent, send nothing, and TELL the agent — a
      // fabricated success would have it plan its next step on a write that
      // never happened.
      if (isWrite && this.#config.dryRunWrites) {
        this.#audit({
          timestamp: Date.now(),
          sessionId,
          actionType: "network_write",
          toolName: manifest.name,
          argsJson: JSON.stringify({ url, method: init?.method, dryRun: true }),
          result: "blocked",
          blockedReason: "dry run — request was logged, not sent",
          durationMs: Date.now() - start,
        });
        const body = JSON.stringify({
          dry_run: true,
          message:
            "CINDERPAW_DRY_RUN is on: this state-changing request was recorded and NOT sent. " +
            "Nothing changed on the far end. Continue as if you had made the call, but do " +
            "not claim the change happened — say it was a dry run.",
          would_have_sent: { method: init?.method, url },
        });
        return {
          status: 200,
          ok: true,
          headers: { "content-type": "application/json", "x-cinderpaw-dry-run": "1" },
          text: async () => body,
          json: async () => JSON.parse(body) as unknown,
        };
      }

      let method = init?.method ?? "GET";
      let body = init?.body;
      // Copy caller headers so we can strip credentials on a cross-origin hop
      // without mutating the caller's object.
      let headers: Record<string, string> = { ...(init?.headers ?? {}) };
      let currentOrigin = parsed.origin.toLowerCase();

      for (let hop = 0; ; hop++) {
        const res = await this.#config.underlyingFetch(parsed.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
        });

        // 3xx with a Location → re-validate the target and continue.
        const isRedirect =
          res.status >= 300 && res.status < 400 && res.headers.has("location");
        if (isRedirect) {
          if (hop >= MAX_REDIRECTS) {
            block(`too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`);
          }
          const loc = res.headers.get("location")!;
          const next = new URL(loc, parsed); // resolve relative Location
          // Per fetch semantics: 303 (and 301/302 on an unsafe method)
          // downgrades the follow-up to GET and drops the body.
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) &&
              method !== "GET" &&
              method !== "HEAD")
          ) {
            method = "GET";
            body = undefined;
          }
          // Drop credentials when the ORIGIN changes so a redirect can't
          // leak an Authorization/Cookie header somewhere else.
          //
          // Origin, not hostname. The comment always said origin; the code
          // compared `hostname`, which is the host and nothing else — so
          // `https://api.example.com` redirecting to `http://api.example.com`
          // kept the Authorization header and sent it in clear text, and a hop
          // from :443 to :8080 on the same host kept it too. Both are the same
          // hostname and neither is the same origin. `URL.origin` is
          // scheme + host + port, which is the comparison this was always
          // meant to be.
          const nextOrigin = next.origin.toLowerCase();
          if (nextOrigin !== currentOrigin) {
            for (const k of Object.keys(headers)) {
              const lk = k.toLowerCase();
              if (lk === "authorization" || lk === "cookie" || lk === "proxy-authorization") {
                delete headers[k];
              }
            }
            currentOrigin = nextOrigin;
          }
          parsed = await validateHop(next.toString());
          continue;
        }

        // Final (non-redirect) response. The body is read ONCE, bounded.
        // `res.text()` downloads whatever the server sends before anyone can
        // check its length, so every caller's own truncation limit only
        // applied after the bytes were already in memory: a hostile or broken
        // endpoint streaming gigabytes took the sidecar down with it. Reading
        // through the stream lets us hang up mid-transfer instead.
        const responseBody = await readBounded(res, MAX_RESPONSE_BYTES);
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });

        this.#audit({
          timestamp: Date.now(),
          sessionId,
          // Writes get their own action type: after a two-hour unattended run
          // the question is "what did it CHANGE out there", and that should be
          // one grep, not a scan of every GET the agent made.
          actionType: isWrite ? "network_write" : "network",
          toolName: manifest.name,
          argsJson: JSON.stringify({ url, method: init?.method ?? "GET" }),
          result: "success",
          durationMs: Date.now() - start,
        });

        return {
          status: res.status,
          ok: res.ok,
          headers: respHeaders,
          text: async () => responseBody,
          json: async () => JSON.parse(responseBody) as unknown,
        };
      }
    } catch (err) {
      // A blocked redirect throws EgressBlockedError (already audited by
      // `block`); re-throw it as-is so callers see the block reason.
      if (err instanceof EgressBlockedError) throw err;
      const message =
        controller.signal.aborted
          ? `request timed out after ${timeoutMs}ms`
          : String(err);
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "network",
        toolName: manifest.name,
        argsJson: JSON.stringify({ url }),
        result: "error",
        blockedReason: message,
        durationMs: Date.now() - start,
      });
      throw new EgressError(message);
    } finally {
      clearTimeout(timer);
      if (onCallerAbort && init?.signal) {
        init.signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  /**
   * Drop expired timestamps for one tool and return its live window.
   *
   * The returned array is the one stored in the map, so the caller's push
   * lands in the limiter's state. An earlier version deleted the row when the
   * window emptied — which meant the very first request got a DETACHED array,
   * pushed into it, and threw it away, so the limit never engaged at all. The
   * map is bounded by the number of distinct tool names, and an empty array
   * per tool is not worth a bug.
   */
  #pruneWindow(tool: string, now: number): number[] {
    let window = this.#recent.get(tool);
    if (!window) {
      window = [];
      this.#recent.set(tool, window);
    }
    const cutoff = now - this.#config.windowMs;
    while (window.length > 0 && window[0]! < cutoff) {
      window.shift();
    }
    return window;
  }
}

export class EgressBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EgressBlockedError";
  }
}

export class EgressError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EgressError";
  }
}

/** True when `host` is already an IP literal (no DNS resolution needed). */
function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
}

/**
 * Resolve a hostname to every A/AAAA address so each can be checked against
 * the SSRF guard. Literal IPs resolve to themselves. On resolution failure we
 * return `[]` rather than blocking — the hostname-string and whitelist checks
 * have already run, and a DNS hiccup shouldn't masquerade as a security block;
 * the subsequent `fetch` will surface the real network error.
 */
async function resolveHostIps(host: string): Promise<string[]> {
  if (isIpLiteral(host)) return [host.replace(/^\[|\]$/g, "")];
  try {
    const records = await lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * True when a host is loopback, a private range, or link-local.
 *
 * IPv6 is decoded rather than string-matched. The old check tested for the
 * literal text `::1`, which meant every other spelling of the same address
 * walked through: `[0:0:0:0:0:0:0:1]` is loopback, and `[::ffff:127.0.0.1]` is
 * loopback wearing an IPv6 costume — neither is the string "::1". An address is
 * a number, so compare numbers.
 */
export function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const v6 = parseIPv6(host);
  if (v6) {
    // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 address; judge it by the v4
    // rules, or ::ffff:127.0.0.1 is a loopback they never get to see.
    const mapped =
      v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    if (mapped) return isBlockedV4(v6[12]!, v6[13]!);

    if (v6.every((b, i) => (i < 15 ? b === 0 : b === 1))) return true; // ::1
    if (v6.every((b) => b === 0)) return true; // ::
    if ((v6[0]! & 0xfe) === 0xfc) return true; // ULA fc00::/7
    if (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
    return false;
  }

  const v4 = parseIPv4(host);
  if (v4) return isBlockedV4(v4[0], v4[1]);

  return false;
}

function isBlockedV4(a: number, b: number): boolean {
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this" network
  return false;
}

/**
 * Decode an IPv6 literal (brackets optional) into its 16 bytes, or null when
 * `host` is not one. Handles `::` elision and an embedded IPv4 tail.
 */
export function parseIPv6(host: string): number[] | null {
  const raw = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!raw.includes(":")) return null;

  let text = raw;
  let v4: [number, number, number, number] | null = null;

  // A trailing dotted-quad (::ffff:127.0.0.1) occupies the last two groups.
  const lastSep = text.lastIndexOf(":");
  const tail = text.slice(lastSep + 1);
  if (tail.includes(".")) {
    v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastSep + 1)}0:0`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const split = (s: string) => (s === "" ? [] : s.split(":"));
  const left = split(halves[0] ?? "");
  const right = halves.length === 2 ? split(halves[1] ?? "") : [];

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const elided = 8 - (left.length + right.length);
    if (elided < 1) return null;
    groups = [...left, ...Array<string>(elided).fill("0"), ...right];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}

/** Parse a dotted-quad IPv4 literal, or null if `host` is not one. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((p) => Number(p));
  if (parts.some((n) => n > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/**
 * A host matches the whitelist if it equals an entry exactly or is a subdomain
 * of an entry (so `api.example.com` matches `example.com`). The single entry
 * `"*"` matches every host — used for open-egress tools. This is NOT an SSRF
 * bypass: isBlockedHost() runs before the whitelist on every hop, so loopback/
 * private/link-local destinations stay blocked even under `"*"`. The ONE
 * exception is an origin the operator listed in `trustedLocalOrigins` (a
 * self-hosted service they run) — see that field's contract.
 */
export function hostMatchesWhitelist(host: string, whitelist: string[]): boolean {
  // Both sides, not one. This normalised the ENTRY and trusted the caller for
  // the HOST — an unstated precondition on a security predicate, and the shape
  // that invites the mistake. Every caller today does lowercase the host
  // (`parsed.hostname` is already folded by WHATWG URL), so this is latent
  // rather than live; the failure it would produce is an over-deny, which is
  // the safe direction but reads to the user as "my allowlist entry does
  // nothing". DNS is case-insensitive, so the comparison must be too.
  const h = host.toLowerCase();
  return whitelist.some((entry) => {
    if (entry === "*") return true;
    const e = entry.toLowerCase().replace(/^\*\./, "");
    return h === e || h.endsWith(`.${e}`);
  });
}

/**
 * The benchmark-mode network kill-switch.
 *
 * A measured run is only worth reporting if you can say where its data came
 * from. Every tool allowlist in this repo is written for ordinary use — some
 * are `"*"` — so during a benchmark the agent can reach a search engine, a
 * forum, or a page containing the answer, and nothing in the results would
 * show it. Benchmark mode replaces all of that with one list: while
 * `CINDERPAW_BENCHMARK_RUN_ID` is set, these are the only hosts that exist.
 *
 * It is a NARROWING, never a widening. Everything the normal path refuses —
 * the SSRF guard, the per-tool allowlist, the rate limit — still refuses.
 * This only takes reachable hosts away.
 *
 * Called from BOTH network exits: `EgressProxy` (all tool traffic, and every
 * redirect hop) and `InferenceRouter.#callTarget` (all model traffic, which
 * uses the global `fetch` and never touches this proxy). A guard on only one
 * of the two would be a kill-switch with a hole the size of the model API.
 *
 * Empty allowlist with the mode on = nothing is reachable. That is deliberate:
 * the alternative is a run that quietly had full network access because a
 * second variable was forgotten. The message names the variable to set.
 */
export function benchmarkHostRefusal(host: string, who: string): string | null {
  const runId = benchmarkRunId();
  if (runId === null) return null;
  const allowed = cfgList("CINDERPAW_BENCHMARK_ALLOW_HOSTS");
  if (hostMatchesWhitelist(host.toLowerCase(), allowed)) return null;
  return (
    `benchmark mode (run "${runId}") allows no network except ` +
    `CINDERPAW_BENCHMARK_ALLOW_HOSTS; ${who} tried to reach "${host}". ` +
    (allowed.length === 0
      ? "CINDERPAW_BENCHMARK_ALLOW_HOSTS is empty, so every host is refused — " +
        "set it to the hosts this run legitimately needs (model API, scorecard API)."
      : `Currently allowed: ${allowed.join(", ")}.`)
  );
}
