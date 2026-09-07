mod agents;
mod commands;
mod connectors;
mod conversations;
mod admin_bridge;
mod deep_link;
mod desktop_control;
mod disk_encryption;
mod events;
mod mcp;
mod memory_graph;
mod memory_resume;
mod migrate_webview;
mod projects;
mod rsi;
mod skills;

use commands::*;

pub use cinderpaw_core::{
    api, byok, db_key, cinderpaw_agent, gpu_detect, inference, models, paths,
    perf_policy, settings, sysinfo_mod, tools, tts,
};
#[cfg(feature = "whisper")]
pub use cinderpaw_core::transcription;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// `HostEvents` for the desktop entry point (Faza 4.5 Slice 2): forwards
/// every runtime event to the webview via `app.emit` AND onto the runtime's
/// broadcast bus (`events_tx`). The bus fan-out matches the headless
/// `BusEvents` sink — without it, the desktop's embedded HTTP API (`/events`
/// SSE, the id-correlated roundtrips in `api.rs`, and the MCP roundtrips in
/// `mcp.rs`) would never observe sidecar output. The headless gateway uses
/// `cinderpaw_core::host::LogEvents`/`BusEvents` instead — see `crates/cinderpaw-cli`.
struct TauriEvents(
    tauri::AppHandle,
    tokio::sync::broadcast::Sender<cinderpaw_core::host::HostEvent>,
);
impl cinderpaw_core::host::HostEvents for TauriEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload.clone());
        let _ = self.1.send(cinderpaw_core::host::HostEvent {
            event: event.to_string(),
            payload,
        });
    }
}

use crate::agents::AgentConfig;
use crate::inference::{InferParams, Message};
use crate::models::ModelInfo;
use crate::perf_policy::{deadline_message, perf_policy, DeadlineReason, PerfPolicy};
use crate::settings::Settings;
use crate::sysinfo_mod::SystemInfo;

/// Per-download cancellation flag. Cloned into the spawned download task and
/// into the AppState map so `cancel_download` can flip it from another command.
type CancelFlag = Arc<AtomicBool>;

/// Display-safe snapshot of the Cinderpaw Agent's active LLM backend.
/// API keys are never included — Rust injects them before forwarding to the sidecar.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CinderpawModelConfigView {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub display_name: String,
}

pub struct AppState {
    /// Host-agnostic runtime shared with any future non-Tauri host (Faza 4.5
    /// Slice 2). Holds the model manager, settings, local API token, the
    /// Cinderpaw Agent sidecar handles, and the RSI substrate/engine state.
    /// `AppState` derefs to this so every existing `state.manager` /
    /// `state.rsi_state` / etc. call site across this file keeps compiling.
    pub runtime: std::sync::Arc<cinderpaw_core::runtime::RuntimeState>,
    pub downloads: Arc<Mutex<HashMap<String, CancelFlag>>>,
    pub stop_signals: Arc<StopRegistry>,
    /// System info pre-computed in a background thread at startup so the
    /// first call to get_system_info() returns instantly.
    pub system_info_cache: Arc<Mutex<Option<SystemInfo>>>,
    /// Cached display-safe view of the model the sidecar is currently using.
    /// Updated optimistically by cinderpaw_set_model; None until first set_model call.
    pub cinderpaw_model_config: Arc<Mutex<Option<CinderpawModelConfigView>>>,
    /// The speech-to-speech call in progress, if any. Holding the command
    /// sender IS the call: dropping it closes the socket, which is what hanging
    /// up means and why there is no separate "is a call running" flag to get out
    /// of step with reality.
    pub live_call: crate::commands::live::LiveCallSlot,
    /// The self-hosted LiveKit call in progress, if any.
    ///
    /// Holding the session IS the call, the same way `live_call` holds a
    /// sender: dropping it kills the server and the agent it started. That is
    /// why there is no separate "running" flag — a flag can disagree with
    /// reality, and the reality here is two child processes.
    pub livekit_call: Arc<Mutex<Option<cinderpaw_core::livekit::Session>>>,
}

