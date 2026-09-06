//! Cinderpaw Agent sidecar — binary discovery, process lifecycle, supervisor.
//!
//! Cinderpaw Agent is the proactive AI agent with a native security sandbox.
//! It speaks newline-delimited JSON over stdin/stdout (the Tauri sidecar
//! protocol it was built for). All stdout JSON lines are forwarded to the
//! host's event bus (today `cinderpaw://agent-output` on the Tauri webview,
//! tomorrow the Public Runtime API `/events` SSE stream). The frontend
//! parses the `type` field and routes to chunk/done/tool/proactive/error
//! handlers.
//!
//! Data files live under `~/.cinderpaw/agent/` (DB) and `~/.cinderpaw/workspace/`.
//!
//! **Faza 4.5 Slice 2 — host-agnostic core.** This module no longer touches
//! `tauri::AppHandle`. Every host-specific concern flows through the
//! `HostEvents` trait (see `cinderpaw_core::host`):
//!   * events: `events.emit(event, payload)` instead of `app.emit(...)`
//!   * state: `Arc<RuntimeState>` (replaces `AppHandle::state::<AppState>()`)
//!   * desktop control: `Option<DesktopControlHandler>` (injected by host)
//!   * binary resolution: `extra_dirs: &[PathBuf]` (host supplies its
//!     `resource_dir`; cinderpaw-core walks the rest)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::host::{AdminHandler, CapabilityHandler, DesktopControlHandler, HostEvents};
use crate::paths;
use crate::rsi::runtime::{RsiEngineState, RsiRequestRegistry};
use crate::runtime::{PlannedExit, PlannedExitSlot, RuntimeState};

/// A single user answer to a single `ask_user` question.
///
/// Mirrors the TS `AskUserAnswer` shape on the React side so the JSON
/// payload we write to the sidecar's stdin is round-trippable:
/// `{ question, selected[], customText? }`. Used by the
/// `cinderpaw_ask_user_response` Tauri command (and the corresponding
/// `build_ask_user_response_line` helper).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AskUserAnswer {
    pub question: String,
    pub selected: Vec<String>,
    #[serde(rename = "customText", skip_serializing_if = "Option::is_none", default)]
    pub custom_text: Option<String>,
}

/// Default cancel reason when the UI doesn't supply one.
const DEFAULT_CANCEL_REASON: &str = "user cancelled";

/// Unix time in milliseconds — the watchdog's clock.
fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the JSON line the sidecar expects for an `ask_user_response`.
///
/// Returns an `Err` when `request_id` is empty/whitespace — the sidecar
/// would silently ignore the message anyway, so failing fast at the
/// Tauri boundary surfaces the bug to the UI instead.
pub fn build_ask_user_response_line(
    request_id: &str,
    answers: &[AskUserAnswer],
) -> Result<String, String> {
    if request_id.trim().is_empty() {
        return Err("ask_user_response: requestId is required".to_string());
    }
    Ok(serde_json::json!({
        "type": "ask_user_response",
        "requestId": request_id,
        "answers": answers,
    })
    .to_string())
}

/// Build the JSON line the sidecar expects for an `ask_user_cancel`.
///
/// `reason` is optional; the helper substitutes `DEFAULT_CANCEL_REASON`
/// when `None` so the sidecar's `AskUserBridge.cancel(id, reason)` is
/// always called with a non-empty reason.
pub fn build_ask_user_cancel_line(
    request_id: &str,
    reason: Option<&str>,
) -> Result<String, String> {
    if request_id.trim().is_empty() {
        return Err("ask_user_cancel: requestId is required".to_string());
    }
    Ok(serde_json::json!({
        "type": "ask_user_cancel",
        "requestId": request_id,
        "reason": reason.unwrap_or(DEFAULT_CANCEL_REASON),
    })
    .to_string())
}

/// Resolve the cinderpaw-agent binary across every install layout.
///
/// At bundle time Tauri strips the target-triple suffix from externalBin
/// entries and places the binary NEXT TO the main executable — that means
/// `Contents/MacOS/cinderpaw-agent` inside a macOS .app, `/usr/bin/cinderpaw-agent`
/// for Linux deb/rpm, and `cinderpaw-agent.exe` beside `cinderpaw.exe` on Windows.
/// The triple-suffixed name only exists in dev (`src-tauri/binaries/`) and,
/// historically, in the Windows installer.
///
/// `extra_dirs` is host-supplied: Tauri passes its `resource_dir` so the
/// bundle lookup still works, cinderpaw-cli passes an empty slice. The
/// `current_exe`-relative and `src-tauri/binaries` walk-up probes are
/// host-agnostic and stay in this function.
pub fn find_binary(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let triple_name = binary_filename();
    let plain_name = if cfg!(target_os = "windows") {
        "cinderpaw-agent.exe".to_string()
    } else {
        "cinderpaw-agent".to_string()
    };

    // Production: next to the main executable (all platforms), either name.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [&plain_name, &triple_name] {
                let p = dir.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // Host-supplied locations (Tauri's `resource_dir` for the bundle; headless
    // hosts pass an empty slice and rely on the rest of the search path).
    for dir in extra_dirs {
        for name in [&plain_name, &triple_name] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }

    // Development (cargo tauri dev): the binary lives in src-tauri/binaries/.
    // Walk up from the running executable to find a `binaries/<name>` tree.
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.as_path();
        for _ in 0..10 {
            for sub in &["binaries", "src-tauri/binaries"] {
                let candidate = cursor.join(sub).join(&triple_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
            match cursor.parent() {
                Some(p) => cursor = p,
                None => break,
            }
        }
    }

    None
}

fn binary_filename() -> String {
    if cfg!(target_os = "windows") {
        "cinderpaw-agent-x86_64-pc-windows-msvc.exe".to_string()
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "cinderpaw-agent-aarch64-apple-darwin".to_string()
        } else {
            "cinderpaw-agent-x86_64-apple-darwin".to_string()
        }
    } else if cfg!(target_arch = "aarch64") {
        "cinderpaw-agent-aarch64-unknown-linux-gnu".to_string()
    } else {
        "cinderpaw-agent-x86_64-unknown-linux-gnu".to_string()
    }
}

