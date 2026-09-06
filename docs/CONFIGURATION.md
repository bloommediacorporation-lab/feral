# CINDERPAW configuration reference

> **Audience:** operators, integrators, and security reviewers. End users
> who only want the wizard-driven experience can stop after §1.
>
> **Machine-checked:** the canonical list of `CINDERPAW_*` env vars lives
> in the fenced `cinderpaw-env-vars` block at the bottom of this file.
> `scripts/check-env-docs.mjs` greps source for `CINDERPAW_*` and fails if
> anything in code is missing from that block (or vice-versa). Run it
> after adding a new env var.

Cinderpaw reads ~90 env vars across two runtimes (the Rust host
`crates/cinderpaw-core` and the TypeScript sidecar `CinderpawAgent/`). This
document lists every one, the default, the read site, and — for the
security-relevant ones — an explicit threat note.

## 1. Security-critical vars (read this first)

If you only have time to read one section, read this one. Each row
below is an env var that can grant capabilities beyond the default
sandbox. **Do not enable any of these on a multi-user host, a CI
runner, or anything that handles untrusted input.**

| Var | Default | Threat when enabled | Mitigation |
|---|---|---|---|
| `CINDERPAW_ENABLE_SHELL_EXEC` | off | Spawns `cmd` / `pwsh` / `sh` from the `shell_exec` tool, with a whitelist of programs (`process-sandbox.ts`). Any listed binary inherits the agent's prompt — prompt-injection = full process creation. | Keep the whitelist tight; deny `pwsh -Command "iex …"` patterns. |
| `CINDERPAW_ENABLE_CODE_EXEC` | off | Runs Python in a subprocess with a sanitized env. The process can read files the agent has access to and emit subprocesses of its own. | Restricted env, no network by default. |
| `CINDERPAW_ENABLE_NOTEBOOK` | off | Registers `notebook`, a persistent JS interpreter. Cells run in a `node:vm` context with no ambient `fetch`/`process`/`require`, and every capability still goes through the tool registry — so it grants no permission `shell_exec` did not already reach. The residual risk is that `vm` is a hardened context, not an isolate: it is proof against a careless model, not against hostile source. | Leave off unless you want it. Never enable it on a session that executes source from an untrusted third party. |
| `CINDERPAW_ENABLE_DESKTOP_CONTROL` | off | `control_app` tool can move the mouse, click, type, and drive any focused OS app. There is no per-window permission — "the desktop" is one privilege. | Keep the per-action confirmation ON (`CINDERPAW_DESKTOP_CONTROL_CONFIRM` not set to `false`). |
| `CINDERPAW_DESKTOP_CONTROL_CONFIRM=false` | off (i.e. confirmation is on) | Disables the per-action confirmation dialog. Same privilege as above, but silently — the user no longer sees what's about to happen. | Don't set this on shared machines; document who is YOLO. |
| `CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS` | empty | Comma-separated allowlist of app names the `control_app` tool will target. Empty = no targets accepted (tool fails closed). | Use this even if the tool itself is enabled; deny untrusted app names. |
| `CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK` | off | Sidecar-internal kill-switch that the desktop host uses to remember "user already approved this exact action"; see `control-app.ts`. | Not a security boundary; remains a UX shortcut only. |
| `CINDERPAW_DB_KEY` | unset (no encryption at rest) | 32-byte key for the agent's SQLite DB. **Anyone who can read this value can read the DB.** Treat it as a root secret. | Generate once per install; persist in OS keychain, not dotfiles. |
| `CINDERPAW_AGENT_WORKSPACE` | unset (deny all tool access to host FS) | Sidecar-internal Rust tools accept absolute paths under this value. Set to `/` on Unix or `C:\` on Windows to grant full disk access to code-exec and shell. | Always absolute, never `/`, never `C:\`. |
| `CINDERPAW_WORKSPACE` | (TS list — see trap below) | Agent FS roots. Anything in this list, plus any child, is exposed to write tools. Unset = launch cwd + the user's home dir. | The call-time deny wall (`tool-permissions.ts`) refuses `~/.cinderpaw` (except scratch), `~/.ssh`, and `CINDERPAW_FS_DENY` targets on every access, whatever the roots. |
| `CINDERPAW_FETCH_DOMAINS` | empty | Comma-separated URL allowlist for the `fetch_url` tool. Empty = tool fails closed. With this set, the agent can pull arbitrary HTML from each listed origin. | Add only origins you trust to serve benign HTML. |
| `CINDERPAW_HTTP_DOMAINS` | empty | Same shape, for the lower-level `http_request` tool. | Same advice. |
| `CINDERPAW_TRUSTED_BASE_URLS` | empty | Comma-separated base URLs the inference router may call beyond the loopback default. Bypasses the egression posture in `inference-router.ts`. | List one provider base URL per entry; never `*`. |
| `CINDERPAW_SHELL_WHITELIST` | unset = any binary | RESTRICTS `shell_exec` to a named set. There is no binary allowlist by default, and there never effectively was one: the old default list carried `sh`, `bash`, `cmd` and `powershell`, so `sh -c "<anything>"` always ran anything. It only failed DIRECT calls to unlisted tools. | What actually gates this tool: owner-only exposure (`PUBLIC_ALLOWED_TOOLS` omits it), env scrubbing with a forced PATH, `CINDERPAW_PERMISSION_MODE=read_only`, the blast-radius refusal outside workspace roots, and `CINDERPAW_SHELL_DENYLIST`. Set a named list if you want a locked-down toolchain. |
| `CINDERPAW_SHELL_PATH_EXTRA` | unset | Extra directories appended to the PATH every spawned child sees. The agent inherits whatever PATH launched the gateway, which can be much shorter than a terminal's — that is what made `bash` fail with a permissions-sounding error while the same command worked in a terminal. | Appended, never prepended, so it cannot hijack which binary a working call resolves to. Missing directories are ignored. |
| `CINDERPAW_SHELL_DENYLIST` | default set | Overrides the built-in denylist of dangerous binaries `shell_exec` refuses even in YOLO mode. | Only ever extend it; shrinking it removes a safety net. |
| `CINDERPAW_PROACTIVE_ENABLED` | off | Enables the inner-thoughts / mood engines. Same prompt-injection surface as the agent loop, just on a timer. | Don't enable on shared hosts. |
| `CINDERPAW_INNER_THOUGHTS_ENABLED` | off | Sub-flag of proactive. Same threat. | Don't enable on shared hosts. |
| `CINDERPAW_SEARXNG_URL` | unset | The one origin exempted from the egress SSRF guard's loopback/private block, so `web_search` can reach a SearXNG you host. A wrong value points the agent at an internal service. | Set it to an instance **you** run. The exemption is exact-origin (port included), waives only the private-address check (the domain whitelist still applies), and is re-checked on every redirect hop. |

## 1b. Web search

With nothing configured, `web_search` queries DuckDuckGo — keyless, no setup,
real ranked results.

DuckDuckGo rate-limits automated queries, so Cinderpaw **paces** them: at most one
every 5 seconds (`CINDERPAW_DDG_MIN_INTERVAL_MS`), serialised, so parallel tool
calls queue instead of bursting. That gap is what keeps the backend working —
measured from one IP, 12 queries back-to-back got 7 served and then a
ten-minute block, while the same queries paced 3, 5 or 10 seconds apart all
succeeded. If the limiter is tripped anyway, Cinderpaw backs off for two minutes
and says so (`rate_limited`) rather than pretending the web went empty.

The limit is per-IP, so everything else on your connection shares it. Raise the
interval if you see `rate_limited`; about 3s is the floor.

The cost of that pacing is latency: a research loop doing eight searches spends
about 40 seconds waiting. If that bothers you, or you search heavily, run
[SearXNG](https://docs.searxng.org/) — a self-hosted metasearch aggregator:
several engines at once, no rate limit, no pacing delay, no API key, no
per-query cost, and the queries never leave your machine, which is the point of
a local-first agent.

```bash
docker run -d --name searxng -p 8888:8080 \
  -e SEARXNG_BASE_URL=http://127.0.0.1:8888/ \
  searxng/searxng