/// One stop flag per streaming session.
///
/// This used to be a single shared `Arc<AtomicBool>` on `AppState`, which made
/// "stop generating" unreliable in two ways: `stop_generation` took no session
/// and therefore stopped every stream at once, and each new generation RESET
/// the shared flag — so starting a stream in one session silently un-stopped a
/// stream still running in another, and that one kept generating with nothing
/// left that could interrupt it.
#[derive(Default)]
pub struct StopRegistry(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl StopRegistry {
    /// Register a fresh flag for `session_id` and hand it to the generation
    /// about to start. Replaces any previous flag for that session (a session
    /// only ever has one stream in flight), so a stop aimed at an earlier,
    /// already-finished generation cannot abort the new one.
    pub fn begin(&self, session_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().insert(session_id.to_string(), flag.clone());
        flag
    }

    /// Release `session_id`'s flag when its generation ends — but only if it is
    /// still the one that was registered. A newer generation for the same
    /// session owns a different `Arc`, and its flag must survive.
    pub fn end(&self, session_id: &str, flag: &Arc<AtomicBool>) {
        let mut map = self.0.lock();
        if map.get(session_id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            map.remove(session_id);
        }
    }

    /// Trip the flag for one session. No-op when that session has nothing in
    /// flight (a stale stop click from a tab whose stream already finished).
    pub fn request_stop(&self, session_id: &str) {
        if let Some(flag) = self.0.lock().get(session_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod stop_registry_tests {
    use super::*;

    #[test]
    fn stop_reaches_only_its_own_session() {
        let reg = StopRegistry::default();
        let a = reg.begin("a");
        let b = reg.begin("b");

        reg.request_stop("a");

        assert!(a.load(Ordering::SeqCst), "the stopped session must see it");
        assert!(!b.load(Ordering::SeqCst), "a bystander session must keep generating");
    }

    #[test]
    fn starting_a_session_does_not_unstop_another() {
        // The old global flag was reset by every new generation, so this
        // sequence silently revived a stream the user had already stopped.
        let reg = StopRegistry::default();
        let a = reg.begin("a");
        reg.request_stop("a");

        let _b = reg.begin("b");

        assert!(a.load(Ordering::SeqCst), "a's stop must survive b starting");
    }

    #[test]
    fn a_stale_stop_cannot_abort_the_next_generation() {
        let reg = StopRegistry::default();
        let first = reg.begin("a");
        reg.end("a", &first);

        let second = reg.begin("a");
        reg.request_stop("a");
        assert!(second.load(Ordering::SeqCst));

        // ...but ending the FIRST generation again must not evict the second's
        // flag, or the stop would land on nothing.
        reg.end("a", &first);
        reg.request_stop("a");
        assert!(second.load(Ordering::SeqCst));
    }

    #[test]
    fn stopping_an_idle_session_is_a_no_op() {
        let reg = StopRegistry::default();
        reg.request_stop("nobody");
    }
}

impl std::ops::Deref for AppState {
    type Target = cinderpaw_core::runtime::RuntimeState;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

pub(crate) fn download_key(repo_id: &str, filename: &str) -> String {
    format!("{}::{}", repo_id, filename)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProgressPayload {
    pub percentage: f64,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DownloadProgress {
    pub repo_id: String,
    pub filename: String,
    pub progress: f32,
}

// ---------- Model commands ----------


// ---------- Chat ----------


// ---------- System ----------


// ---------- Agents ----------


// ---------- Cinderpaw Agent ----------





// ---------- Conversations ----------


// ---------- Voice messages (on-device STT) ----------




// ---------- Projects ----------


// ---------- Settings ----------


// ---------- BYOK ----------





// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logs go to a FILE, not stdout. A GUI process on Windows has no visible
    // stdout, which meant every tracing line — including everything the
    // sidecar prints ([cinderpaw-agent] …) — vanished into the void. When the
    // memory capture pipeline went quiet for four days (2026-08-20..24) there
    // was literally nowhere to look for why. The file lives next to the rest
    // of the app's state so support starts and ends in one folder.
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .with_ansi(false)
        .with_writer(move || -> Box<dyn std::io::Write> {
            // `dirs::home_dir()`, not `USERPROFILE`: that variable exists only on
            // Windows, so every macOS and Linux desktop user had no log file at
            // all — and a GUI process has no visible stdout to fall back to, so
            // the reason for anything going wrong landed nowhere on two of the
            // three platforms we ship.
            if let Some(home) = dirs::home_dir() {
                let dir = home.join(cinderpaw_core::brand::APP_HOME_DIR_NAME).join("logs");
                if std::fs::create_dir_all(&dir).is_ok() {
                    if let Ok(f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join("cinderpaw.log"))
                    {
                        return Box::new(f);
                    }
                }
            }
            Box::new(std::io::stdout())
        })
        .init();

    // The rename moves `~/.feral` to `~/.cinderpaw` on the first start after
    // upgrading. It is fatal when it fails — but on the desktop, "fatal" without
    // this block means the window never appears and the reason goes to a
    // terminal nobody opened. From the person's side the app simply stopped
    // working after an update, which is the worst thing this rename could do to
    // them. So the reason gets a window of its own.
    //
    // `rfd` rather than `tauri-plugin-dialog`: this runs before the Tauri app is
    // built, so there is no handle for a plugin to hang off. It is already in
    // the tree as that plugin's own dependency, so this costs nothing.
    match cinderpaw_core::migrate_home::ensure_migrated() {
        Err(e) => {
            let msg = format!(
                "Cinderpaw could not move your data to its new home folder, so it stopped \
                 before changing anything.\n\n{e}\n\nYour existing data has not been touched \
                 or deleted."
            );
            eprintln!("[cinderpaw] FATAL: {msg}");
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("Cinderpaw could not start")
                .set_description(&msg)
                .show();
            std::process::exit(1);
        }
        // A leftover old home is a housekeeping note, not a reason to refuse to
        // open. Say it once, plainly, name the folder, and carry on — the app
        // is already running on the new home. Warning level, not Error: nothing
        // is broken and nothing is lost.
        Ok(cinderpaw_core::migrate_home::MigrationOutcome::LeftoverLegacyHome { legacy }) => {
            let msg = format!(
                "Cinderpaw is using its new data folder, and an older one is still on \
                 disk at {}.\n\nNothing was moved, changed or deleted. If you have been \
                 using Cinderpaw since the update, everything you have is in the new \
                 folder and the old one is safe to delete once you have checked it.",
                legacy.display()
            );
            // The log line every boot; the modal exactly once.
            //
            // A dialog that blocks startup until it is dismissed is fine as a
            // one-time notice and intolerable as a greeting. Somebody who reads
            // it and decides to keep the old folder — which is a legitimate
            // choice, it is their data — would otherwise be made to click it
            // away on every single launch, forever, for a decision they have
            // already made.
            //
            // The receipt goes in the NEW home, which is ours to write in. It
            // records WHICH folder was reported, so a different leftover later
            // is a fresh notice rather than one silently swallowed.
            eprintln!("[cinderpaw] {msg}");
            let receipt = cinderpaw_core::paths::cinderpaw_dir().join(".legacy-home-notice");
            let already_told = std::fs::read_to_string(&receipt)
                .map(|seen| seen.trim() == legacy.to_string_lossy())
                .unwrap_or(false);
            if !already_told {
                // Best effort, and BEFORE the dialog: the receipt records that
                // we told them, and the app must not depend on the dialog
                // returning to get on with starting.
                if let Some(parent) = receipt.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&receipt, legacy.to_string_lossy().as_bytes());
                // On its own thread, because `show()` blocks until dismissed
                // and this runs before the window exists — so a housekeeping
                // note was standing between the person and their app, with the
                // dialog as the only window on screen. "The app won't open" is
                // what that looks like from the outside, which is precisely the
                // impression this whole path exists to avoid.
                std::thread::spawn(move || {
                    rfd::MessageDialog::new()
                        .set_level(rfd::MessageLevel::Warning)
                        .set_title("An older Cinderpaw data folder is still there")
                        .set_description(&msg)
                        .show();
                });
            }
        }
        Ok(_) => {}
    }

    // The database file was renamed with the app too, and unlike the folder
    // nothing had ever moved it: an install from before the rename kept its
    // whole history in `agent/feral.db` while the host asked SQLite for
    // `agent/cinderpaw.db` — a name SQLite creates, empty, without complaint.
    // The result was an app that opened perfectly and knew nothing: no
    // conversations, no memories, no teammates. `migrate_agent_db` renames the
    // old file into place when that is safe and reports when it is not; this
    // is only the reporting half. Resolving it here also settles the choice
    // before anything opens the database.
    if let Some(notice) = cinderpaw_core::migrate_agent_db::notice() {
        use cinderpaw_core::migrate_agent_db::DbNotice;
        let mb = |b: u64| format!("{:.1} MB", b as f64 / (1024.0 * 1024.0));
        let (title, msg, key) = match notice {
            // The one case with a real decision in it, so it gets the numbers.
            // Whichever file is theirs, the sizes say which is which faster
            // than any sentence could.
            DbNotice::BothPresent { current, current_bytes, legacy, legacy_bytes } => (
                "Two Cinderpaw databases are on disk",
                format!(
                    "Cinderpaw is using:
  {} ({})

An older database from before the                      rename is also there:
  {} ({})

Nothing has been moved, changed or                      deleted. If your conversations, memories or teammates look missing, close                      Cinderpaw, rename the file it is using to cinderpaw.db.bak, rename the older                      file to cinderpaw.db, and start Cinderpaw again.",
                    current.display(), mb(*current_bytes), legacy.display(), mb(*legacy_bytes)
                ),
                format!("both:{}", legacy.display()),
            ),
            // Nothing is wrong here — the data is open and in use, just under
            // its old name — so this says what happened and asks for nothing.
            DbNotice::OpenedLegacyInPlace { legacy, reason } => (
                "Cinderpaw is using its older database file",
                format!(
                    "Cinderpaw could not rename {} to cinderpaw.db, so it opened it where it                      is.

{}

Everything is there and nothing is at risk. Cinderpaw will                      try again the next time it starts.",
                    legacy.display(), reason
                ),
                format!("inplace:{}", legacy.display()),
            ),
        };
        // Same contract as the leftover-home notice above: the log line every
        // boot, the modal exactly once per distinct situation, and never on the
        // thread that still has to get a window on screen.
        eprintln!("[cinderpaw] {msg}");
        let receipt = cinderpaw_core::paths::cinderpaw_dir().join(".agent-db-notice");
        let already_told = std::fs::read_to_string(&receipt)
            .map(|seen| seen.trim() == key)
            .unwrap_or(false);
        if !already_told {
            if let Some(parent) = receipt.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&receipt, key.as_bytes());
            std::thread::spawn(move || {
                rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Warning)
                    .set_title(title)
                    .set_description(&msg)
                    .show();
            });
        }
    }

    // The webview keeps its storage in a directory named after the bundle
    // identifier, and that identifier moved with the rename — so without this
    // the renamed build opens an empty profile and the person loses their
    // theme, language, onboarding state and chosen voice engines in one go.
    // Must run before any window exists, which is why it sits here.
    //
    // Never fatal. Unlike the home directory, nothing here is data the person
    // created — it is settings, and starting with default settings is a bad
    // morning rather than a lost archive.
    match migrate_webview::migrate() {
        Ok(migrate_webview::Outcome::Copied { files }) => {
            tracing::info!(files, "carried the webview profile across the rename");
        }
        Ok(migrate_webview::Outcome::Skipped) => {}
        Err(e) => tracing::warn!(
            "could not carry the webview profile across the rename ({e});              settings from before the rename may need to be set again"
        ),
    }

    // Faza 4.5 Slice 2: the runtime (token + settings + ModelManager) is
    // built by the host-agnostic `cinderpaw_core::boot::build_runtime`. The
    // headless `cinderpaw-cli` gateway calls the same function — see
    // `crates/cinderpaw-cli/src/main.rs`.
    let runtime = cinderpaw_core::boot::build_runtime();

    // Pre-compute system info in a background thread so the first IPC call
    // returns instantly instead of waiting 2-3 s for PowerShell + sysinfo.
    // Tauri-only field on AppState; the headless gateway doesn't need it.
    let system_info_cache: Arc<Mutex<Option<SystemInfo>>> = Arc::new(Mutex::new(None));
    {
        let cache = system_info_cache.clone();
        std::thread::spawn(move || {
            let info = sysinfo_mod::collect();
            *cache.lock() = Some(info);
        });
    }

    let state = AppState {
        runtime,
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signals: Arc::new(StopRegistry::default()),
        system_info_cache,
        cinderpaw_model_config: Arc::new(Mutex::new(None)),
        live_call: Arc::new(Mutex::new(None)),
        livekit_call: Arc::new(Mutex::new(None)),
    };

    let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            get_models,
            get_loaded_model,
            download_model,
            download_embedding_model,
            cancel_download,
            load_model,
            start_model_load,
            unload_model,
            set_lora_adapter,
            delete_model,
            chat_stream,
            stop_generation,
            get_system_info,
            disk_encryption::disk_encryption_status,
            save_agent,
            get_agents,
            delete_agent,
            get_agent_presets,
            run_agent,
            save_conversation,
            load_conversations,
            load_conversation,
            agent_is_ready,
            rename_conversation,
            delete_conversation,
            clear_all_conversations,
            save_voice_blob,
            whisper_model_present,
            transcribe_audio,
            transcribe_audio_cloud,
            ui_log,
            download_whisper_model,
            tts_providers,
            tts_has_key,
            tts_ready,
            tts_voices,
            tts_voice_present,
            download_tts_voice,
            speak_text,
            stop_speaking,
            start_live_call,
            send_live_audio,
            send_live_text,
            live_voices,
            end_live_call,
            start_livekit_call,
            end_livekit_call,
            warm_livekit,
            list_s2s_providers,
            stt_local_available,
            load_projects,
            save_project,
            delete_project,
            get_settings,
            save_settings,
            set_desktop_control_enabled,
            set_desktop_control_yolo,
            set_token_budget_conversation,
            set_rsi_budget,
            set_rsi_allow_cloud_dreams,
            set_dreams_enabled,
            search_hf_models,
            get_hf_model_detail,
            get_model_size_info,
            get_hf_model_size,
            get_byok_settings,
            provider_catalog,
            setup_detect,
            setup_verify,
            save_byok_provider,
            remove_byok_provider,
            test_byok_provider,
            chat_cloud_stream,
            chat_complete_local,
            chat_cloud_complete,
            read_file_as_text,
            read_file_as_data_url,
            extract_file_text,
            skills::list_installed_skills,
            skills::get_installed_skill_content,
            skills::fetch_remote_skills,
            skills::fetch_community_skills,
            skills::preview_remote_skill,
            skills::preview_local_skill,
            skills::skill_exists_cmd,
            skills::install_capability,
            skills::inspect_capability,
            skills::install_skill_from_url,
            skills::install_skill_from_file,
            skills::remove_skill,
            cinderpaw_send_message,
            cinderpaw_agent_status,
            cinderpaw_stop_generation,
            cinderpaw_submit_feedback,
            cinderpaw_run_fractal_benchmark,
            cinderpaw_dream_now,
            cinderpaw_meta,
            cinderpaw_governance,
            cinderpaw_modules,
            cinderpaw_code_patches_list,
            cinderpaw_code_patch_resolve,
            cinderpaw_cowork_approval_resolve,
            cinderpaw_cowork_send_message,
            cinderpaw_cowork_history,
            cinderpaw_lora_reviews_list,
            cinderpaw_lora_review_resolve,
            cinderpaw_lora_train,
            cinderpaw_fractal_cluster_leaves,
            cinderpaw_set_model,
            cinderpaw_get_model_config,
            get_local_api_token,
            cinderpaw_ask_user_response,
            cinderpaw_ask_user_cancel,
            get_onboarding_record,
            set_onboarding_record,
            list_ollama_models,
            mcp::mcp_catalog,
            mcp::mcp_list,
            mcp::mcp_install,
            mcp::mcp_set_enabled,
            mcp::mcp_remove,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            connectors::connectors_catalog,
            connectors::connectors_list,
            connectors::connectors_save,
            connectors::connectors_set_enabled,
            connectors::connectors_remove,
            connectors::connectors_whatsapp_qr,
            connectors::connector_accounts_list,
            connectors::connector_pair_start,
            connectors::connector_pair_poll,
            connectors::connector_refresh_expired,
            memory_graph::get_memory_graph,
            memory_graph::add_memory_facts,
            memory_resume::get_last_task,
            desktop_control::list_windows,
            desktop_control::get_accessibility_tree,
            desktop_control::find_elements,
            desktop_control::click_element,
            desktop_control::type_into_element,
            desktop_control::get_element_value,
            desktop_control::get_focused_element,
            desktop_control::take_element_action,
            desktop_control::send_keys,
            desktop_control::launch_app,
            rsi::commands::rsi_init,
            rsi::commands::rsi_status,
            rsi::commands::rsi_get_bounds,
            rsi::commands::rsi_update_bounds,
            rsi::commands::rsi_score,
            rsi::commands::rsi_get_tier0_specs,
            rsi::commands::rsi_commit_genome,
            rsi::commands::rsi_ratchet_attempt,
            rsi::commands::rsi_log,
            rsi::commands::rsi_lca,
            rsi::commands::rsi_diff,
            rsi::commands::rsi_record_goodhart_sample,
            rsi::commands::rsi_reset_goodhart,
            rsi::commands::rsi_start,
            rsi::commands::rsi_stop,
            rsi::commands::rsi_set_concurrency,
            rsi::commands::rsi_dream_telemetry,
            rsi::commands::rsi_journal_recent,
            rsi::commands::rsi_champion_tree,
        ])
        .events(tauri_specta::collect_events![
            crate::events::TokenEvent,
            crate::events::StreamDoneEvent,
            crate::events::StreamErrorEvent,
            crate::events::StreamTruncatedEvent,
            crate::events::StreamProgressEvent,
            crate::events::DownloadProgressEvent,
            crate::events::DownloadCompleteEvent,
            crate::events::DownloadErrorEvent,
            crate::events::ModelLoadProgressEvent,
            crate::events::AgentStreamEvent,
            crate::events::CinderpawAgentOutputEvent,
            crate::events::TtsChunkEvent,
            crate::events::LiveStatusEvent,
        ]);

    // TODO: re-enable once all u64 fields have #[specta(type = Number)] annotations.
    // The specta export requires every u64/i64 field to be annotated because
    // TypeScript loses precision on integers > 2^53.
    // #[cfg(debug_assertions)]
    // specta_builder
    //     .export(
    //         specta_typescript::Typescript::default()
    //             .header("// AUTO-GENERATED — do not edit. Regenerated by `cargo tauri dev/build`.\n"),
    //         "../frontend-react/src/lib/tauri/bindings.ts",
    //     )
    //     .expect("failed to export specta bindings");

/// The window material, in one place.
///
/// Built by a function rather than written twice, because the second caller is
/// the focus handler: if the two ever disagree, the window quietly changes
/// material the first time you click away from it and back, which is a bug
/// nobody would think to look for in a config literal.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn window_effects() -> tauri::utils::config::WindowEffectsConfig {
    #[cfg(target_os = "windows")]
    let effect = tauri::utils::WindowEffect::Acrylic;
    #[cfg(target_os = "macos")]
    let effect = tauri::utils::WindowEffect::UnderWindowBackground;

    // Used only on Windows 10 and on Windows 11 below build 22523, where
    // acrylic still goes through the legacy call that accepts a tint. Newer
    // builds ignore it entirely. Kept rather than passing `None`, because on
    // those older machines `None` means "whatever the crate defaults to", and a
    // default nobody has seen is exactly the kind of thing that sits invisibly
    // between the app and the desktop.
    #[cfg(target_os = "windows")]
    let color = Some(tauri::utils::config::Color(16, 14, 9, 24));
    #[cfg(target_os = "macos")]
    let color = None;

    tauri::utils::config::WindowEffectsConfig {
        effects: vec![effect],
        // `Active`, not the default `FollowsWindowActiveState`. The default is
        // literally "go opaque when the window is not the active one", which is
        // why the glass kept collapsing the moment focus moved elsewhere. For a
        // window somebody keeps beside their work — the whole point of a
        // see-through app — inactive is most of the time it is on screen.
        // macOS reads this (NSVisualEffectView's `state`); Windows ignores it,
        // and gets the reapply-on-focus handler instead.
        state: Some(tauri::utils::WindowEffectState::Active),
        radius: None,
        color,
    }
}

    let specta_builder_for_setup = specta_builder.clone();
    tauri::Builder::default()
        // Acrylic, and NOT Blur. This was tried the other way round and the
        // window became unusable, so the reason is worth writing down once.
        //
        // `window-vibrancy` picks a different Windows API per effect, and the
        // APIs are not equivalent:
        //
        //   Blur    -> SetWindowCompositionAttribute(ACCENT_ENABLE_BLURBEHIND)
        //              on everything past Windows 7. That is the legacy,
        //              unaccelerated path: DWM recomposites the blur region
        //              itself on every move, so dragging the window flickers,
        //              tears between transparent and opaque, and drags the
        //              whole desktop's frame rate down with it. It shows more
        //              of what is behind — and it costs the machine.
        //   Acrylic -> DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE,
        //              DWMSBT_TRANSIENTWINDOW) on build 22523 and newer, which
        //              is GPU-composited and smooth. Below that build it falls
        //              back to the same legacy call as Blur.
        //   Mica    -> also DwmSetWindowAttribute, also smooth, but it samples
        //              the WALLPAPER and flattens it: by design it shows
        //              nothing of what is actually behind the window. It
        //              arrived as a flat brown wash.
        //
        // So on a current Windows 11 the honest choice is: frosted and smooth
        // (Acrylic), or more see-through and juddering (Blur). Frosted wins —
        // a window that stutters while you move it is not a nicer window.
        //
        // One consequence to know before reaching for it: on the backdrop-type
        // path the `color` field is NOT passed to the OS at all — the crate
        // only forwards it on the legacy branch. On a modern Windows 11 the
        // tint belongs to DWM and nothing here can change it, so the only
        // remaining controls over how see-through this looks are in the
        // stylesheet: `--scene-surface`, and how much the scene paints on top.
        //
        // The page only goes see-through where the OS actually blurs what is
        // behind it. `windowEffects` is ignored on platforms that cannot honour
        // it, but `transparent: true` is not — so on Linux, where there is no
        // Mica and no vibrancy, a transparent page would put the app's text
        // straight onto the user's wallpaper with nothing between them. The
        // stylesheet keeps its opaque background until this class says the
        // blur is real.
        //
        // Set on page load rather than at setup: a script evaluated before the
        // document exists has nothing to add the class to, and the failure
        // looks like the effect not working.
        //
        // Applying the effect and marking the page happen in the same closure,
        // in that order, on purpose. They used to be two places — the effect in
        // `setup`, the class here — and the class went on unconditionally, so a
        // Windows build where the OS refused the effect got a genuinely
        // transparent window with `has-window-effect` promising a blur that was
        // not there. Every surface in the app is translucent now, so that is no
        // longer a slightly-too-dark titlebar: it is the whole application
        // printed onto somebody's wallpaper. The claim and the fact are made
        // together, and only a successful call is allowed to make the claim.
        .on_page_load(|window, _| {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                // This call returns a Result and the config does not.
                // "Configured" and "applied" are different facts, and the gap
                // between them is invisible — an effect the OS refused looks
                // exactly like an effect nobody asked for. This says which.
                // `.window()`: the effect belongs to the OS window, the `eval`
                // to the webview inside it.
                match window.window().set_effects(window_effects()) {
                    Ok(()) => {
                        // Logged, because the failure is invisible: if this does
                        // not land the window simply stays opaque and looks like
                        // the effect was never configured. One line in the log
                        // is the difference between "not supported" and "never
                        // ran".
                        match window
                            .eval("document.documentElement.classList.add('has-window-effect')")
                        {
                            Ok(()) => {
                                tracing::info!(
                                    "window effect: {:?} applied, page marked as blurred-behind",
                                    window_effects().effects,
                                );
                            }
                            Err(e) => {
                                tracing::warn!("window effect: could not mark the page ({e})");
                            }
                        }
                    }
                    Err(e) => tracing::warn!(
                        "window effect: the OS refused {:?} ({e}) — the app stays on \
                         its own opaque background, which is the correct look for a machine \
                         that cannot blur",
                        window_effects().effects,
                    ),
                }
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let _ = &window;
        })
        // Windows drops the backdrop by itself — Energy Saver switches it off,
        // and so does toggling "Transparency effects" system-wide — and it
        // never turns it back on. Nothing tells the app; the window simply
        // becomes opaque and stays that way for the rest of the session, which
        // reads as "the glass broke after a while". Reasserting the material
        // whenever the window comes back to the front is the only hook we get,
        // and it is cheap: one DWM call on an event that happens when a person
        // is already looking at the window.
        //
        // Not gated on the previous state, because there is no way to read it.
        // Setting the same backdrop twice is a no-op in DWM.
        .on_window_event(|window, event| {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            // BOTH transitions, not just regaining focus.
            //
            // Reasserting only on `Focused(true)` cannot fix "it is opaque
            // while I am not using it": by the time that fires, the person is
            // already back. The window is unfocused for most of the time it is
            // on screen — which is the whole point of an app you keep beside
            // your work — so the inactive state is the one that has to hold the
            // material, and it is the only moment we get to say so.
            if matches!(event, tauri::WindowEvent::Focused(_)) {
                if let Err(e) = window.set_effects(window_effects()) {
                    tracing::debug!("window effect: could not reassert on focus ({e})");
                }
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = (window, event);
            }
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Warm launch on Windows/Linux: the OS spawns a second instance
            // with the deep-link URL as a CLI arg. The deep-link plugin's
            // `deep-link` feature (enabled on single-instance) has already
            // emitted `deep-link://new-url` at this point, but we also handle
            // the raw args directly so the window focuses even if the event
            // hasn't been processed yet. Only `cinderpaw://open` is honoured.
            let urls: Vec<url::Url> = args
                .iter()
                .filter_map(|a| a.parse::<url::Url>().ok())
                .collect();
            if !urls.is_empty() {
                crate::deep_link::handle_urls(app, urls);
            } else {
                // No URL — still focus the existing window. The user
                // double-clicked the app icon while it was already running.
                crate::deep_link::focus_main_window(app);
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state)
        .setup(move |app| {
            specta_builder_for_setup.mount_events(app);
            let _handle = app.handle().clone();

            // (The window effect used to be applied here, a second time and in
            // a second place. It now lives in `on_page_load` alongside the class
            // that depends on it — see the note there.)

            // Faza 4.5 Slice 2: every runtime service (AMD-guard, RSI
            // bootstrap, env exports, API server, supervised sidecar)
            // delegates to the host-agnostic `cinderpaw_core::boot::start`.
            // The headless `cinderpaw-cli` gateway calls the same function with
            // a different `events` and `desktop_control = None` — see
            // `crates/cinderpaw-cli/src/main.rs`.
            //
            // `boot::start` is `async` (Task 4 smoke fix: a sync version
            // panicked with "no reactor running" when Tauri 2's sync setup
            // closure called `tokio::spawn` inside it). Tauri's
            // `async_runtime::spawn` works in both sync and async contexts,
            // so the setup closure stays sync and the boot runs in the
            // background — same pattern the MCP reconnect below uses.
            let runtime = app.handle().state::<AppState>().runtime.clone();
            let events: Arc<dyn cinderpaw_core::host::HostEvents> =
                Arc::new(TauriEvents(app.handle().clone(), runtime.events_tx.clone()));
            let desktop_control: Option<cinderpaw_core::host::DesktopControlHandler> = {
                let dc: cinderpaw_core::host::DesktopControlHandler =
                    Arc::new(|action, params| {
                        Box::pin(async move {
                            crate::desktop_control::handle_request(&action, &params).await
                        })
                    });
                Some(dc)
            };
            // Capability bridge. The sidecar sends a NAME; everything that
            // name means — which catalogue it came from, how far it is
            // trusted, what bytes land on disk — is decided here, on the host
            // side of the boundary. The agent can ask for a capability; it
            // cannot vouch for one, and it cannot hand us content to write.
            let capabilities: Option<cinderpaw_core::host::CapabilityHandler> = {
                let cap: cinderpaw_core::host::CapabilityHandler =
                    Arc::new(|action, params| {
                        Box::pin(async move {
                            crate::skills::handle_capability_request(&action, &params).await
                        })
                    });
                Some(cap)
            };
            // Admin bridge — update and model switching, so the person does
            // not have to open a terminal for the things they set Cinderpaw up to
            // handle. Captures the AppHandle because both need it: the updater
            // plugin lives on it, and model switching goes through the same
            // command the UI uses so the two never disagree about what is
            // loaded.
            let admin: Option<cinderpaw_core::host::AdminHandler> = {
                let handle = app.handle().clone();
                let adm: cinderpaw_core::host::AdminHandler = Arc::new(move |action, params| {
                    let handle = handle.clone();
                    Box::pin(async move {
                        crate::admin_bridge::handle(handle, &action, &params).await
                    })
                });
                Some(adm)
            };
            let extra_bin_dirs: Vec<PathBuf> = vec![app.path().resource_dir().ok()]
                .into_iter()
                .flatten()
                .collect();
            tauri::async_runtime::spawn(async move {
                cinderpaw_core::boot::start(
                    runtime,
                    events,
                    desktop_control,
                    capabilities,
                    admin,
                    extra_bin_dirs,
                    // The desktop host has no single-instance probe to hand
                    // over; the API server binds the port itself.
                    None,
                )
                .await;
            });

            // Slice 6: bootstrap bridge for the Browser App onboarding
            // surface. Starts unconditionally with Tauri (NOT gated on
            // gateway status — the bridge serves `running: false` to
            // the browser when the gateway is down, so the browser can
            // distinguish "bridge unavailable" from "bridge up, gateway
            // down"). The bridge binds 127.0.0.1:11437 only and dies
            // with the Tauri process; see `commands/bootstrap.rs`.
            crate::commands::bootstrap::start_bridge(app.handle().clone());

            // Deep-link: `cinderpaw://open` handoff from the Browser App
            // (`https://cinderpaw.dev/app` → "Open Cinderpaw Desktop").
            // Registration lives in `tauri.conf.json` (`plugins.deep-link`);
            // the handler lives in `deep_link.rs`.
            {
                let app_handle = app.handle().clone();
                // Warm launch on macOS/iOS/Android: the plugin emits
                // `deep-link://new-url` while the app is already running.
                // Use the typed `on_open_url` helper which listens for that
                // event. The DeepLink state is set by `tauri_plugin_deep_link`.
                if let Some(deep_link) = app.try_state::<tauri_plugin_deep_link::DeepLink<tauri::Wry>>() {
                    let handle_for_event = app_handle.clone();
                    deep_link.on_open_url(move |event| {
                        crate::deep_link::handle_urls(&handle_for_event, event.urls());
                    });
                }
                // Cold launch: if the app was started via `cinderpaw://open`,
                // `get_current` returns the initial URLs (Windows/Linux CLI
                // arg, or macOS Opened event already captured by the plugin).
                if let Some(deep_link) = app.try_state::<tauri_plugin_deep_link::DeepLink<tauri::Wry>>() {
                    if let Ok(Some(urls)) = deep_link.get_current() {
                        if !urls.is_empty() {
                            crate::deep_link::handle_urls(&app_handle, urls);
                        }
                    }
                }
            }

            // MCP extensions: no host-side reconnect anymore (R5). The
            // sidecar's McpManager reconciles `~/.cinderpaw/mcp.json` at its own
            // boot and on every `mcp_reload` poke — desktop and headless
            // gateway get identical behavior for free.

            // No model auto-load. The user picks a model explicitly from the UI
            // (Local Models tab / Onboarding). Auto-loading on every startup
            // caused lag (model mmap takes seconds and several GB of RAM/VRAM)
            // and crashed the host for non-technical users who didn't know
            // why their machine froze. Removal: 2026-06-30, per user report.

            Ok(())
        })
        .invoke_handler(specta_builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let mut fa_guard = state.cinderpaw_agent_process.lock();
                    if let Some(ref mut child) = *fa_guard {
                        let _ = child.start_kill();
                        tracing::info!("Cinderpaw Agent sidecar stopped");
                    }
                    // Drop the tx so the stdin writer task exits cleanly.
                    *state.cinderpaw_agent_tx.lock() = None;
                }
            }
        });
}