/// Discover the model id the bundled engine is serving by hitting
/// `/v1/models` on the local api server (OpenAI-compatible). Returns
/// the first model id (the bundled llama.cpp server exposes one
/// primary model — the `.gguf` filename minus the directory).
async fn discover_active_model(base_url: &str, api_token: &str) -> Option<String> {
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .bearer_auth(api_token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    let arr = body.get("data").and_then(|d| d.as_array())?;
    let pick = arr
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
        .find(|id| *id != paths::EMBED_FILENAME)
        .or_else(|| {
            arr.first()
                .and_then(|m| m.get("id"))
                .and_then(|v| v.as_str())
        })?;
    Some(pick.to_string())
}

/// Spawn the cinderpaw-agent sidecar and wire up stdin/stdout communication.
///
/// Populates `runtime.cinderpaw_agent_tx` with a `Sender<String>`; callers
/// clone it to write JSON messages to the agent's stdin. Stdout lines
/// are parsed and forwarded to the host's event bus.
///
/// `desktop_control` is `Some` on the desktop host (forwards each
/// `desktop_control_request` to the injected handler); `None` on the
/// headless gateway (responds with `ok:false` so the sidecar's pending
/// Promise never hangs).
///
/// Returns the `Child` handle so the caller can store it in
/// `runtime.cinderpaw_agent_process` and let the supervisor watch it. We
/// don't pre-populate the process slot here because the supervisor
/// (which calls `spawn` on every generation) is the sole owner of the
/// slot — pre-populating would race against `try_wait()` polling.
/// A cloud provider endpoint loaded from the user's BYOK config + OS keychain.
struct ByokEndpoint {
    base_url: String,
    api_key: String,
    model: Option<String>,
}

/// Load a configured BYOK provider's endpoint (base URL + keychain API key +
/// default model) by its id (e.g. `"minimax"`, `"nvidia"`). Returns `None` if
/// the provider is unknown or has no key stored — never fabricates. The key is
/// read in-process from the OS keychain via `byok::load`; it is never printed
/// or passed on a command line.
fn load_byok_provider_endpoint(provider_id: &str) -> Option<ByokEndpoint> {
    let settings = crate::settings::load();
    let byok = crate::byok::load(&settings);
    let cfg = byok.get_provider(provider_id)?;
    if cfg.api_key.is_empty() {
        tracing::warn!(
            provider = %provider_id,
            "CINDERPAW_BYOK_PROVIDER set but no API key in keychain — falling back to local engine"
        );
        return None;
    }
    // `get_all_providers` fills in the default base URL when the config leaves
    // it unset, so we don't have to re-derive it from the Provider enum here.
    let info = byok
        .get_all_providers()
        .into_iter()
        .find(|p| p.id == provider_id)?;
    // The sidecar's openai_compatible path builds `{base}/v1/chat/completions`
    // (CinderpawAgent inference-providers.ts). BYOK base URLs are stored WITH a
    // trailing `/v1` (e.g. MiniMax `…/v1`, NVIDIA NIM `…/v1`), which would
    // double to `/v1/v1/chat/completions` and 404. Strip it so the sidecar
    // re-adds exactly one `/v1`.
    let base_url = info.base_url?;
    let base_url = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();
    tracing::info!(provider = %provider_id, %base_url, "cinderpaw-agent: using BYOK cloud provider");
    Some(ByokEndpoint {
        base_url,
        api_key: cfg.api_key.clone(),
        model: info.default_model,
    })
}

/// Decide which API key the sidecar gets. If the base URL is loopback, hand it
/// the local bearer token (the gated server expects it). For any remote host,
/// REQUIRE an explicit `CINDERPAW_API_KEY` — silently forwarding the local token to
/// a third party would leak a credential. `env_key` is `CINDERPAW_API_KEY` if set.
/// True only when `base_url`'s HOST is loopback — never merely contains the word.
///
/// This used to be `base_url.contains("127.0.0.1") || contains("localhost")`,
/// which is true of `http://127.0.0.1.evil.com/v1`, of `http://localhost.evil
/// .com/`, and of any remote URL with `?probe=127.0.0.1` glued on the end. One
/// mistyped URL copied out of a tutorial and the local API bearer token — the
/// key to this machine's whole runtime — went to somebody else's server, past
/// the very check written to stop exactly that.
fn is_loopback_base_url(base_url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(base_url) else {
        // Unparseable is not loopback. Failing closed here costs a working
        // setup nothing (the URL was already broken) and refuses to guess.
        return false;
    };
    match parsed.host_str() {
        // IPv6 arrives bracketed (`[::1]`); strip them before parsing.
        Some(host) => {
            let host = host.trim_start_matches('[').trim_end_matches(']');
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false)
        }
        None => false,
    }
}

fn resolve_sidecar_api_key(
    base_url: &str,
    local_token: &str,
    env_key: Option<String>,
) -> Result<String, String> {
    if is_loopback_base_url(base_url) {
        Ok(local_token.to_string())
    } else {
        env_key.ok_or_else(|| {
            format!(
                "CINDERPAW_API_KEY must be set when CINDERPAW_BASE_URL is not loopback \
                 (got: {base_url}). Refusing to send the local API bearer token \
                 to a remote endpoint."
            )
        })
    }
}

