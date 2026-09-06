use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Settings {
    pub models_dir: PathBuf,
    pub default_gpu_layers: i32,
    pub api_server_enabled: bool,
    pub api_port: u16,
    pub version: String,
    /// Opt-in for OS-level desktop control (the `control_app` tool). Gated
    /// exactly like `shell_exec`: OFF by default. When true, the host process
    /// exports `CINDERPAW_ENABLE_DESKTOP_CONTROL=true` before spawning the sidecar,
    /// which both registers the tool in the sidecar AND opens the Rust command
    /// gate (the two must agree). `#[serde(default)]` keeps older settings.json
    /// files (written before this field existed) loading cleanly.
    #[serde(default)]
    pub desktop_control_enabled: bool,
    /// "YOLO mode" for desktop control: when true, state-changing actions
    /// (click/type/send_keys/perform_action) run WITHOUT the per-action
    /// confirmation prompt. False (default) = Safe mode = confirm each action.
    /// Maps to `CINDERPAW_DESKTOP_CONTROL_CONFIRM=false` in the sidecar env.
    /// `launch` still always confirms (process creation) regardless.
    #[serde(default)]
    pub desktop_control_yolo: bool,
    /// Per-conversation token budget passed to the sidecar as
    /// `CINDERPAW_BUDGET_CONVERSATION`. `None` = unlimited (Infinity); `Some(n)`
    /// caps the conversation at n tokens and surfaces a `budget_exceeded` event
    /// when reached. Default: None (unlimited — the user is responsible for
    /// their own inference costs on a local/BYOK setup).
    #[serde(default)]
    pub token_budget_conversation: Option<u64>,
    /// USD spend cap for the passive RSI background engine, exported to the
    /// sidecar as `CINDERPAW_RSI_MAX_COST_USD`. `Some(0.0)` (default) = local-only:
    /// the free loopback engine runs forever, any paid cloud spend halts. A
    /// positive value allows bounded cloud spend. `None` = no cap (advanced).
    #[serde(default = "default_rsi_budget")]
    pub rsi_max_cost_usd: Option<f64>,
    /// Let the background self-improvement loop run when the model is a CLOUD
    /// model, exported as `CINDERPAW_RSI_ALLOW_CLOUD`. False by default: dreaming
    /// on a paid route spends the user's money while they are away, and nobody
    /// should discover that on an invoice.
    ///
    /// It has a settings field at all because the default was the whole
    /// feature's off switch and nothing said so. A machine with no local model
    /// — which is most machines, and every machine without a GPU — never ran a
    /// single episode, and the reason went to a log line the user never opens.
    /// The Dreams panel now reads this field, says why it is asleep, and offers
    /// the switch; the spend stays bounded by `rsi_max_cost_usd`.
    #[serde(default)]
    pub rsi_allow_cloud_dreams: bool,
    /// MASTER opt-in for the Dream Cycle, exported as
    /// `CINDERPAW_DREAMS_ENABLED`. False by default: dreaming never starts
    /// unless the user asked for it — local or cloud alike. This sits ABOVE
    /// the passive/cloud gates: without it they are never even consulted.
    /// The previous default armed dreaming on every machine with a model
    /// configured, which is the "default nobody set" failure shape — a
    /// background engine most people did not know existed, running on their
    /// machine (or their money) unasked. `#[serde(default)]` keeps older
    /// settings.json files loading cleanly.
    #[serde(default)]
    pub dreams_enabled: bool,
    /// One-time security acknowledgement (guided setup, OpenClaw parity):
    /// ISO timestamp of when the user confirmed the personal-by-default
    /// disclaimer. `Some(_)` = never re-prompt. Set via
    /// `POST /runtime/setup/ack`.
    #[serde(default)]
    pub security_acknowledged_at: Option<String>,
    /// The verified/chosen inference route, persisted so a gateway restart
    /// boots the sidecar on the SAME model the user picked. Written by
    /// `POST /runtime/model` and guided setup's verify-persist; read at
    /// sidecar spawn. Shapes: `"<provider>:<model>"` (BYOK cloud) or
    /// `"local:<file>"` (bundled llama.cpp — the default boot path anyway).
    /// Before this field, model switches lived only in process env vars and
    /// silently reverted to the local CPU model on every gateway restart.
    #[serde(default)]
    pub active_route: Option<String>,
    /// Allow a failed cloud turn to be retried against a DIFFERENT cloud
    /// provider the user has configured. Off by default, and the default is the
    /// point.
    ///
    /// This existed and was unconditional. On a machine with no local model a
    /// single 429 ended the turn, so `pick_second_provider` picked the next
    /// enabled provider alphabetically and sent the conversation there with
    /// that provider's key. The reliability argument is real. The problem is
    /// that `PROMISES.md` promise 3 says the conversation goes to the recipient
    /// the person chose, the Privacy tab says "Cloud providers (BYOK) only
    /// contacted when you explicitly send a message", and neither is true when
    /// Anthropic's rate limit silently routes the transcript to OpenAI.
    ///
    /// A person who wants that trade can have it — it is their key and their
    /// data — but they have to be the one who asks for it. Nobody discovers
    /// this on a settings screen they never opened; they discover it in another
    /// company's logs.
    #[serde(default)]
    pub cloud_fallback_enabled: bool,
}