#[cfg(test)]
mod tests {

    /// The markup can be perfect and the window still immovable.
    ///
    /// `data-tauri-drag-region` does nothing unless the window is allowed to
    /// start a drag, and a missing permission reports no fault anywhere: no
    /// console error, no log line, just a window that will not move. The
    /// frontend guards the markup (`dragRegion.test.ts`); this guards the half
    /// that makes it mean anything.
    #[test]
    fn window_drag_permission_is_granted() {
        let caps = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut granted = String::new();
        for entry in std::fs::read_dir(&caps).expect("capabilities directory").flatten() {
            if entry.path().extension().is_some_and(|e| e == "json") {
                granted.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
            }
        }
        assert!(
            granted.contains("core:window:allow-start-dragging"),
            "the window cannot be dragged and nothing will say why",
        );
    }

    use super::*;

    #[test]
    fn download_key_format() {
        assert_eq!(download_key("TheBloke/Mistral-7B", "model.Q4_K_M.gguf"),
                   "TheBloke/Mistral-7B::model.Q4_K_M.gguf");
    }

    #[test]
    fn download_key_uniqueness() {
        let k1 = download_key("repo/a", "file.gguf");
        let k2 = download_key("repo/b", "file.gguf");
        let k3 = download_key("repo/a", "other.gguf");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_ne!(k2, k3);
    }

}