pub async fn spawn(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    capabilities: Option<CapabilityHandler>,
    admin: Option<AdminHandler>,
    extra_bin_dirs: Vec<PathBuf>,
) -> Result<tokio::process::Child, String> {
    let api_port = runtime.settings.api_port;
    let api_token = runtime.local_api_token.as_ref();

    let binary = find_binary(&extra_bin_dirs).ok_or_else(|| {
        // D1 fix: the `beforeDevCommand` / `beforeBuildCommand` in
        // tauri.conf.json invoke `scripts/build-sidecar.mjs` which
        // builds the sidecar and copies it to `binaries/`. If you see
        // this error it almost always means the script failed silently
        // or the CinderpawAgent/ directory is missing on disk. Re-run with
        // `CINDERPAW_FORCE_SIDECAR_BUILD=1 cargo tauri dev` to force a
        // rebuild, or invoke the script directly:
        //   node src-tauri/scripts/build-sidecar.mjs
        // Two sentences for two different readers, installed one first. This
        // string is shown to the person, not only logged: on an installed
        // machine the usual cause is antivirus quarantining the sidecar or a
        // half-unpacked package, and the previous text named a build script
        // and a source tree that do not exist there — which reads as "this
        // program is broken" with nothing to act on.
        concat!(
            "Agent mode could not start because the cinderpaw-agent program is missing. ",
            "It ships alongside Cinderpaw, so this usually means antivirus quarantined it ",
            "or the installation did not finish — check your antivirus quarantine, then ",
            "reinstall Cinderpaw. ",
            "(Running from source: the sidecar build script, ",
            "src-tauri/scripts/build-sidecar.mjs, should have run as part of ",
            "`cargo tauri dev/build`; run it manually with ",
            "`node src-tauri/scripts/build-sidecar.mjs`.)"
        )
        .to_string()
    })?;

    tracing::info!("cinderpaw-agent: binary resolved to {:?}", binary);

    // Option A (code-RSI in production): when the dev knob is unset, try to
    // provision the BUNDLED sources into ~/.cinderpaw/self-src and export the
    // path — the sidecar and this supervisor's apply/revert/rebuild handlers
    // all read CINDERPAW_CODE_RSI_REPO from the environment. Any miss (dev run
    // without a bundle, no git) logs and leaves code-RSI off, as before.
    // Any previously-downloaded portable git/bun goes on OUR PATH first —
    // children (sidecar, worktree evals, rebuild scripts) inherit it.
    crate::toolchain::activate_portable();
    let bundled_src = crate::rsi::self_src::find_bundled_src(&extra_bin_dirs).is_some();
    if crate::env::env_var("CINDERPAW_CODE_RSI_REPO").map(|v| v.trim().is_empty()).unwrap_or(true) {
        match crate::rsi::self_src::provision(&extra_bin_dirs) {
            Ok(root) => {
                tracing::info!("cinderpaw-agent: self-src provisioned at {:?} (code-RSI enabled)", root);
                std::env::set_var("CINDERPAW_CODE_RSI_REPO", &root);
            }
            Err(reason) => {
                // Provisioning retries on every spawn — a missing git resolves
                // itself after the background toolchain download + next restart.
                tracing::debug!("cinderpaw-agent: self-src not provisioned ({reason}) — code-RSI off this session");
            }
        }
    }
    // Whenever code-RSI is possible on this install (bundled sources or an
    // explicit dev repo), make sure the tools its stages spawn exist —
    // portable download in the background when missing, zero terminal, zero
    // admin. No-op when git+bun are already present.
    if bundled_src || crate::env::env_var("CINDERPAW_CODE_RSI_REPO").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        crate::toolchain::ensure_background();
    }

    let db_path = paths::cinderpaw_agent_db_path();

    // Faza 4.5 Slice 2 (post-acceptance, user-driven): env-var overrides for
    // the provider + base URL + API key. Defaults preserve the pre-change
    // behavior (point at the bundled llama.cpp on loopback). The headless
    // gateway (or any host) can now point the sidecar at a cloud provider
    // by setting CINDERPAW_BASE_URL/CINDERPAW_API_KEY/CINDERPAW_MODEL before boot —
    // e.g. for testing the Discord connector against a fast model without
    // burning the local GPU.
    // Optional: use a configured cloud provider (BYOK) instead of the bundled
    // local engine. `CINDERPAW_BYOK_PROVIDER=minimax` loads that provider's base
    // URL + API key (from the OS keychain, in-process — the key never touches
    // the command line or the env we log) + default model. This makes the
    // headless gateway a true peer of the desktop app: same configured
    // providers, one brain. Explicit CINDERPAW_BASE_URL/API_KEY/MODEL still win.
    // Persisted route (settings.json `active_route`, written by
    // `POST /runtime/model` and guided setup): `"provider:model"` boots the
    // sidecar on that BYOK provider; `"local:…"` (or absent) keeps the
    // default local engine. Explicit CINDERPAW_BYOK_PROVIDER still wins.
    let persisted_route = crate::settings::load().active_route.and_then(|r| {
        let (pid, model) = r.split_once(':')?;
        (pid != "local").then(|| (pid.to_string(), model.to_string()))
    });
    let env_byok = crate::env::env_var("CINDERPAW_BYOK_PROVIDER");
    let route_is_source = env_byok.is_none() && persisted_route.is_some();
    let byok = env_byok
        .or_else(|| persisted_route.as_ref().map(|(pid, _)| pid.clone()))
        .and_then(|pid| load_byok_provider_endpoint(&pid));

    let provider = crate::env::env_var("CINDERPAW_PROVIDER")
        .unwrap_or_else(|| "openai_compatible".to_string());
    let base_url = crate::env::env_var("CINDERPAW_BASE_URL")
        .or_else(|| byok.as_ref().map(|b| b.base_url.clone()))
        .unwrap_or_else(|| format!("http://127.0.0.1:{api_port}"));
    // Normalize exactly like load_byok_provider_endpoint: the sidecar appends
    // `/v1/chat/completions` itself, so a user-supplied `…/v1` (every
    // provider's documented base URL, e.g. MiniMax) doubles to
    // `/v1/v1/chat/completions` and 404s. The keychain path already stripped
    // this; CINDERPAW_BASE_URL from env — the documented server path — did not.
    let base_url = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();
    let env_or_byok_key = crate::env::env_var("CINDERPAW_API_KEY")
        .or_else(|| byok.as_ref().map(|b| b.api_key.clone()));
    let api_key = resolve_sidecar_api_key(&base_url, api_token, env_or_byok_key)?;

    // CINDERPAW_WORKSPACE is deliberately NOT set here. It used to be pinned to
    // ~/.cinderpaw/workspace (the scratch dir), which silently reduced the agent's
    // filesystem to a sandbox nobody's files live in — the #1 "the agent can't
    // do anything" complaint. The sidecar's own default (launch cwd + the
    // user's home, with the call-time deny wall over ~/.cinderpaw and ~/.ssh) is
    // the intended posture; a user-set CINDERPAW_WORKSPACE in the host environment
    // still passes through via normal env inheritance.
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.env("CINDERPAW_DB", &db_path)
        .env("CINDERPAW_PROVIDER", &provider)
        .env("CINDERPAW_BASE_URL", &base_url)
        .env("CINDERPAW_API_KEY", &api_key);

    // CINDERPAW_MODEL discovery is for the bundled llama.cpp (/v1/models on
    // loopback). For a remote provider the user is expected to set
    // CINDERPAW_MODEL explicitly; we still call discover_active_model as a
    // best-effort (some clouds expose OpenAI-compatible /v1/models) but
    // honour CINDERPAW_MODEL when present so the caller can override.
    let model_name = if let Some(m) = crate::env::env_var("CINDERPAW_MODEL") {
        m
    } else if let Some((_, m)) = persisted_route.as_ref().filter(|_| route_is_source && byok.is_some()) {
        // The persisted route names the exact model the user verified/picked
        // (byok default_model may lag behind a later /model switch).
        m.clone()
    } else if let Some(m) = byok.as_ref().and_then(|b| b.model.clone()) {
        m
    } else {
        discover_active_model(&base_url, &api_key)
            .await
            .unwrap_or_else(|| "cinderpaw-local".to_string())
    };
    cmd.env("CINDERPAW_MODEL", &model_name);
    *runtime.active_agent_model.lock() = Some(model_name.clone());
    tracing::info!(model = %model_name, "cinderpaw-agent: using discovered model");

    // Where the bundled local engine lives, ALWAYS — even when the sidecar
    // boots on a cloud route. The sidecar uses this (and only this) as its
    // degrade-to-local fallback. It used to derive that fallback from
    // CINDERPAW_BASE_URL/CINDERPAW_MODEL, which on a cloud route are the cloud's, so
    // "fall back to local" silently re-called the boot-time cloud provider
    // after the user had switched away from it (blocker F9).
    let local_url = format!("http://127.0.0.1:{api_port}");
    cmd.env("CINDERPAW_LOCAL_BASE_URL", &local_url)
        .env("CINDERPAW_LOCAL_API_KEY", api_token);

    // The model the local engine serves. When the boot route IS the local
    // engine we already know it — reuse it instead of a second /v1/models
    // round-trip. Otherwise ask; the var stays unset if the engine isn't up
    // yet (discover_active_model has a 1s timeout), and the sidecar then
    // configures NO local fallback rather than one pinned to a model id the
    // engine doesn't serve — a fallback that 404s is worse than none, because
    // it fails at exactly the moment it is supposed to save the turn.
    //
    // The cloud-boot arm used to probe `/v1/models` — but that endpoint reports
    // `scan_models_dir()`, i.e. every GGUF ON DISK, not the one that is loaded.
    // At sidecar-spawn time nothing is loaded yet, so the probe handed back the
    // first file it found and the sidecar built a degrade-to-local fallback
    // pointing at a model the engine was not serving. Every cloud failure then
    // hit that fallback, got 503 "no model selected" stapled onto the real
    // error, and `wait_for_model` lazily pulled the multi-GB GGUF into RSS to
    // satisfy it. The name says "active"; the answer was "first on disk".
    //
    // A model is only known-resident when the boot route IS the local engine.
    // Otherwise leave the var unset: no fallback beats a fallback that cannot
    // serve. A later switch to a local model re-points the primary through
    // `set_model`, which is the path that carries `localFallbackAvailable`.
    let local_model = if base_url == local_url {
        Some(model_name.clone())
    } else {
        None
    };
    if let Some(local) = local_model {
        cmd.env("CINDERPAW_LOCAL_MODEL", local);
    }

    if let Some(db_key) = crate::db_key::get_or_create() {
        cmd.env("CINDERPAW_DB_KEY", db_key);
    }

    for key in [
        // Walk-away mode. The sidecar owns the behaviour (ask_user takes the
        // recommended option and logs it instead of blocking for a human), and
        // it reads this var — so leaving it off this list made the whole mode
        // unreachable through the gateway, which is every real install. The
        // agent then stopped mid-task to ask a question nobody was there to
        // answer, and looked like it had wedged.
        "CINDERPAW_AUTONOMOUS",
        "CINDERPAW_ENABLE_DESKTOP_CONTROL",
        "CINDERPAW_DESKTOP_CONTROL_CONFIRM",
        "CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS",
        "CINDERPAW_ENABLE_SHELL_EXEC",
        // read_only | workspace_write | full_access. The sidecar reads this for
        // every shell command's intent check and for the cwd bound.
        //
        // Listing it here changes nothing today, and the commit that added it
        // claimed otherwise — that the three-mode system was "unreachable
        // through the gateway, which is every real install". That was wrong, and
        // measuring it took two minutes: `CINDERPAW_PERMISSION_MODE=read_only` set
        // in the shell, gateway restarted on the July-11 host that does NOT list
        // it, and write_file came back "read-only mode: may not write". There is
        // no `env_clear()` on this Command, so the sidecar inherits the whole
        // environment and every var already arrives.
        //
        // Kept because it is explicit and free: if anyone ever scrubs this
        // Command's environment, the vars on this list are the ones that must
        // survive. It is documentation, not a fix.
        "CINDERPAW_PERMISSION_MODE",
        // shell_exec: CINDERPAW_SHELL_WHITELIST RESTRICTS to a named set (any
        // binary is the default now, see the tool's loadShellWhitelist);
        // CINDERPAW_SHELL_DENYLIST overrides the catastrophic-command guard.
        "CINDERPAW_SHELL_WHITELIST",
        "CINDERPAW_SHELL_DENYLIST",
    ] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn cinderpaw-agent: {e}"))?;

    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // Channel: commands → stdin writer task.
    let (tx, rx) = mpsc::channel::<String>(64);
    *runtime.cinderpaw_agent_tx.lock() = Some(tx);

    // The stdout reader borrows the sender from `runtime.cinderpaw_agent_tx` at the
    // moment it has something to say, rather than holding a clone for its whole
    // life. It used to hold one, and that clone is what made shutdown take the
    // full 30-second grace period every single time:
    //
    //   shutdown() drops the sender in the slot, expecting `rx` to close, the
    //   writer task to end, the child's stdin to drop and the sidecar to see
    //   EOF. The reader's clone kept `rx` alive, so stdin never closed, the
    //   sidecar never saw EOF, and it sat there until the hard kill — while the
    //   reader itself only ends when the sidecar's stdout closes, which the kill
    //   is what causes. A cycle broken only by the timeout.
    //
    // `gateway stop` waits 35s for the port; the drain always took ~30 plus
    // change, so it was a coin flip whether stopping reported success or
    // "gateway still up after 35s" for a shutdown that did work, five seconds
    // late. `cinderpaw update` restarts through that same path.
    tokio::spawn(stdin_writer(stdin, rx));
    tokio::spawn(stdout_reader(
        runtime.clone(),
        events.clone(),
        desktop_control,
        capabilities,
        admin,
        stdout,
        runtime.rsi_request_registry.clone(),
        runtime.rsi_engine.clone(),
        runtime.cinderpaw_agent_process.clone(),
        runtime.cinderpaw_agent_planned_exit.clone(),
    ));
    tokio::spawn(stderr_logger(events.clone(), stderr, runtime.agent_ready.clone()));

    tracing::info!("cinderpaw-agent: started (pid {:?})", child.id());
    Ok(child)
}