fn default_rsi_budget() -> Option<f64> { Some(0.0) }

impl Default for Settings {
    fn default() -> Self {
        Self {
            models_dir: paths::models_dir(),
            default_gpu_layers: -1,
            api_server_enabled: false,
            api_port: 11435,
            version: env!("CARGO_PKG_VERSION").to_string(),
            desktop_control_enabled: false,
            desktop_control_yolo: false,
            token_budget_conversation: None,
            rsi_max_cost_usd: Some(0.0),
            rsi_allow_cloud_dreams: false,
            dreams_enabled: false,
            security_acknowledged_at: None,
            active_route: None,
            cloud_fallback_enabled: false,
        }
    }
}

pub fn load() -> Settings {
    let path = paths::settings_path();
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
            Ok(s) => s,
            // A file that exists and does not parse used to fall through to the
            // defaults without a word. Every field here is required, so one
            // hand-written `{"api_port": 11466}` — a reasonable thing to write —
            // is discarded whole, and the process comes up on 11435 insisting
            // nothing is wrong. That cost an afternoon: two Cinderpaw instances
            // fought over one port and one database lock, and the desktop app
            // reported "cinderpaw-agent not running", which is true and useless.
            //
            // Loud, and still non-fatal: refusing to boot over a bad settings
            // file would be worse. But the person gets to know their file was
            // ignored, and why.
            Err(e) => {
                eprintln!(
                    "[cinderpaw] WARNING: {} exists but could not be parsed ({e}) — \
                     IGNORING IT and using defaults. Every field is required; \
                     a partial file is not merged with the defaults.",
                    path.display()
                );
                Settings::default()
            }
        },
        // No file at all is the ordinary first-run case, not a problem.
        Err(_) => Settings::default(),
    }
}

pub fn save(s: &Settings) -> anyhow::Result<()> {
    paths::ensure_dirs()?;
    let path = paths::settings_path();
    // Temp file + rename, never a truncate-in-place. A crash halfway through a
    // direct write leaves settings.json unparseable, and `load()` answers that
    // by returning defaults — so the user loses api_port, active_route, the
    // desktop-control choices and the RSI budget all at once, silently. Worst
    // of all is active_route: with it gone the next boot falls back to a local
    // model, and every connector routed through a cloud provider goes quiet
    // without saying why. Rename is atomic, so a reader sees the old file or
    // the new one, never half of either.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rsi_budget_is_local_only_zero() {
        let s = Settings::default();
        assert_eq!(s.rsi_max_cost_usd, Some(0.0));
    }

    /// The default IS the product. A person who never opens Settings must not
    /// have their conversation re-sent to a second company on a rate limit.
    #[test]
    fn cloud_fallback_is_off_until_the_person_asks_for_it() {
        assert!(!Settings::default().cloud_fallback_enabled);
        // And an older settings.json, written before the field existed, must
        // load as off rather than failing to parse or defaulting to on.
        let older = r#"{
            "models_dir": "/tmp/m", "default_gpu_layers": -1,
            "api_server_enabled": false, "api_port": 11435, "version": "1.0.0"
        }"#;
        let parsed: Settings = serde_json::from_str(older).expect("older file must still load");
        assert!(!parsed.cloud_fallback_enabled);
    }
}