```

Then enable the JSON API — **SearXNG ships with it off**, and without this every
search returns HTTP 403:

```yaml
# in the container's /etc/searxng/settings.yml
search:
  formats:
    - html
    - json
```

Restart it, then point Cinderpaw at it:

```bash
export CINDERPAW_SEARXNG_URL=http://127.0.0.1:8888
```

If a configured SearXNG is unreachable or misconfigured, `web_search` falls back
to DuckDuckGo and says so in the result — a working search beats a dead tool, but
a backend that has been down for a week should not be invisible either.

## 2. The `WORKSPACE` trap

There are **two** env vars with confusingly similar names. They are
**not** the same thing and are read by different runtimes:

| Var | Runtime | Type | Default | Effect |
|---|---|---|---|---|
| `CINDERPAW_AGENT_WORKSPACE` | Rust host (`crates/cinderpaw-core`) | single absolute path | unset | Sidecar-internal Rust tools (e.g. raw FS access) accept absolute paths only under this single root. |
| `CINDERPAW_WORKSPACE` | TS sidecar (`CinderpawAgent/src/boot.ts` `loadWorkspaceRoots`) | path-list | launch cwd + home + scratch | Write tools and the agent's filesystem exposure are rooted at this list, plus an automatic scratch dir. `~/.cinderpaw`/`~/.ssh`/`CINDERPAW_FS_DENY` are denied at call time regardless. |

If you set one and meant the other, the agent will fail in confusing
ways (Rust tools will deny paths the TS sidecar allowed, or vice versa).
Set both deliberately.

The TS loader **refuses to include any path that would expose
`~/.cinderpaw/`** (and a few other self-protection walls). See
`CinderpawAgent/src/workspace-roots.ts` for the canonical list of dropped
roots.

## 3. Var reference — by domain (TS sidecar)

This table is generated from `CinderpawAgent/src/config.ts`'s `CONFIG_SCHEMA` by
`scripts/gen-config-docs.mjs`. Run that script after adding a schema row;
`scripts/check-env-docs.mjs` fails if this section drifts from the schema.
Vars not yet migrated to `config.ts` getters are still read directly via
`process.env.CINDERPAW_*` at their call sites (see `CinderpawAgent/tests/config.test.ts`'s
grandfathered list) but are documented here regardless, since the schema
covers every TS-side var, migrated or not.

Rust-side vars (`CINDERPAW_ENABLE_CODE_EXEC`, `CINDERPAW_AGENT_WORKSPACE`,
`CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS`'s host-side enforcement,
`CINDERPAW_MAX_LOCAL_CONTEXTS`, `CINDERPAW_MODEL_WAIT_MS`, `CINDERPAW_FORCE_SIDECAR_BUILD`,
`CINDERPAW_SKIP_SIDECAR_BUILD`, `CINDERPAW_SMOKE_GGUF`, `CINDERPAW_FMS_BENCH`, `CINDERPAW_E2E`,
`CINDERPAW_DISCORD_CLIENT_ID`, `CINDERPAW_STT_PROBE` (a `.webm` path for the ignored
`probe_whisper_prompt` test, which re-transcribes one stored recording with and
without the vocabulary prompt — the open question of why English speech
occasionally comes back as fluent Romanian), and others in `crates/cinderpaw-core` /
`src-tauri/src`)
are NOT read by `CinderpawAgent/src` and so are out of scope for `config.ts`;
they remain hand-maintained here and are still covered by
`scripts/check-env-docs.mjs`'s full-source drift check.

<!-- TS-SCHEMA-TABLE -->
<!-- AUTO-GENERATED by scripts/gen-config-docs.mjs from CinderpawAgent/src/config.ts. Do not hand-edit this section. -->

| Var | Type | Default | Security | Description |
|---|---|---|---|---|
| `CINDERPAW_DB_KEY` | string | `null` | yes | 32-byte base64 key for at-rest encryption of sensitive DB columns. Anyone who can read this can read the DB. |
| `CINDERPAW_WORKSPACE` | list | `null` | yes | TS sidecar path-list of FS roots. Unset = launch cwd + the user's home dir (broad by default; set to RESTRICT). The call-time deny wall (tool-permissions.ts) protects ~/.cinderpaw, ~/.ssh and CINDERPAW_FS_DENY regardless of roots. |
| `CINDERPAW_FS_DENY` | list | `null` | yes | Extra comma/semicolon-separated paths the fs tools may never touch, on top of the built-in ~/.cinderpaw + ~/.ssh deny wall. |
| `CINDERPAW_ENABLE_SHELL_EXEC` | bool | `true` | yes | Registers shell_exec (argv-only, whitelisted). On by default; set to "false" to disable. Doc note: an earlier draft of this doc said default off — the code's actual default is ON. |
| `CINDERPAW_ENABLE_NOTEBOOK` | bool | `true` | yes | Registers `notebook`, a persistent JavaScript interpreter with every other tool bound as an async function, so the agent can compose tool calls in code instead of one per turn. ON by default since 2026-08-26: it is the largest measured lever on token cost, because two tool calls in one cell is ONE completion instead of two, and every completion re-sends ~10.7k tokens of schema + system prompt. Set to "false" to disable. Cells run in an isolated vm context with no ambient fetch/process/require, and every capability still goes through the tool registry and its permission checks — but it is a hardened context, not a jail against hostile input, which is why it is OWNER-ONLY: any session running under a profile (connector persona, WhatsApp public mode, a cowork teammate) is refused it at both the advertise and the execute gate. See tools/tiers.ts::OWNER_ONLY_TOOLS. |
| `CINDERPAW_HOST_TOOLS` | string | `null` | yes | Path to a JSON file of tools the HOST will execute, in MCP's `{tools:[{name,description,inputSchema}]}` shape. When set, the agent calls these by name and the sidecar emits a `tool_request` event, suspending the call until the host answers with `tool_response` — so the host, not the agent, performs the action. Needed wherever the host owns the state being acted on and must record the call itself: tau2-bench grades a fresh environment replayed from ITS transcript, so a tool the harness never saw did not happen. Setting it also flips tool tiering — the host's tools are what get advertised and the built-ins move behind the on-demand drawer (list_tools/load_tool still reach every one of them), because a host that declares a tool set is declaring the job; measured on tau2's airline domain that cut the per-completion prefix from 16.5k to 10.8k tokens. Unset (the default, and every normal install) registers nothing and costs nothing. Not a sandbox escape: the host process spawned this one and already has everything it has. |
| `CINDERPAW_ENABLE_DESKTOP_CONTROL` | bool | `false` | yes | Registers control_app (OS accessibility-tree control). Off by default; set to "true" to enable. |
| `CINDERPAW_DESKTOP_CONTROL_CONFIRM` | bool | `true` | yes | Per-action confirmation dialog for control_app writes. On by default; set to "false" to disable (inverse-toggle var — see report for why this call site is not migrated to cfgBool). |
| `CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK` | bool | `false` | yes | Sidecar-internal escape hatch: when true, a transport with no askUser bridge may proceed without confirmation instead of failing closed. |
| `CINDERPAW_FORGE_NO_PROMPT_OK` | bool | `false` | yes | Sidecar-internal escape hatch: when true, tool_forge may create/update a tool on a transport with no askUser bridge instead of failing closed. This approves running agent-written code unattended — headless deployments only. |
| `CINDERPAW_PERMISSION_MODE` | string | `null` | yes | What the agent is allowed to change: "read_only" (reads anything, writes nothing — no file writes, no destructive/machine-level commands; the mode for audits and for surfaces where the speaker is not the owner), "workspace_write" (default: writes inside the workspace roots, where the safety point can undo them), or "full_access" (guards that prevent mistakes step aside; the catastrophic denylist still applies). Resolution order: this var, then CINDERPAW_SHELL_WHITELIST="*" (which still means full access), then `permission_mode` in ~/.cinderpaw/settings.json, then the default. The settings.json route is the only one that needs no relaunch — the sidecar reads it per command, so a change applies to the next one; an unknown value or an unparseable file means "not configured", never "deny everything". |
| `CINDERPAW_AUTONOMOUS` | bool | `false` | yes | Walk-away mode: ask_user does not block for a human. It takes the recommended option (or the first) immediately and logs the decision, so a long task runs unattended. The end-of-turn summary reports every auto-decision. Off by default. |
| `CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS` | list | `null` | yes | Comma-separated allowlist of app names control_app may target. Empty = fail closed. (Read by the Rust host, not CinderpawAgent/src.) |
| `CINDERPAW_FETCH_DOMAINS` | list | `null` | yes | Comma-separated domain allowlist for fetch_url. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT. |
| `CINDERPAW_HTTP_DOMAINS` | list | `null` | yes | Comma-separated domain allowlist for http_request. Unset = all public hosts (SSRF guard, rate limit and audit still apply); set to RESTRICT. |
| `CINDERPAW_EXTERNAL_WRITE_BUDGET` | int | `50` | yes | How many STATE-CHANGING external requests (POST/PUT/PATCH/DELETE) one session may make before the egress proxy stops it. Bounds a runaway loop that keeps changing things outside this machine — ad spend, published posts, CRM rows — during an unattended run. It caps VOLUME, not severity: one wrong write is inside any budget. 0 disables the cap. |
| `CINDERPAW_DRY_RUN` | bool | `false` | yes | Log every STATE-CHANGING external request (POST/PUT/PATCH/DELETE) and do NOT send it. The agent is told the call was a dry run rather than handed a fake success, so it cannot build its next step on a write that never happened. The honest first run against a real ad or social account: let it do the whole task, then read exactly what it would have changed. |
| `CINDERPAW_WRITE_CONFIRM_HOSTS` | list | `null` | yes | Hosts whose STATE-CHANGING requests are REFUSED while running unattended (CINDERPAW_AUTONOMOUS). Reads are unaffected. Declared by the operator, never by the model — this is the guard that does not depend on the agent realising a call is expensive. Deliberately a human-declared list rather than built-in patterns for known money endpoints: a pattern list fails open for every API not on it while reading as though everything is covered. |
| `CINDERPAW_TRUSTED_LOCAL_ORIGINS` | list | `null` | yes | Comma-separated exact origins (scheme+host+port) on loopback/private addresses that the SSRF guard may reach, for services the OPERATOR runs themselves. Exact-origin match only — trusting http://127.0.0.1:8080 does not trust any other local port — and the tool's own allowedDomains still applies. Extends the single CINDERPAW_SEARXNG_URL exemption to any self-hosted backend. |
| `CINDERPAW_TOOL_ALLOWED_DOMAINS` | list | `null` | yes | Set BY the sidecar ON a forged tool's child process — not something a user configures. Carries the hostnames that tool declared via tool_forge's `allowed_domains`; the runner turns it into an EgressProxy-backed globalThis.fetch, so a tool that declared nothing has no network. Setting it in the parent environment has no effect: createCustomTool always overwrites it from the tool's own record. |
| `CINDERPAW_TRUSTED_BASE_URLS` | list | `null` | yes | Extra base URLs the inference router may call beyond loopback. |
| `CINDERPAW_SHELL_WHITELIST` | list | `null` | yes | RESTRICTS shell_exec to a named set of binaries (e.g. "git,node"). Unset means any binary, which is the default: the old default list had the OS shells on it, so `sh -c "…"` ran anything anyway and the list only failed direct calls to unlisted tools like ffmpeg or docker. "*" is accepted as the historical spelling of "no restriction" and additionally selects full_access (see CINDERPAW_PERMISSION_MODE). |
| `CINDERPAW_SHELL_PATH_EXTRA` | list | `null` | yes | Extra directories appended to the PATH every spawned child sees, on top of the well-known install locations (Git bin, nodejs, npm global on Windows; /usr/local/bin, homebrew, ~/.local/bin, ~/.bun/bin, ~/.cargo/bin elsewhere). Needed because the agent inherits whatever PATH launched the gateway, so a tool a terminal finds can be invisible here — that is what made `bash` fail with a permissions-sounding error. Appended, never prepended, so it cannot change which binary an already-working call resolves to. Directories that do not exist are ignored. |
| `CINDERPAW_SHELL_DENYLIST` | list | `null` | yes | Overrides the built-in shell_exec denylist (dangerous binaries refused even in YOLO mode). |
| `CINDERPAW_PROACTIVE_ENABLED` | bool | `false` | yes | Master enable for the proactive/mood-engine loop. |
| `CINDERPAW_INNER_THOUGHTS_ENABLED` | bool | `false` | yes | Sub-flag enabling the inner-thoughts loop. |
| `CINDERPAW_MODEL` | string | `"qwen2.5:7b"` |  | Model id sent to the inference provider. |
| `CINDERPAW_PROVIDER` | string | `"openai_compatible"` |  | Provider family adapter to use. |
| `CINDERPAW_BASE_URL` | string | `"http://127.0.0.1:11435"` |  | Inference base URL the sidecar points at. |
| `CINDERPAW_API_KEY` | string | `null` |  | Bearer token for the primary provider. |
| `CINDERPAW_BYOK_PROVIDER` | string | `null` |  | Wizard-saved BYOK provider id; RSI's live-router model id falls back to this. |
| `CINDERPAW_LOCAL_BASE_URL` | string | `null` |  | Loopback address of the bundled local engine, set by the host. Used ONLY as the degrade-to-local fallback when the primary is a cloud provider; ignored when not loopback. |
| `CINDERPAW_LOCAL_MODEL` | string | `null` |  | Model id the bundled local engine serves (fallback target companion to CINDERPAW_LOCAL_BASE_URL). |
| `CINDERPAW_LOCAL_API_KEY` | string | `null` | yes | Bearer token for the loopback local engine (the host's local API token). |
| `CINDERPAW_RATE_LIMIT_RPM` | int | `0` |  | Requests-per-minute cap applied to every inference endpoint, overriding the built-in published caps (NVIDIA NIM free tier = 40). 0 uses those defaults. Set this if you are on a paid tier with a different limit, or share one API key with something outside Cinderpaw. |
| `CINDERPAW_FALLBACK_PROVIDER` | string | `"ollama"` |  | Provider to fall back to if the primary is unreachable. |
| `CINDERPAW_FALLBACK_MODEL` | string | `null` |  | Model to fall back to. |
| `CINDERPAW_FALLBACK_BASE_URL` | string | `"http://localhost:11434"` |  | Base URL for the fallback provider. |
| `CINDERPAW_FALLBACK_API_KEY` | string | `null` |  | Bearer token for the fallback provider. |
| `CINDERPAW_OLLAMA_NUM_CTX` | int | `null` |  | Override Ollama's num_ctx. |
| `CINDERPAW_MAX_CONTEXT` | int | `8192` |  | Hard ceiling on context length the router allows. |
| `CINDERPAW_SHELL_MAX_TIMEOUT_MS` | int | `300_000` | yes | Ceiling on shell_exec's per-call timeout_ms (clamped to 60s..60min). Raise it when a real build — cargo, gradle, a cold docker layer — legitimately runs past 5 minutes; the process is hard-killed at this bound and the agent cannot tell that apart from a genuine failure. |
| `CINDERPAW_TURN_BUDGET_MS` | int | `1_200_000` |  | Wall-clock budget for ONE agent turn (clamped to 60s..6h). The iteration ceiling bounds tool-call count, not time; this bounds time. Only stops NEW iterations, so an in-flight tool is never cut off. Matters most on connectors, which have no Stop button. |
| `CINDERPAW_SUMMARY_EXCERPT_CHARS` | int | `24_000` |  | Characters of the compacted transcript fed to the working-memory summarizer (head+tail sampled). Raise on big-context models so long tool-heavy tasks keep more detail in the summary note. |
| `CINDERPAW_UNATTENDED_CONTINUATIONS` | int | `24` |  | Automatic continuations allowed after a turn hits the wall-clock budget during an UNATTENDED run (cron job, or a connector message answered while nobody is watching). 0 disables continuation and restores the old behaviour, where a long task simply stopped half-done and was reported as finished. Total wall clock is roughly (this + 1) x CINDERPAW_TURN_BUDGET_MS, additionally capped by CINDERPAW_MISSION_DEADLINE_MS, and by CINDERPAW_CRON_JOB_TIMEOUT_MS for cron. The default of 3 was a ceiling nobody chose: (3+1) x 20min is 80 minutes, which was recorded for weeks as an observed limit on how long the agent could work before someone read the arithmetic. It is sized at the deadline now, so the counter is the safety net and the deadline is the term. |
| `CINDERPAW_MISSION_DEADLINE_MS` | int | `28_800_000` |  | Wall-clock deadline for a whole UNATTENDED run, across all its continuations. Default 8 hours — a working day, which is the promise: give it a task, leave, come back to it done. 0 means no deadline at all, which is NOT the safe setting: the counter above is a counter, not a term, and without a deadline a wedged run keeps its whole continuation budget to burn tokens in. Checked between turns, so an in-flight turn is never cut off — the real stop time can overrun by up to one turn budget. |
| `CINDERPAW_ATTACHMENT_MAX_CHARS` | int | `12_000` |  | Characters kept from ONE inbound attachment (a .txt/.md/code file, or the text extracted from a PDF) before it is truncated into the prompt. The default is sized for an 8k local context; raise it on a big-context cloud model so a whole document arrives in one message instead of a head slice. |
| `CINDERPAW_TOOL_GRAMMAR` | string | `null` |  | Optional GBNF grammar to constrain tool-call output. Presence alone also toggles useToolGrammar (default on; set to literal "false" to disable — inverse-toggle var, not migrated). |
| `CINDERPAW_VERSION` | string | `null` |  | Reported in startup logs; set by installer. |
| `CINDERPAW_EMBED_GPU_LAYERS` | int | `null` |  | Embedding-model layers offloaded to GPU. 0 = CPU-only. |
| `CINDERPAW_EMBED_MODEL` | path | `null` |  | Path to the embed GGUF; auto-discovered when unset. |
| `CINDERPAW_EMBED_CHUNK` | int | `null` |  | Embedder input chunk size (tree-builder.ts). |
| `CINDERPAW_BUDGET_CONVERSATION` | int | `5_000_000` |  | Per-conversation token ceiling. |
| `CINDERPAW_BUDGET_DAY` | int | `50_000_000` |  | Per-day token ceiling. |
| `CINDERPAW_BUDGET_POLICY` | string | `"compress_and_continue"` |  | "stop" or "compress_and_continue". |
| `CINDERPAW_RSI_MAX_COST_USD` | string | `null` |  | RSI background USD cap (float). Unset = local-only. |
| `CINDERPAW_CLOUD_TRANSCRIPT_BUDGET` | int | `200_000` |  | Cloud-specific transcript-size budget (AgentLoop.CLOUD_TRANSCRIPT_BUDGET fallback). |
| `CINDERPAW_TTFT_DEADLINE_MS` | int | `null` |  | Time-to-first-token cap (perf-policy.ts, positive int only). |
| `CINDERPAW_TOTAL_DEADLINE_MS` | int | `null` |  | Whole-completion cap. |
| `CINDERPAW_STALL_MS` | int | `null` |  | Inter-token stall cap; wins over CINDERPAW_CLOUD_IDLE_TIMEOUT_MS when both set. |
| `CINDERPAW_CLOUD_IDLE_TIMEOUT_MS` | int | `60_000` |  | Legacy cloud-only idle-stream timeout back-compat knob. |
| `CINDERPAW_FMS_MAX_LEAVES` | int | `null` |  | Cap on the FMS leaf store size. |
| `CINDERPAW_FMS_DEDUP_SPAN_MS` | int | `30 * 24 * 60 * 60 * 1000` |  | Minimum age gap between two near-identical memories before the cross-session pass will collapse them. It is a floor, not a window: leaves recorded FURTHER APART than this merge, and recent ones deliberately do not, because the per-write cosine merge already handles same-session duplicates. Raise it to keep more separate copies of a fact, lower it to collapse more aggressively. The old description said "whose last touch is within this window", which is the opposite of what the code does and of what the pass is for. |
| `CINDERPAW_FMS_MERGE_THRESHOLD` | string | `"0.92"` |  | Cosine threshold (float) above which leaves merge. |
| `CINDERPAW_FMS_EVICTION` | string | `null` |  | Eviction strategy. Only "none" (or "noeviction") is a real choice: it turns eviction off. Anything else, including the "lru" this line used to give as its example, selects the default age-and-hit-count policy — a value that is not understood now says so on stderr and falls back, instead of being silently ignored. |
| `CINDERPAW_MERGE_THRESHOLD` | string | `null` |  | Deprecated alias for CINDERPAW_FMS_MERGE_THRESHOLD. Both names now feed BOTH merge paths (the per-write cosine merge and the cross-session dedup pass); until 2026-09-02 they fed one each, so setting the canonical name moved one threshold and left the other at its default, in the same process, with nothing on screen to say so. |
| `CINDERPAW_FMS_QUERY_TOPK` | int | `20` |  | Semantic candidates the tree descent returns before re-rank. Raising it widens what recall can consider, at more cosine work per query. |
| `CINDERPAW_FMS_QUERY_BEAM` | int | `20` |  | How many tree nodes survive at each level of the descent, and so the primary control on recall versus tail latency. At 2700 memories and branch 8 the first level holds ~338 clusters, so the default of 20 discards roughly 94% of the corpus before any single memory is scored: that is what makes the search cheap, and it is also its recall ceiling. Never applied below CINDERPAW_FMS_QUERY_TOPK, since a narrower beam would silently truncate the result rather than shrink the search. |
| `CINDERPAW_TREE_BRANCH` | int | `null` |  | Branching factor for fractal tree build. |
| `CINDERPAW_TREE_CLUSTER_MAX_CHARS` | int | `null` |  | Max cluster size in chars. |
| `CINDERPAW_TREE_ITEM_MAX_CHARS` | int | `null` |  | Max item size in chars. |
| `CINDERPAW_PII_REDACTION` | string | `"on"` |  | Master switch for PII redaction in memory writes; "off" disables (inverse-toggle var). |
| `CINDERPAW_JINA_API_KEY` | string | `null` |  | Jina Reader key for read_webpage / deep_research. |
| `CINDERPAW_SEARXNG_URL` | string | `null` | yes | Base URL of a SearXNG instance backing web_search (e.g. http://127.0.0.1:8888). A loopback/private origin here is trusted by the egress SSRF guard for web_search ONLY — set it only to an instance you run. |
| `CINDERPAW_DDG_MIN_INTERVAL_MS` | int | `5000` |  | Minimum gap between DuckDuckGo queries on the keyless web_search fallback. DDG throttles by rate, not volume: measured from one IP, 12 back-to-back queries got 7 served then a >10min anti-bot block, while the same queries paced 3s/5s/10s apart all succeeded. The limit is per-IP and shared with everything else on the connection, so raise this if you see rate_limited; ~3s is the floor. 0 disables pacing. Ignored when CINDERPAW_SEARXNG_URL is set. |
| `CINDERPAW_RSI_PASSIVE` | bool | `true` |  | RSI supervisor passive mode. "false" disables (read via injected env in passive-supervisor.ts). |
| `CINDERPAW_RSI_ALLOW_CLOUD` | bool | `false` |  | Opt-in: allow RSI to call cloud providers (anti-burn guard). |
| `CINDERPAW_RSI_MAX_ITER` | int | `null` |  | Pin the episode iteration cap; unset = dynamic (genome/policy-derived). |
| `CINDERPAW_RSI_MAX_TOKENS` | int | `null` |  | Per-call token cap for RSI evaluations. |
| `CINDERPAW_RSI_EVAL_TOKEN_BUDGET` | int | `null` |  | Per-eval token budget in rsi/sidecar.ts. |
| `CINDERPAW_RSI_CONCURRENCY` | int | `1` |  | Concurrent RSI evaluations. |
| `CINDERPAW_RSI_COOLDOWN_MS` | int | `600_000` |  | Quiet period after a successful iteration. |
| `CINDERPAW_RSI_IDLE_MS` | int | `180_000` |  | Quiet period before RSI wakes up. |
| `CINDERPAW_RSI_POLL_MS` | int | `null` |  | Manual poll cadence override. |
| `CINDERPAW_RSI_ERROR_THRESHOLD` | int | `3` |  | Consecutive error count that triggers a sleep. |
| `CINDERPAW_RSI_ERROR_WINDOW_MS` | int | `900_000` |  | Sliding window for the error counter. |
| `CINDERPAW_RSI_EPISODE_MS` | int | `null` |  | Max wall-clock per episode. |
| `CINDERPAW_RSI_PLATEAU_ITERS` | int | `null` |  | Iters-with-no-improvement before RSI bails. |
| `CINDERPAW_RSI_MAX_UNANSWERED_RATIO` | string | `"0.5"` |  | Fraction of evaluations that may come back with no gradable answer before the episode is stopped. Evolution needs measurements; when most of the suite goes unanswered the engine is comparing genomes on questions none of them answered, and every token after that is wasted. Set to 1 to disable the breaker. |
| `CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE` | int | `8` |  | Evaluations that must run before the unanswered-response breaker can trip, so a couple of unlucky calls at the start of an episode cannot abort it. |
| `CINDERPAW_RSI_SCHEDULE_MS` | int | `null` |  | Force a fixed schedule (e.g. weekly wake). |
| `CINDERPAW_RSI_STAGNATION_THRESHOLD` | int | `null` |  | Hard stagnation threshold. |
| `CINDERPAW_RSI_STOP_ON_ACTIVITY` | bool | `false` |  | Pause RSI when the user is active. |
| `CINDERPAW_RSI_TELEMETRY` | path | `null` |  | Telemetry JSONL file path override (default ~/.cinderpaw/rsi/dream.jsonl). Type is a path, not a bool — the existing doc mislabeled it as a bool switch. |
| `CINDERPAW_CODE_RSI_REPO` | path | `null` |  | Source repo for code-RSI to propose/apply against; without it, code-RSI rounds and live-apply are unavailable. |
| `CINDERPAW_MODULE_SEED` | int | `1` |  | Deterministic seed for module selection (module-host.ts). |
| `CINDERPAW_CRON_TICK_MS` | int | `30_000` |  | Tick interval for the cron scheduler. |
| `CINDERPAW_CRON_JOB_TIMEOUT_MS` | int | `3_600_000` |  | Max wall-clock for a single cron job, and the deadline handed to its unattended run. The old default of 5 minutes predates the agent doing multi-step work on a reasoning model, where one completion alone can take two: a scheduled job was cut off mid-task and the partial recorded as the result. One hour leaves room for a real job while still bounding a wedged one far below the mission deadline. Raise it for a scheduled overnight mission. |
| `CINDERPAW_HEARTBEAT_INTERVAL_MS` | int | `30_000` |  | Watchdog / liveness heartbeat cadence. |
| `CINDERPAW_THOUGHTS_COOLDOWN_MS` | int | `14_400_000` |  | Quiet period between thoughts (4h). |
| `CINDERPAW_THOUGHTS_MIN_IDLE_MS` | int | `600_000` |  | User must be idle this long before a thought fires (10m). |
| `CINDERPAW_THOUGHTS_INTERVAL_MS` | int | `120_000` |  | Wake-and-evaluate cadence (2m). |
| `CINDERPAW_THOUGHTS_DAILY_CAP` | int | `3` |  | Hard cap on thoughts per user-day. |
| `CINDERPAW_THOUGHTS_MOOD_THRESHOLD` | string | `"0.5"` |  | Mood gate (float); thoughts fire only above this score. |
| `CINDERPAW_BRAIN` | bool | `false` |  | Force-enable Brain Stack; if brain.json is missing, loadBrainConfig throws (read via injected env in brain-config.ts). |
| `CINDERPAW_HOME` | path | `null` |  | Override the agent's profile dir (default ~/.cinderpaw/, resolved via homedir() when unset). |
| `CINDERPAW_BENCHMARK_RUN_ID` | string | `null` | yes | Turns on BENCHMARK MODE for this process. Two effects, both about keeping one measured run from contaminating the next: (1) the profile dir moves to <home>/runs/<runId>/, so skills, memory, journals and DB from run N are invisible to run N+1 (invariant I13); (2) the network is restricted to CINDERPAW_BENCHMARK_ALLOW_HOSTS and nothing else — every other destination is refused at both network exits (tool egress proxy and inference router). Unset = off, normal behaviour. Must be path-safe (letters, digits, dot, underscore, hyphen). |
| `CINDERPAW_BENCHMARK_ALLOW_HOSTS` | list | `null` | yes | The ONLY hosts reachable while benchmark mode is on. Comma/semicolon separated, matched like a domain allowlist ("api.example.com" matches that host and its subdomains). Ignored when CINDERPAW_BENCHMARK_RUN_ID is unset. Empty while benchmark mode is on means NOTHING is reachable — deliberately fail-closed, and every refusal names this variable so the fix is on screen rather than in a log. |
| `CINDERPAW_DB` | path | `"<profile>/data/cinderpaw.db"` |  | Override the SQLite DB path. Defaults to data/cinderpaw.db INSIDE the profile dir (CINDERPAW_HOME, ~/.cinderpaw by default), so the database follows the profile rather than the working directory; it used to default to a relative path resolved against the cwd, which gave a standalone CLI a separate database per directory it was started from. A relative value set here is still resolved against the cwd, because that is what typing a relative path means. ":memory:" is a sentinel and is not path-resolved. Falls back to a pre-rename data/feral.db when that is the file this install actually has. |
| `CINDERPAW_AGENT_BASE_PROMPT` | string | `null` |  | Universal operating manual injected into every model call; usually bundled. |
| `CINDERPAW_OPENROUTER_PROVIDER` | string | `null` |  | Pin OpenRouter routing to a comma-separated list of endpoints, in preference order, with `allow_fallbacks: false` — routing may move within the list and may never leave it. One model id is served by many endpoints running different quantisations of the same weights, so the model id alone does not say which model answered; unpinned routing swung identical tau2 runs by 40 points. A single name is a single point of failure (measured 2026-09-02: one endpoint answered a third of its probes, and a task scored zero on a 429 from it), so name a primary and one or two as a net. Which endpoint actually served each call is reported back, so a fallback is a declared fact rather than a silent confound. Ignored unless the base URL is openrouter.ai; unset is right for ordinary use, where falling back freely is what keeps the agent answering. |
| `CINDERPAW_SHUTDOWN_FLUSH_MS` | int | `8000` |  | How long a shutdown may spend writing what the last turn learned before the database closes. Memory extraction waits for the agent to be idle, which never arrives in a short-lived process (a cron job, a connector reply, a benchmark task), so without this the lesson dies with the process. Bounded because the caller kills us shortly after asking: a shutdown that hangs loses more than the lesson it was saving. 0 disables the flush. |
| `CINDERPAW_RECALL_INJECTION` | bool | `true` |  | Look memory up for the agent on every turn and put the hits in the prompt, instead of waiting for the model to call the `recall` tool. Off restores the old behaviour, where a run that never called the tool never read memory at all. |
| `CINDERPAW_RECALL_INJECTION_MAX_CHARS` | int | `4000` |  | Cap on the injected recall block. A similarity search has no natural bound on how much it can match, so the block is cut on a line boundary at this size. |
| `CINDERPAW_SUBAGENT_MAX_SUMMARY_CHARS` | int | `4000` |  | Cap on subagent summary length returned to parent (negative = unlimited). |
| `CINDERPAW_ENABLE_SUBAGENTS` | bool | `true` |  | Set `false` to withhold the `delegate_task` tool entirely. Each subagent spends its own model budget, so a run with a hard cost ceiling needs the capability gone, not discouraged — the model decides to delegate on its own. Withholds the TOOL only; `rlm()` still uses the same Subagent machinery. |
| `CINDERPAW_MAX_COWORKERS` | int | `null` |  | Cap on roster size for `cowork_create_teammate`. Unset = no cap. Every teammate runs its own loop on its own budget, so on a metered run the roster size is the cost multiplier. `0` forbids teammates outright. |
| `CINDERPAW_LORA_TRAINER_BIN` | path | `null` |  | Absolute path to the trainer binary. |
| `CINDERPAW_LORA_TRAIN_TIMEOUT_MS` | int | `null` |  | Wall-clock cap on a single trainer invocation. |
| `CINDERPAW_RUN_FRACTAL_BENCH` | bool | `false` |  | Run the fractal benchmark as part of boot. |
| `CINDERPAW_FRACTAL_BENCH_COUNT` | int | `50` |  | Benchmark corpus size. |
| `CINDERPAW_FRACTAL_BENCH_SEED` | int | `1` |  | Benchmark RNG seed. |
| `CINDERPAW_FRACTAL_BENCH_QUERIES` | path | `null` |  | Override the benchmark query set. |
| `CINDERPAW_FRACTAL_BENCH_MAX_LEAVES` | int | `0` |  | Cap the benchmark/dev fractal-memory leaf-store size (0 = unlimited / full corpus). |
| `CINDERPAW_NO_COLOR` | bool | `false` |  | Disable ANSI colour output in the TUI. |
<!-- /TS-SCHEMA-TABLE -->

## 3b. Public journal (outbound telemetry)

Read by `src/public-journal/exporter.ts`, which publishes a sanitized slice of
the Evolution Journal to a public page (see `docs/public-journal.md`). All of it
is **opt-in**: with `CINDERPAW_PUBLIC_JOURNAL_URL` and `CINDERPAW_PUBLIC_JOURNAL_TOKEN`
unset, the exporter refuses to start and nothing leaves the machine.

| Var | Type | Default | Notes |
| --- | ---- | ------- | ----- |
| `CINDERPAW_PUBLIC_JOURNAL_URL` | url | unset | Ingest endpoint. Must be `https:` unless the host is `localhost`/`127.0.0.1` — the exporter refuses to send its bearer token in the clear. |
| `CINDERPAW_PUBLIC_JOURNAL_TOKEN` | string | unset | Shared secret for that endpoint. The endpoint maps token → publisher identity; the payload cannot choose its own. |
| `CINDERPAW_PUBLIC_JOURNAL_PUBLISHER` | enum | `cubby` | `cubby` (this private instance) or `paw` (the community bot). Must match what the token is registered as. |
| `CINDERPAW_PUBLIC_JOURNAL_DIR` | path | `paths().journalDir` | Journal directory to export from. Override for testing against a fixture. |
| `CINDERPAW_PUBLIC_JOURNAL_LIMIT` | int | `200` | Max events per run. A backlog drains over successive runs. |
| `CINDERPAW_PUBLIC_JOURNAL_VERSION` | string | unset | Version string reported in the heartbeat. Dropped unless it matches `[0-9A-Za-z.\-+]{1,24}`. |

## 3c. Voice call (set by the host, not by you)

The desktop host spawns the LiveKit voice agent as a child process and hands it
its whole configuration through the environment. These are listed here because
they exist and a reader will meet them in a process list or a crash log — not
because they are knobs. Setting them by hand in your own shell does nothing:
the host overwrites every one of them when it starts the call.

The one exception worth knowing is `CINDERPAW_LIVE_PIPELINE=1`, which selects
the STT→LLM→TTS pipeline over the provider's native realtime API; the host sets
it from the voice settings in the app.

| Var | Set by | Notes |
| --- | ------ | ----- |
| `CINDERPAW_LIVE_PROVIDER` | `livekit.rs` | Realtime provider id for the call. |
| `CINDERPAW_LIVE_API_KEY` | `livekit.rs` | That provider's key, passed to the child only. |
| `CINDERPAW_LIVE_MODEL` | `livekit.rs` | Model the call runs on. |
| `CINDERPAW_LIVE_VOICE` | `livekit.rs` | Voice id. |
| `CINDERPAW_LIVE_INSTRUCTIONS` | `livekit.rs` | The system brief for the call. |
| `CINDERPAW_LIVE_TOOLS` | `livekit.rs` | JSON tool declarations the voice agent may call. |
| `CINDERPAW_LIVE_PIPELINE` | `livekit.rs` | `1` = STT→LLM→TTS pipeline instead of a native realtime API. |
| `CINDERPAW_LIVE_TTS_ENGINE` | `livekit.rs` | Pipeline mode only. Default `piper`. |
| `CINDERPAW_LIVE_STT_MODEL` | `livekit.rs` | Pipeline mode only. Default `small`. |
| `CINDERPAW_LIVE_STT_PROVIDER` | `livekit.rs` | Pipeline mode only. Default `local`. |
| `CINDERPAW_LIVE_STT_LANGUAGE` | `livekit.rs` | Pipeline mode only. Empty = autodetect. |
| `CINDERPAW_LIVE_LANGUAGE` | `livekit.rs` | The app's own language, two letters. What the voice agent says on its own (the line it keeps warm during a tool call) is said in it. Empty = English. |
| `CINDERPAW_WORKER_PORT` | `livekit.rs` | Port the voice worker listens on. |
| `CINDERPAW_API_URL` | `livekit.rs` | Local gateway URL the voice agent calls back into. |
| `CINDERPAW_API_TOKEN` | `livekit.rs` | Token for that callback. Never leaves the machine. |
| `CINDERPAW_EVENT` | host/CLI | Event name passed to a spawned hook process. |
| `CINDERPAW_DREAMS_ENABLED` | `boot.ts` | Whether the idle dream loop starts. |

## 4. Footnotes

- *"Positive integer only"* means the perf-policy reader parses a
  `u64` and rejects zero and non-numeric strings. See
  `crates/cinderpaw-core/src/perf_policy.rs::read_env_optional`.
- *"Must be absolute"* — `CINDERPAW_AGENT_WORKSPACE` only accepts absolute
  paths; relative paths log a warning and the value is ignored.
- All defaults reflect a *single-user, fully-local* install. The
  security group (§1) is the override surface for any multi-tenant or
  shared-host deployment.
- For the inference side, `provider(model, baseUrl, apiKey)` wins
  over `CINDERPAW_*` when set explicitly via wizard/state. Treat the env
  vars as bootstrap-only on the wizard path.

---

<!-- The fenced block below is the canonical list. The check script
     parses ONLY this block; do not list vars anywhere else in this
     file without mirroring them here. -->

```cinderpaw-env-vars
CINDERPAW_AGENT_BASE_PROMPT
CINDERPAW_AGENT_WORKSPACE
CINDERPAW_API_KEY
CINDERPAW_API_TOKEN
CINDERPAW_API_URL
CINDERPAW_ATTACHMENT_MAX_CHARS
CINDERPAW_AUTONOMOUS
CINDERPAW_BASE_URL
CINDERPAW_BENCHMARK_ALLOW_HOSTS
CINDERPAW_BENCHMARK_RUN_ID
CINDERPAW_BRAIN
CINDERPAW_BUDGET_CONVERSATION
CINDERPAW_BUDGET_DAY
CINDERPAW_BUDGET_POLICY
CINDERPAW_BYOK_PROVIDER
CINDERPAW_CLOUD_IDLE_TIMEOUT_MS
CINDERPAW_CLOUD_TRANSCRIPT_BUDGET
CINDERPAW_CODE_RSI_REPO
CINDERPAW_CRON_JOB_TIMEOUT_MS
CINDERPAW_CRON_TICK_MS
CINDERPAW_DB
CINDERPAW_DB_KEY
CINDERPAW_DDG_MIN_INTERVAL_MS
CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS
CINDERPAW_DESKTOP_CONTROL_CONFIRM
CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK
CINDERPAW_DISCORD_CLIENT_ID
CINDERPAW_DREAMS_ENABLED
CINDERPAW_DRY_RUN
CINDERPAW_EMBED_CHUNK
CINDERPAW_EMBED_GPU_LAYERS
CINDERPAW_EMBED_MODEL
CINDERPAW_ENABLE_CODE_EXEC
CINDERPAW_ENABLE_DESKTOP_CONTROL
CINDERPAW_ENABLE_NOTEBOOK
CINDERPAW_ENABLE_SHELL_EXEC
CINDERPAW_ENABLE_SUBAGENTS
CINDERPAW_EVENT
CINDERPAW_EXTERNAL_WRITE_BUDGET
CINDERPAW_FALLBACK_API_KEY
CINDERPAW_FALLBACK_BASE_URL
CINDERPAW_FALLBACK_MODEL
CINDERPAW_FALLBACK_PROVIDER
CINDERPAW_FETCH_DOMAINS
CINDERPAW_FMS_DEDUP_SPAN_MS
CINDERPAW_FMS_EVICTION
CINDERPAW_FMS_MAX_LEAVES
CINDERPAW_FMS_MERGE_THRESHOLD
CINDERPAW_FMS_QUERY_BEAM
CINDERPAW_FMS_QUERY_TOPK
CINDERPAW_FORCE_SIDECAR_BUILD
CINDERPAW_FORGE_NO_PROMPT_OK
CINDERPAW_FRACTAL_BENCH_COUNT
CINDERPAW_FRACTAL_BENCH_MAX_LEAVES
CINDERPAW_FRACTAL_BENCH_QUERIES
CINDERPAW_FRACTAL_BENCH_SEED
CINDERPAW_FS_DENY
CINDERPAW_HEARTBEAT_INTERVAL_MS
CINDERPAW_HOME
CINDERPAW_HOST_TOOLS
CINDERPAW_HTTP_DOMAINS
CINDERPAW_INNER_THOUGHTS_ENABLED
CINDERPAW_JINA_API_KEY
CINDERPAW_LIVE_API_KEY
CINDERPAW_LIVE_INSTRUCTIONS
CINDERPAW_LIVE_MODEL
CINDERPAW_LIVE_PIPELINE
CINDERPAW_LIVE_PROVIDER
CINDERPAW_LIVE_STT_LANGUAGE
CINDERPAW_LIVE_LANGUAGE
CINDERPAW_LIVE_STT_MODEL
CINDERPAW_LIVE_STT_PROVIDER
CINDERPAW_LIVE_TOOLS
CINDERPAW_LIVE_TTS_ENGINE
CINDERPAW_LIVE_VOICE
CINDERPAW_LOCAL_API_KEY
CINDERPAW_LOCAL_BASE_URL
CINDERPAW_LOCAL_MODEL
CINDERPAW_LORA_TRAINER_BIN
CINDERPAW_LORA_TRAIN_TIMEOUT_MS
CINDERPAW_MAX_CONTEXT
CINDERPAW_MAX_COWORKERS
CINDERPAW_MAX_LOCAL_CONTEXTS
CINDERPAW_MERGE_THRESHOLD
CINDERPAW_MISSION_DEADLINE_MS
CINDERPAW_MODEL
CINDERPAW_MODEL_WAIT_MS
CINDERPAW_MODULE_SEED
CINDERPAW_NO_COLOR
CINDERPAW_OLLAMA_NUM_CTX
CINDERPAW_OPENROUTER_PROVIDER
CINDERPAW_PERMISSION_MODE
CINDERPAW_PII_REDACTION
CINDERPAW_PROACTIVE_ENABLED
CINDERPAW_PROVIDER
CINDERPAW_PUBLIC_JOURNAL_DIR
CINDERPAW_PUBLIC_JOURNAL_LIMIT
CINDERPAW_PUBLIC_JOURNAL_PUBLISHER
CINDERPAW_PUBLIC_JOURNAL_TOKEN
CINDERPAW_PUBLIC_JOURNAL_URL
CINDERPAW_PUBLIC_JOURNAL_VERSION
CINDERPAW_RATE_LIMIT_RPM
CINDERPAW_RECALL_INJECTION
CINDERPAW_RECALL_INJECTION_MAX_CHARS
CINDERPAW_RSI_ALLOW_CLOUD
CINDERPAW_RSI_CONCURRENCY
CINDERPAW_RSI_COOLDOWN_MS
CINDERPAW_RSI_EPISODE_MS
CINDERPAW_RSI_ERROR_THRESHOLD
CINDERPAW_RSI_ERROR_WINDOW_MS
CINDERPAW_RSI_EVAL_TOKEN_BUDGET
CINDERPAW_RSI_IDLE_MS
CINDERPAW_RSI_MAX_COST_USD
CINDERPAW_RSI_MAX_ITER
CINDERPAW_RSI_MAX_TOKENS
CINDERPAW_RSI_MAX_UNANSWERED_RATIO
CINDERPAW_RSI_PASSIVE
CINDERPAW_RSI_PLATEAU_ITERS
CINDERPAW_RSI_POLL_MS
CINDERPAW_RSI_SCHEDULE_MS
CINDERPAW_RSI_STAGNATION_THRESHOLD
CINDERPAW_RSI_STOP_ON_ACTIVITY
CINDERPAW_RSI_TELEMETRY
CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE
CINDERPAW_RUN_FRACTAL_BENCH
CINDERPAW_SEARXNG_URL
CINDERPAW_SHELL_DENYLIST
CINDERPAW_SHELL_MAX_TIMEOUT_MS
CINDERPAW_SHELL_PATH_EXTRA
CINDERPAW_SHELL_WHITELIST
CINDERPAW_SHUTDOWN_FLUSH_MS
CINDERPAW_SMOKE_GGUF
CINDERPAW_STALL_MS
CINDERPAW_STT_PROBE
CINDERPAW_SUBAGENT_MAX_SUMMARY_CHARS
CINDERPAW_SUMMARY_EXCERPT_CHARS
CINDERPAW_THOUGHTS_COOLDOWN_MS
CINDERPAW_THOUGHTS_DAILY_CAP
CINDERPAW_THOUGHTS_INTERVAL_MS
CINDERPAW_THOUGHTS_MIN_IDLE_MS
CINDERPAW_THOUGHTS_MOOD_THRESHOLD
CINDERPAW_TOOL_ALLOWED_DOMAINS
CINDERPAW_TOOL_GRAMMAR
CINDERPAW_TOTAL_DEADLINE_MS
CINDERPAW_TREE_BRANCH
CINDERPAW_TREE_CLUSTER_MAX_CHARS
CINDERPAW_TREE_ITEM_MAX_CHARS
CINDERPAW_TRUSTED_BASE_URLS
CINDERPAW_TRUSTED_LOCAL_ORIGINS
CINDERPAW_TTFT_DEADLINE_MS
CINDERPAW_TURN_BUDGET_MS
CINDERPAW_UNATTENDED_CONTINUATIONS
CINDERPAW_VERSION
CINDERPAW_WORKER_PORT
CINDERPAW_WORKSPACE
CINDERPAW_WRITE_CONFIRM_HOSTS
```