/// Supervise the sidecar: spawn it, watch for unexpected exits, and restart
/// with backoff (#11). Before this, a sidecar crash left Agent mode silently
/// mute — messages went into a dead stdin pipe, no banner, no recovery short
/// of restarting the whole app.
///
/// Behaviour:
///   * On every exit, emits `cinderpaw://agent-exit` with `{ code, restarting }`
///     so the frontend can show an "agent offline / restarting" banner.
///   * Restarts with linear backoff (2s, 4s, … capped at 10s), at most
///     `MAX_QUICK_FAILURES` times in a row. A process that stays up for
///     `STABLE_UPTIME_SECS` resets the failure streak (a crash after hours
///     of uptime shouldn't count against the boot-loop budget).
///   * After the budget is exhausted, gives up and emits a final
///     `cinderpaw://agent-exit` with `restarting: false` and an `error`
///     sentence naming the last exit code and the log file. The supervisor
///     task then ends; only an app restart brings Agent mode back.
///   * Every `restarting: false` emission carries `error`. The frontend shows
///     it verbatim, so this string is user-facing text, not a log line.
///
/// The `Child` stays in `runtime.cinderpaw_agent_process` so app-exit kill-on-drop
/// semantics are unchanged; the supervisor polls `try_wait()` through the
/// same mutex instead of taking ownership.
///
/// `rsi_registry` + `rsi_engine_mirror` are cloned into every spawn so each
/// generation of the sidecar gets fresh wiring — a stale oneshot from a
/// previous generation would never fire anyway (the new process never sees
/// the request), but cloning them keeps the contract "every spawn has its
/// own readers" explicit.
pub fn supervise(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    capabilities: Option<CapabilityHandler>,
    admin: Option<AdminHandler>,
    extra_bin_dirs: Vec<PathBuf>,
) {
    const MAX_QUICK_FAILURES: u32 = 5;
    const STABLE_UPTIME_SECS: u64 = 60;

    tokio::spawn(async move {
        let mut quick_failures: u32 = 0;
        // Faza 3 Slice 3: unexpected-exit timestamps (unix ms) feeding the
        // crash→auto-revert watchdog. Planned exits never land here.
        let mut crash_times_ms: Vec<u64> = Vec::new();
        loop {
            let started = std::time::Instant::now();
            match spawn(
                runtime.clone(),
                events.clone(),
                desktop_control.clone(),
                capabilities.clone(),
                admin.clone(),
                extra_bin_dirs.clone(),
            )
            .await
            {
                Ok(child) => {
                    *runtime.cinderpaw_agent_process.lock() = Some(child);
                }
                Err(e) => {
                    tracing::warn!("cinderpaw-agent: spawn failed: {e}");
                    events.emit(
                        "cinderpaw://agent-exit",
                        serde_json::json!({ "code": null, "restarting": false, "error": e }),
                    );
                    return;
                }
            }

            // Poll for exit. try_wait() through the mutex keeps ownership in
            // RuntimeState so kill_on_drop still fires on app shutdown.
            let status = loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let exited = {
                    let mut guard = runtime.cinderpaw_agent_process.lock();
                    match guard.as_mut() {
                        Some(c) => c.try_wait().ok().flatten(),
                        // Slot cleared externally — stop supervising.
                        None => break None,
                    }
                };
                if exited.is_some() {
                    break exited;
                }
            };
            let Some(status) = status else { return };

            // A planned exit (env-toggle restart, or a post-apply rebuild) is
            // not a crash: skip the failure accounting AND the watchdog
            // counter, then respawn immediately.
            // Scope the guard: holding a parking_lot lock across the rebuild
            // await would make the future !Send.
            let planned = { runtime.cinderpaw_agent_planned_exit.lock().take() };
            if let Some(planned) = planned {
                *runtime.cinderpaw_agent_tx.lock() = None;
                match planned {
                    PlannedExit::Shutdown => {
                        // Faza 4.5 Slice 2 D7: clean shutdown. The host
                        // asked for one-shot exit; the supervisor stops
                        // here. The agent-exit event still fires (with
                        // restarting:false) so the host can update its
                        // own UI / SSE subscribers.
                        events.emit(
                            "cinderpaw://agent-exit",
                            serde_json::json!({ "code": status.code(), "restarting": false }),
                        );
                        return;
                    }
                    PlannedExit::Restart => {
                        events.emit(
                            "cinderpaw://agent-exit",
                            serde_json::json!({ "code": status.code(), "restarting": true }),
                        );
                        continue;
                    }
                    PlannedExit::Rebuild { repo_root } => {
                        events.emit(
                            "cinderpaw://agent-exit",
                            serde_json::json!({ "code": status.code(), "restarting": true }),
                        );
                        // The process is dead, so its exe is finally writable
                        // (Windows locks running binaries) — rebuild now, before
                        // the respawn picks the binary up again.
                        match run_rebuild_script(&repo_root).await {
                            Ok(()) => {
                                if let Err(e) = refresh_spawn_binary(&extra_bin_dirs, &repo_root) {
                                    tracing::warn!("cinderpaw-agent: rebuilt but could not refresh spawn binary: {e}");
                                }
                                tracing::info!("cinderpaw-agent: sidecar rebuilt after live patch apply");
                            }
                            Err(e) => tracing::warn!(
                                "cinderpaw-agent: sidecar rebuild failed ({e}); respawning the \
                                 previous binary — the watchdog marker will expire harmlessly"
                            ),
                        }
                        continue;
                    }
                }
            }

            if started.elapsed().as_secs() >= STABLE_UPTIME_SECS {
                quick_failures = 0;
            }
            quick_failures += 1;
            let over_budget = quick_failures > MAX_QUICK_FAILURES;
            tracing::warn!(
                code = ?status.code(),
                attempt = quick_failures,
                over_budget,
                "cinderpaw-agent: sidecar exited unexpectedly"
            );
            // Invalidate the stale stdin sender so cinderpaw_send_message fails
            // fast instead of writing into a dead pipe.
            *runtime.cinderpaw_agent_tx.lock() = None;
            // A dead sidecar is not a ready one. Cleared here as well as
            // announced, or a window opened after the crash would ask, be told
            // yes, and sit waiting for an agent that is not there.
            runtime.agent_ready.store(false, std::sync::atomic::Ordering::SeqCst);
            let events_for_exit = events.clone();
            events_for_exit.emit(
                "cinderpaw://agent-exit",
                serde_json::json!({ "code": status.code(), "restarting": true }),
            );

            // Faza 3 Slice 3: crash→auto-revert watchdog.
            let now_ms = unix_ms();
            crash_times_ms.push(now_ms);
            let marker_path = crate::rsi::watchdog::default_marker_path();
            if let Some(marker) = crate::rsi::watchdog::load_marker(&marker_path) {
                let opts = crate::rsi::watchdog::WatchdogOpts::default();
                crash_times_ms
                    .retain(|t| now_ms.saturating_sub(*t) <= opts.window_ms);
                if crate::rsi::watchdog::marker_expired(&marker, now_ms, &opts) {
                    crate::rsi::watchdog::clear_marker(&marker_path);
                } else if crate::rsi::watchdog::should_revert(
                    &marker,
                    &crash_times_ms,
                    now_ms,
                    &opts,
                ) {
                    revert_bad_patch(events.clone(), &extra_bin_dirs, &marker).await;
                    crate::rsi::watchdog::clear_marker(&marker_path);
                    crash_times_ms.clear();
                    quick_failures = 0;
                    continue;
                }
            }

            // Budget spent: stop, and say so. This used to reset the counter
            // and sleep 30s instead, which meant the loop never ended and
            // `restarting:false` was never emitted for a crash — so a machine
            // where the sidecar can never stay up showed "going offline and
            // restarting automatically" for the whole session, on a 30s cycle,
            // and the honest screen written for exactly this case
            // (AgentOfflineBanner's WifiOff branch) was unreachable code.
            //
            // Giving up is the right answer here and not a capitulation: a
            // process that lived longer than STABLE_UPTIME_SECS resets the
            // streak, so reaching this line means six consecutive failures with
            // no run long enough to count as working. A seventh automatic
            // attempt does not fix an antivirus quarantine, a corrupt database
            // or a missing runtime — a sentence naming where to look does.
            if over_budget {
                tracing::error!(
                    "cinderpaw-agent: {MAX_QUICK_FAILURES} rapid failures — giving up until the app is restarted"
                );
                events.emit(
                    "cinderpaw://agent-exit",
                    serde_json::json!({
                        "code": status.code(),
                        "restarting": false,
                        "error": format!(
                            "Agent mode stopped after {MAX_QUICK_FAILURES} failed starts in a row \
                             (last exit code: {}). Restart Cinderpaw to try again. If it keeps \
                             happening, the reason is in the log at {}.",
                            status.code().map(|c| c.to_string()).unwrap_or_else(|| "none".into()),
                            crate::paths::cinderpaw_dir().join("logs").join("cinderpaw.log").display(),
                        ),
                    }),
                );
                return;
            }
            let backoff = std::time::Duration::from_secs((2 * quick_failures as u64).min(10));
            tokio::time::sleep(backoff).await;
        }
    });
}

/// Drain the mpsc channel into the child's stdin, one JSON line at a time.
async fn stdin_writer(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::Receiver<String>) {
    while let Some(msg) = rx.recv().await {
        let line = format!("{msg}\n");
        if stdin.write_all(line.as_bytes()).await.is_err() {
            tracing::warn!("cinderpaw-agent: stdin write failed — agent may have exited");
            break;
        }
    }
    tracing::debug!("cinderpaw-agent: stdin writer exiting");
}

/// Read stdout line-by-line. Most lines are protocol events forwarded verbatim
/// to the host's event bus as `cinderpaw://agent-output` (matching the wire shape
/// `{"data": "<line>"}` the legacy `CinderpawAgentOutputEvent` Tauri struct used to
/// emit — see Step 3 of Task 2 in
/// `docs/superpowers/plans/2026-07-03-faza4-5-slice2-cinderpaw-gateway.md`).
///
/// Exceptions handled in Rust, NOT forwarded as `agent-output`:
///   * `desktop_control_request` — routed to the injected `DesktopControlHandler`
///   * `rsi_request`              — dispatched via `cinderpaw_core::rsi::runtime`
///   * `rsi_engine_event`         — engine-driver IPC ack + mirror update
///   * `code_patch_resolved`      — Faza 3 patch lifecycle (marker + restart)
// Every argument is a distinct collaborator this reader has to fan events out
// to. Bundling them into a context struct would move the same list one level
// down without removing anything.
#[allow(clippy::too_many_arguments)]
async fn stdout_reader(
    runtime: Arc<RuntimeState>,
    events: Arc<dyn HostEvents>,
    desktop_control: Option<DesktopControlHandler>,
    capabilities: Option<CapabilityHandler>,
    admin: Option<AdminHandler>,
    stdout: tokio::process::ChildStdout,
    rsi_registry: RsiRequestRegistry,
    rsi_engine_mirror: Arc<Mutex<Option<RsiEngineState>>>,
    process_slot: Arc<Mutex<Option<tokio::process::Child>>>,
    planned_exit: PlannedExitSlot,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut seen_first_line = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            // R1: the sidecar's first stdout line is a `hello` announcing its
            // protocol version. v1 is warn-only — an old sidecar binary that
            // never sends `hello` (or a mismatched version) must not stop the
            // reader loop, so this just logs and moves on.
            if !seen_first_line {
                seen_first_line = true;
                if v.get("type").and_then(|t| t.as_str()) == Some("hello") {
                    match v.get("protocol").and_then(|p| p.as_u64()) {
                        Some(p) if p as u32 == crate::sidecar_protocol::SIDECAR_PROTOCOL => {}
                        Some(p) => tracing::warn!(
                            "cinderpaw-agent: sidecar protocol mismatch (sidecar={p}, host={})",
                            crate::sidecar_protocol::SIDECAR_PROTOCOL
                        ),
                        None => tracing::warn!(
                            "cinderpaw-agent: hello line missing 'protocol' field: {v}"
                        ),
                    }
                    // SOUL.md, for the voice call. A speech-to-speech session
                    // is briefed by us rather than by the agent loop, so this
                    // is the only route the persona has into a call — without
                    // it the caller hears the formatting rules and nothing
                    // else, which is a correct appliance rather than a voice.
                    // Absent on an older sidecar; the call just stays as it was.
                    if let Some(p) = v.get("persona").and_then(|p| p.as_str()) {
                        crate::live::briefing::set_persona(Some(p.to_string()));
                        tracing::info!("cinderpaw-agent: persona received ({} chars)", p.len());
                    }
                    continue;
                }
            }

            match v.get("type").and_then(|t| t.as_str()) {
                Some("desktop_control_request") => {
                    // None once shutdown has taken the sender: the sidecar is on
                    // its way out and there is nobody left to answer.
                    let Some(tx) = runtime.cinderpaw_agent_tx.lock().clone() else { continue };
                    let dc = desktop_control.clone();
                    tokio::spawn(async move { handle_desktop_control_request(v, dc, tx).await });
                    continue;
                }
                Some("capability_request") => {
                    let Some(tx) = runtime.cinderpaw_agent_tx.lock().clone() else { continue };
                    let caps = capabilities.clone();
                    tokio::spawn(async move { handle_capability_request(v, caps, tx).await });
                    continue;
                }
                Some("admin_request") => {
                    let Some(tx) = runtime.cinderpaw_agent_tx.lock().clone() else { continue };
                    let adm = admin.clone();
                    tokio::spawn(async move { handle_admin_request(v, adm, tx).await });
                    continue;
                }
                Some("rsi_request") => {
                    let Some(tx) = runtime.cinderpaw_agent_tx.lock().clone() else { continue };
                    let runtime = runtime.clone();
                    tokio::spawn(async move {
                        handle_rsi_request(runtime, v, tx).await;
                    });
                    continue;
                }
                Some("rsi_engine_event") => {
                    handle_rsi_engine_event(&v, &rsi_registry, &rsi_engine_mirror);
                    // Intentionally fall through to the host-event forward.
                }
                Some("code_patch_resolved") => {
                    handle_code_patch_resolved(&v, &process_slot, &planned_exit);
                }
                _ => {}
            }
        }

        tracing::debug!("cinderpaw-agent out: {}", &line);
        // Wire shape MUST match the legacy CinderpawAgentOutputEvent struct:
        // `{"data": "<line>"}`. See Step 3 of Slice 2 Task 2 plan for the
        // event-shape regression check.
        events.emit("cinderpaw://agent-output", serde_json::json!({ "data": line }));
    }
    tracing::info!("cinderpaw-agent: stdout closed");
}

fn handle_rsi_engine_event(
    v: &serde_json::Value,
    rsi_registry: &RsiRequestRegistry,
    rsi_engine_mirror: &Arc<Mutex<Option<RsiEngineState>>>,
) {
    let event_name = v.get("event").and_then(|t| t.as_str()).unwrap_or("");
    if event_name.is_empty() {
        tracing::warn!("cinderpaw-agent: rsi_engine_event without 'event' field: {v}");
        return;
    }

    if let Some(id) = v.get("id").and_then(|t| t.as_str()) {
        let fired = rsi_registry.ack(id);
        if !fired && matches!(event_name, "started" | "stopped" | "concurrency_set") {
            tracing::debug!(
                "cinderpaw-agent: rsi_engine_event {event_name} for unknown id {id} (already timed out?)"
            );
        }
    }

    let mut guard = rsi_engine_mirror.lock();
    let prev = guard.clone().unwrap_or_default();
    let next = match event_name {
        "started" => RsiEngineState {
            running: true,
            iteration: v.get("iteration").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.iteration),
            best_score: v.get("bestScore").and_then(|n| n.as_f64()).or(prev.best_score),
            cost_so_far_usd: v.get("costSoFarUsd").and_then(|n| n.as_f64()).unwrap_or(prev.cost_so_far_usd),
            concurrency: v.get("concurrency").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.concurrency),
            stop_reason: None,
        },
        "stopped" => RsiEngineState {
            running: false,
            iteration: v.get("iteration").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.iteration),
            best_score: v.get("bestScore").and_then(|n| n.as_f64()).or(prev.best_score),
            cost_so_far_usd: v.get("costSoFarUsd").and_then(|n| n.as_f64()).unwrap_or(prev.cost_so_far_usd),
            concurrency: prev.concurrency,
            stop_reason: v.get("stopReason").and_then(|t| t.as_str()).map(String::from).or(prev.stop_reason),
        },
        "concurrency_set" => RsiEngineState {
            running: prev.running,
            iteration: prev.iteration,
            best_score: prev.best_score,
            cost_so_far_usd: prev.cost_so_far_usd,
            concurrency: v.get("concurrency").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.concurrency),
            stop_reason: prev.stop_reason,
        },
        "progress" => RsiEngineState {
            running: prev.running,
            iteration: v.get("iteration").and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(prev.iteration),
            best_score: v.get("bestScore").and_then(|n| n.as_f64()).or(prev.best_score),
            cost_so_far_usd: v.get("costSoFarUsd").and_then(|n| n.as_f64()).unwrap_or(prev.cost_so_far_usd),
            concurrency: prev.concurrency,
            stop_reason: prev.stop_reason,
        },
        other => {
            tracing::warn!("cinderpaw-agent: unknown rsi_engine_event '{other}', ignoring");
            return;
        }
    };
    *guard = Some(next);
}

/// Faza 3 Slices 2+3, the apply side. Called for every `code_patch_resolved`
/// line; only `status: "applied"` acts. On an applied patch:
///   1. writes the watchdog marker (Slice 3 — the crash window starts now);
///   2. if the dev-repo knob `CINDERPAW_CODE_RSI_REPO` is set, schedules a
///      `PlannedExit::Rebuild` and kills the sidecar.
fn handle_code_patch_resolved(
    v: &serde_json::Value,
    process_slot: &Arc<Mutex<Option<tokio::process::Child>>>,
    planned_exit: &PlannedExitSlot,
) {
    if v.get("status").and_then(|s| s.as_str()) != Some("applied") {
        return;
    }
    let Some(id) = v.get("id").and_then(|s| s.as_str()) else {
        return;
    };

    let marker = crate::rsi::watchdog::PatchMarker {
        patch_id: id.to_string(),
        applied_at_ms: unix_ms(),
    };
    let marker_path = crate::rsi::watchdog::default_marker_path();
    if let Err(e) = crate::rsi::watchdog::save_marker(&marker_path, &marker) {
        tracing::warn!("cinderpaw-agent: failed to write watchdog marker: {e}");
    }

    let repo = crate::env::env_var("CINDERPAW_CODE_RSI_REPO").unwrap_or_default();
    if repo.trim().is_empty() {
        return;
    }
    tracing::info!("cinderpaw-agent: patch '{id}' applied — restarting sidecar for rebuild");
    *planned_exit.lock() = Some(PlannedExit::Rebuild { repo_root: repo });
    if let Some(child) = process_slot.lock().as_mut() {
        let _ = child.start_kill();
    }
}

/// Run `scripts/rsi-rebuild-sidecar.ps1` from the source repo: `bun run
/// build` + copy over the Tauri externalBin target. Must only run while
/// the sidecar is DEAD (the copy fails on a running exe). Windows-only,
/// like the script (per the Faza 3 spec, live apply is a Windows dev-
/// machine story for now).
async fn run_rebuild_script(repo_root: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        // POSIX half: scripts/rsi-rebuild-sidecar.sh (same contract as the
        // ps1 — exit 2 = "rebuild unavailable", non-zero = fatal).
        let script = Path::new(repo_root)
            .join("scripts")
            .join("rsi-rebuild-sidecar.sh");
        let mut cmd = tokio::process::Command::new("bash");
        cmd.arg(&script).arg(repo_root);
        let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
            .await
            .map_err(|_| "rebuild script timed out after 300s".to_string())?
            .map_err(|e| format!("failed to launch rebuild script: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!(
                "rebuild script exited {:?}: {}",
                out.status.code(),
                stderr.lines().last().unwrap_or("").trim()
            ))
        }
    }
    #[cfg(windows)]
    {
        let script = Path::new(repo_root)
            .join("scripts")
            .join("rsi-rebuild-sidecar.ps1");
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-RepoRoot")
            .arg(repo_root);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
            .await
            .map_err(|_| "rebuild script timed out after 300s".to_string())?
            .map_err(|e| format!("failed to launch rebuild script: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(format!(
                "rebuild script exited {:?}: {}",
                out.status.code(),
                stderr.lines().last().unwrap_or("").trim()
            ))
        }
    }
}

/// Push the freshly rebuilt sidecar to the path the NEXT spawn will
/// actually use. Gap found by the live smoke: the rebuild script updates
/// `<repo>/src-tauri/binaries/`, but in dev mode `cargo tauri dev` copies
/// the sidecar NEXT TO cinderpaw.exe (in the cargo target dir) and
/// `find_binary` prefers that copy — so without this, the supervisor
/// keeps respawning the stale binary forever. Must run while the sidecar
/// is dead (the destination is unlocked then).
fn refresh_spawn_binary(extra_bin_dirs: &[PathBuf], repo_root: &str) -> Result<(), String> {
    let fresh = Path::new(repo_root)
        .join("src-tauri")
        .join("binaries")
        .join(binary_filename());
    let dest = find_binary(extra_bin_dirs).ok_or_else(|| "find_binary resolved no sidecar".to_string())?;
    if let (Ok(a), Ok(b)) = (fresh.canonicalize(), dest.canonicalize()) {
        if a == b {
            return Ok(());
        }
    }
    std::fs::copy(&fresh, &dest)
        .map(|_| ())
        .map_err(|e| format!("copy {} -> {}: {e}", fresh.display(), dest.display()))
}

/// Reverse-apply a patch from the real source repo — the Rust mirror of the
/// TS `revertPatchLive` git invocation.
async fn git_apply_reverse(repo_root: &str, patch: &str) -> Result<(), String> {
    for check in [true, false] {
        let mut cmd = tokio::process::Command::new("git");
        cmd.args([
            "apply",
            "--directory=CinderpawAgent",
            "--whitespace=nowarn",
            "-R",
        ]);
        if check {
            cmd.arg("--check");
        }
        cmd.current_dir(repo_root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("git spawn failed: {e}"))?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        stdin
            .write_all(patch.as_bytes())
            .await
            .map_err(|e| format!("git stdin write failed: {e}"))?;
        drop(stdin);
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("git wait failed: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(stderr.lines().next().unwrap_or("git apply -R failed").to_string());
        }
    }
    Ok(())
}

/// Faza 3 Slice 3, the revert action. Called from the supervisor when the
/// watchdog says "this patch is killing the sidecar": reverse the patch on
/// the source tree, mark it `reverted` in the pending store, rebuild the
/// sidecar, refresh the spawn binary, and tell the host. Every step is
/// best-effort with a logged reason — the supervisor's respawn loop
/// continues regardless.
async fn revert_bad_patch(
    events: Arc<dyn HostEvents>,
    extra_bin_dirs: &[PathBuf],
    marker: &crate::rsi::watchdog::PatchMarker,
) {
    let id = &marker.patch_id;
    let repo = crate::env::env_var("CINDERPAW_CODE_RSI_REPO").unwrap_or_default();
    if repo.trim().is_empty() {
        tracing::warn!("cinderpaw-agent: watchdog fired for '{id}' but CINDERPAW_CODE_RSI_REPO is unset — cannot revert");
        return;
    }
    let store = crate::rsi::watchdog::default_pending_store_path();
    let Some(patch) = crate::rsi::watchdog::applied_patch_text(&store, id) else {
        tracing::warn!("cinderpaw-agent: watchdog fired for '{id}' but no applied patch with that id in the pending store");
        return;
    };
    if let Err(e) = git_apply_reverse(&repo, &patch).await {
        tracing::error!("cinderpaw-agent: auto-revert of '{id}' FAILED ({e}) — source may still carry the bad patch");
        return;
    }
    if let Err(e) = crate::rsi::watchdog::mark_patch_reverted(&store, id) {
        tracing::warn!("cinderpaw-agent: reverted '{id}' but could not mark the store: {e}");
    }
    match run_rebuild_script(&repo).await {
        Ok(()) => {
            if let Err(e) = refresh_spawn_binary(extra_bin_dirs, &repo) {
                tracing::warn!("cinderpaw-agent: reverted '{id}' but could not refresh spawn binary: {e}");
            }
        }
        Err(e) => tracing::warn!("cinderpaw-agent: reverted '{id}' but rebuild failed ({e}) — the running binary may still carry the patch until the next successful build"),
    }
    tracing::warn!("cinderpaw-agent: auto-reverted patch '{id}' after repeated sidecar crashes");
    events.emit(
        "cinderpaw://rsi-patch-reverted",
        serde_json::json!({ "patchId": id }),
    );
}

/// Run a single desktop-control request from the sidecar and write the
/// response back to its stdin. All security gating lives inside the
/// host's `DesktopControlHandler` (today: `crate::desktop_control`); this
/// function only marshals JSON and guarantees *every* request gets exactly
/// one response. When the host injects `None` (headless gateway), every
/// request responds with `ok:false, error:"desktop control not available
/// in this host"` so the sidecar's pending Promise never hangs.
async fn handle_desktop_control_request(
    req: serde_json::Value,
    desktop_control: Option<DesktopControlHandler>,
    tx: mpsc::Sender<String>,
) {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or(serde_json::Value::Null);

    let response = match desktop_control {
        Some(dc) => match dc(action, params).await {
            Ok(data) => serde_json::json!({
                "type": "desktop_control_response",
                "id": id,
                "ok": true,
                "data": data,
            }),
            Err(message) => serde_json::json!({
                "type": "desktop_control_response",
                "id": id,
                "ok": false,
                "error": message,
            }),
        },
        None => serde_json::json!({
            "type": "desktop_control_response",
            "id": id,
            "ok": false,
            "error": "desktop control not available in this host",
        }),
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("cinderpaw-agent: failed to deliver desktop_control_response (sidecar gone?)");
    }
}

/// Serve a `capability_request` from the sidecar: list, inspect or install a
/// skill, and write back a matching `capability_response`.
///
/// This is the trust boundary. The sidecar sends a NAME and nothing else — no
/// content, no metadata, no trust label. Everything about what that name means
/// is resolved here, against manifests this process fetched itself. The agent
/// can ask for a capability; it cannot vouch for one.
async fn handle_capability_request(
    req: serde_json::Value,
    capabilities: Option<CapabilityHandler>,
    tx: mpsc::Sender<String>,
) {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or(serde_json::Value::Null);

    let response = match capabilities {
        Some(handler) => match handler(action, params).await {
            Ok(data) => serde_json::json!({
                "type": "capability_response", "id": id, "ok": true, "data": data,
            }),
            Err(message) => serde_json::json!({
                "type": "capability_response", "id": id, "ok": false, "error": message,
            }),
        },
        None => serde_json::json!({
            "type": "capability_response",
            "id": id,
            "ok": false,
            "error": "capability installation is not available in this host",
        }),
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("cinderpaw-agent: failed to deliver capability_response (sidecar gone?)");
    }
}

/// Serve one `admin_request` from the sidecar and answer it.
async fn handle_admin_request(
    req: serde_json::Value,
    admin: Option<AdminHandler>,
    tx: mpsc::Sender<String>,
) {
    let id = req.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let params = req.get("params").cloned().unwrap_or(serde_json::Value::Null);

    let response = match admin {
        Some(handler) => match handler(action, params).await {
            Ok(data) => json_ok("admin_response", &id, data),
            Err(message) => json_err("admin_response", &id, &message),
        },
        None => json_err(
            "admin_response",
            &id,
            "administrative commands are not available in this host",
        ),
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("cinderpaw-agent: failed to deliver admin_response (sidecar gone?)");
    }
}

fn json_ok(kind: &str, id: &str, data: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "type": kind, "id": id, "ok": true, "data": data })
}

fn json_err(kind: &str, id: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "type": kind, "id": id, "ok": false, "error": message })
}

/// Run a single `rsi_request` from the sidecar and write a matching
/// `rsi_response` back to its stdin.
async fn handle_rsi_request(
    runtime: Arc<RuntimeState>,
    req: serde_json::Value,
    tx: mpsc::Sender<String>,
) {
    let id = req
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let method = req
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let params = req
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let response = if method.is_empty() {
        serde_json::json!({
            "type": "rsi_response",
            "id": id,
            "ok": false,
            "error": "rsi_request: missing 'method'",
        })
    } else {
        match crate::rsi::runtime::dispatch_rsi_request(&runtime, &method, params).await {
            Ok(data) => serde_json::json!({
                "type": "rsi_response",
                "id": id,
                "ok": true,
                "data": data,
            }),
            Err(message) => serde_json::json!({
                "type": "rsi_response",
                "id": id,
                "ok": false,
                "error": message,
            }),
        }
    };

    if tx.send(response.to_string()).await.is_err() {
        tracing::warn!("cinderpaw-agent: failed to deliver rsi_response (sidecar gone?)");
    }
}

/// The exact line the sidecar prints when it is genuinely up. Kept next to the
/// reader that waits for it so the two cannot drift apart silently — they are
/// two halves of one protocol, in two languages, in two files.
pub const READY_MARKER: &str = "::cinderpaw-agent-ready::";

/// What the sidecar said before the rename.
///
/// Still accepted, and not only for tidiness: the sidecar is a separate binary
/// that ships on its own cadence (npm) and can be rebuilt on its own by
/// code-RSI, so a host can genuinely find itself beside an older one. The cost
/// of not recognising it is the whole app never becoming ready, which is the
/// most expensive failure in this file to have twice.
pub const LEGACY_READY_MARKER: &str = "::feral-agent-ready::";

/// Log stderr from the agent; emit `cinderpaw://agent-ready` on the ready marker.
async fn stderr_logger(
    events: Arc<dyn HostEvents>,
    stderr: tokio::process::ChildStderr,
    agent_ready: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        tracing::info!("[cinderpaw-agent] {}", &line);
        // Exact marker, not a substring. `line.contains("ready")` matched
        // "already", "not ready" and "model-ready probe failed" — so the app
        // could declare the agent up because a log line mentioned a failure,
        // and could equally wait forever if no line happened to contain the
        // word. The sidecar prints this once, when its transport is up and its
        // tools are live.
        if line.ends_with(READY_MARKER) || line.ends_with(LEGACY_READY_MARKER) {
            // Recorded BEFORE it is announced. A listener that missed the event
            // can ask; one that missed both the flag and the event does not
            // exist, because the flag outlives the moment.
            agent_ready.store(true, std::sync::atomic::Ordering::SeqCst);
            events.emit("cinderpaw://agent-ready", serde_json::json!({}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two halves of the ready protocol live in different languages and
    /// different files. This pins the host half; `boot.ts` prints the same
    /// string, and the marker is a constant precisely so a rename here fails
    /// loudly instead of leaving the app waiting forever.
    #[test]
    fn only_the_exact_marker_means_ready() {
        let ready = |line: &str| line.trim().ends_with(READY_MARKER);

        assert!(ready("[cinderpaw] ::cinderpaw-agent-ready::"));
        assert!(ready("::cinderpaw-agent-ready::"));

        // Every one of these used to flip the app to "the agent is up".
        assert!(!ready("dream: model-ready probe failed (timeout) — treating as no model"));
        assert!(!ready("discord: already has a run in flight — not starting a second"));
        assert!(!ready("transport not ready"));
        assert!(!ready("ready"));
    }

    #[test]
    fn binary_filename_has_expected_extension_on_windows() {
        let name = binary_filename();
        #[cfg(target_os = "windows")]
        assert!(name.ends_with(".exe"), "Windows binary must end with .exe");
        #[cfg(not(target_os = "windows"))]
        assert!(!name.ends_with(".exe"), "non-Windows binary must not end with .exe");
    }

    #[test]
    fn binary_filename_contains_target_triple() {
        let name = binary_filename();
        assert!(name.contains('-'), "binary name must contain a target triple");
        assert!(name.starts_with("cinderpaw-agent-"));
    }

    #[test]
    fn sidecar_api_key_loopback_uses_local_token() {
        for url in ["http://127.0.0.1:11435", "http://localhost:11435"] {
            assert_eq!(
                resolve_sidecar_api_key(url, "local-secret", None).unwrap(),
                "local-secret",
                "loopback must reuse the local bearer token even without CINDERPAW_API_KEY"
            );
        }
    }

    #[test]
    fn sidecar_api_key_lookalike_host_is_not_loopback() {
        // A host that merely CONTAINS the loopback spelling is a remote host,
        // and must be refused the local token like any other.
        for url in [
            "http://127.0.0.1.evil.com/v1",
            "http://localhost.attacker.com/",
            "https://evil.com/?probe=127.0.0.1",
            "https://evil.com/localhost",
        ] {
            assert!(
                resolve_sidecar_api_key(url, "local-secret", None).is_err(),
                "{url} must not be treated as loopback"
            );
        }
        // The real ones still are, including IPv6 and an uppercase spelling.
        for url in ["http://[::1]:11435", "http://LOCALHOST:11435"] {
            assert_eq!(
                resolve_sidecar_api_key(url, "local-secret", None).unwrap(),
                "local-secret"
            );
        }
    }

    #[test]
    fn sidecar_api_key_remote_requires_explicit_key() {
        // No CINDERPAW_API_KEY for a remote host → refuse, never leak the local token.
        let err = resolve_sidecar_api_key("https://api.openai.com/v1", "local-secret", None)
            .unwrap_err();
        assert!(err.contains("CINDERPAW_API_KEY must be set"));
        assert!(!err.contains("local-secret"), "error must not echo the local token");
        // With an explicit key, it is used verbatim (local token never forwarded).
        assert_eq!(
            resolve_sidecar_api_key("https://api.openai.com/v1", "local-secret", Some("sk-remote".into())).unwrap(),
            "sk-remote"
        );
    }

    #[test]
    fn build_ask_user_response_line_emits_correct_json() {
        let answers = vec![
            AskUserAnswer {
                question: "Pick a database".to_string(),
                selected: vec!["Postgres".to_string()],
                custom_text: None,
            },
        ];
        let line = build_ask_user_response_line("req-1", &answers).expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_response");
        assert_eq!(v["requestId"], "req-1");
        assert_eq!(v["answers"][0]["question"], "Pick a database");
        assert_eq!(v["answers"][0]["selected"][0], "Postgres");
        assert!(v["answers"][0].get("customText").is_none(), "customText must be omitted when None");
    }

    #[test]
    fn build_ask_user_response_line_rejects_empty_request_id() {
        let line = build_ask_user_response_line("", &[]);
        assert!(line.is_err(), "empty requestId must be rejected");
        let err = line.unwrap_err();
        assert!(err.contains("requestId") || err.contains("request_id"), "error should mention requestId: {err}");
    }

    #[test]
    fn build_ask_user_response_line_rejects_whitespace_request_id() {
        let line = build_ask_user_response_line("   ", &[]);
        assert!(line.is_err(), "whitespace-only requestId must be rejected");
    }

    #[test]
    fn build_ask_user_cancel_line_emits_correct_json_with_explicit_reason() {
        let line = build_ask_user_cancel_line("req-2", Some("user clicked Skip"))
            .expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_cancel");
        assert_eq!(v["requestId"], "req-2");
        assert_eq!(v["reason"], "user clicked Skip");
    }

    #[test]
    fn build_ask_user_cancel_line_uses_default_reason_when_none_provided() {
        let line = build_ask_user_cancel_line("req-3", None).expect("ok");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["type"], "ask_user_cancel");
        assert_eq!(v["requestId"], "req-3");
        assert!(v["reason"].is_string(), "reason must be a string");
        assert!(!v["reason"].as_str().unwrap().is_empty(), "default reason must not be empty");
    }

    #[test]
    fn build_ask_user_cancel_line_rejects_empty_request_id() {
        let line = build_ask_user_cancel_line("", None);
        assert!(line.is_err(), "empty requestId must be rejected");
    }

    #[test]
    fn ask_user_response_and_cancel_messages_are_distinct() {
        let r = build_ask_user_response_line("req", &[]).unwrap();
        let c = build_ask_user_cancel_line("req", None).unwrap();
        assert_ne!(r, c, "response and cancel must produce distinct JSON");
        assert!(r.contains("\"type\":\"ask_user_response\""));
        assert!(c.contains("\"type\":\"ask_user_cancel\""));
    }
}