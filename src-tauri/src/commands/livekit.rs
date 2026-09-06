//! The LiveKit call, from the webview's side.
//!
//! Two commands, because a self-hosted call has exactly two states worth
//! naming: running, and not. Everything that makes it run — resolving a server
//! binary, booting it on loopback, minting credentials, starting the far end —
//! is `cinderpaw_core::livekit`'s problem, and none of it is the webview's
//! business beyond the URL and token it needs to join.
//!
//! Note what does NOT cross this boundary: audio. Unlike the Gemini Live engine
//! next door, where every microphone frame is base64'd through Tauri's IPC, here
//! the webview speaks WebRTC directly to a server on 127.0.0.1. That is the
//! whole reason for choosing a real media stack — the audio path stops being
//! ours to carry, and stops being ours to get wrong.
//!
//! What DOES cross it: what was said, and what went wrong. Both arrive as
//! `cinderpaw://livekit-event`.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// How long a finished call's machinery is kept alive before it is taken down.
///
/// The chain costs about fourteen seconds to start — server boot, Node, the
/// Agents SDK, a local end-of-turn model. Paying that on every call is what
/// turns a feature into one people avoid, and a conversation that drops and has
/// to be restarted is exactly when the wait hurts most. Keeping it warm for a
/// few minutes makes the second call instant; taking it down afterwards means a
/// person who tried voice once is not left with a voice server and a Node
/// process running for the rest of the session.
const IDLE_SHUTDOWN: std::time::Duration = std::time::Duration::from_secs(180);

/// Bumped every time a call starts or ends. The idle timer captures the value
/// it was armed at and does nothing if it changed — which is the whole
/// cancellation mechanism, and it is a number rather than a task handle because
/// the thing being cancelled is "the intent to shut down", not a task.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// One row in the voice-provider picker.
#[derive(serde::Serialize, specta::Type)]
pub struct S2sProviderInfo {
    pub id: String,
    pub label: String,
    /// Every voice this vendor offers. The picker lists these and nothing else
    /// — a voice id belongs to the vendor that issued it.
    pub voices: Vec<String>,
    /// Assembled from the app's own STT / model / TTS choices instead of being
    /// one vendor's session. The screen shows those choices when this row is
    /// selected, rather than a "no key" note it does not need — and works out
    /// whether anything leaves the device from the engines themselves.
    pub pipeline: bool,
    /// The one used when the user has not picked.
    pub default_voice: String,
    /// Whether a key for it is actually stored. The picker needs this to show
    /// what a choice will DO — an option that silently produces an echo because
    /// its key was never pasted is the shape of bug this whole change is about.
    pub connected: bool,
}

/// The speech-to-speech vendors this build can run a call on.
///
/// Served from Rust rather than listed in the frontend because the same table
/// decides which npm plugin gets installed. A second list in TypeScript would
/// be free to offer a vendor the agent cannot load.
#[tauri::command]
#[specta::specta]
pub(crate) fn list_s2s_providers() -> Vec<S2sProviderInfo> {
    cinderpaw_core::livekit::S2S_PROVIDERS
        .iter()
        .map(|p| S2sProviderInfo {
            id: p.id.to_string(),
            label: p.label.to_string(),
            // A realtime vendor publishes a fixed list. The pipeline's voices
            // belong to whichever TTS engine is picked and come from that
            // engine's own picker, so this row publishes none — a list here
            // would be a second, smaller catalogue quietly overriding the real
            // one, which is how this row first shipped hard-wired to Piper.
            voices: if p.pipeline {
                Vec::new()
            } else {
                p.voices.iter().map(|v| v.to_string()).collect()
            },
            default_voice: p.voice.to_string(),
            pipeline: p.pipeline,
            // The pipeline is always reachable: it holds no key of its own, and
            // its halves answer for theirs.
            connected: p.pipeline || cinderpaw_core::byok::byok_get(p.id).is_some(),
        })
        .collect()
}

/// What the webview needs to join the room, and nothing else.
#[derive(serde::Serialize, specta::Type)]
pub struct LiveKitCall {
    /// Always loopback. Named rather than assumed, so the day it stops being
    /// loopback the webview is not the last to find out.
    pub url: String,
    pub token: String,
    pub room: String,
    /// "assistant" when a key is stored for some speech-to-speech provider,
    /// "echo" when none is. The UI must say which: a diagnostic that presents
    /// itself as an assistant is worse than no assistant.
    pub mode: String,
    /// True when this call reused machinery that was already running. Reported
    /// so the difference between a fourteen-second start and an instant one is
    /// visible to whoever is wondering why it varies.
    pub warm: bool,
}

/// Start the local call, or join the one whose machinery is already up.
///
/// Errors are messages meant for a person, with one exception worth knowing:
/// `livekit-no-node` is a code, because "install Node" needs a link and a
/// sentence the UI can translate, not a string from Rust.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_livekit_call(
    app: AppHandle,
    state: State<'_, AppState>,
    // The speech-to-speech vendor the user picked, or `None` when they have
    // not. `None` is not "no assistant": Rust falls back to whichever provider
    // has a key stored, so pasting a key is enough to get a talking call
    // without also having to find a picker.
    provider: Option<String>,
    // The voice picked for that provider, if any. Rust rejects an id that
    // does not belong to the provider rather than forwarding it — a stale id
    // from a previous vendor is refused mid-session, i.e. a call that connects
    // and then dies.
    voice: Option<String>,
    // Pipeline mode only: which engine speaks, and which transcription model
    // listens. Both are existing product settings with their own pickers; they
    // are passed in rather than read here so there is one source of truth.
    tts_engine: Option<String>,
    stt_model: Option<String>,
    stt_provider: Option<String>,
    stt_language: Option<String>,
) -> Result<LiveKitCall, String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);

    let wanted = cinderpaw_core::livekit::session_spec(
        provider.as_deref(),
        voice.as_deref(),
        tts_engine.as_deref(),
        stt_model.as_deref(),
        stt_provider.as_deref(),
        stt_language.as_deref(),
    );

    let extra: Vec<std::path::PathBuf> = app.path().resource_dir().ok().into_iter().collect();

    // The same briefing the engine being replaced sends, so the assistant on
    // the far end is the same character with the same rules about speaking.
    let brief =
        cinderpaw_core::live::Briefing { current_task: None, workspace: None, context: None };

    let emitter = app.clone();
    let runtime = state.runtime.clone();
    // Warm, booting, or not there at all, this is the one place that decides.
    //
    // `wait: true` is the entire entry-latency fix. The warmup started when the
    // pre-call screen appeared and takes about fourteen seconds; a button
    // pressed inside that window used to look in the slot, find it still empty,
    // and boot a SECOND chain from scratch. Waiting for the one already being
    // built turns that second full boot into whatever is left of the first.
    //
    // A chain warmed for another vendor is torn down in here rather than out
    // there, so there is one rule about when a warm chain may be reused and it
    // lives next to the gate that enforces it.
    let chain = cinderpaw_core::livekit::join_or_boot(
        &cinderpaw_core::livekit::BOOT_GATE,
        &state.livekit_call,
        &wanted,
        |s| s.spec.as_str(),
        true,
        || async move {
            cinderpaw_core::livekit::start(
                &extra,
                "you",
                Some(cinderpaw_core::live::system_instruction(&brief)),
                provider,
                voice,
                // Whichever engines the user actually picked. Hard-coding Piper
                // here is what made Kokoro, Fish Audio, Azure and ElevenLabs
                // unreachable from a call while all four sat in the catalogue.
                tts_engine,
                stt_model,
                stt_provider,
                stt_language,
                move |event| {
                    // Failing to emit is not worth interrupting a call over: the
                    // audio path is unaffected, and the person is mid-sentence.
                    if let Err(e) = emitter.emit("cinderpaw://livekit-event", event) {
                        tracing::warn!("livekit: could not forward an agent event ({e})");
                    }
                },
                // The runtime is what makes `ask_cinder` work: it is a door to
                // the local agent, and only a host that owns a sidecar can open
                // it.
                Some(runtime),
            )
            .await
        },
    )
    .await?;

    // One join path for both, because there is no difference worth branching
    // on: `rejoin` mints a room and a token, and a room being created is what
    // makes LiveKit dispatch the agent. A fresh token rather than the chain's
    // original one also means an app left open for an hour still joins.
    let mut slot = state.livekit_call.lock();
    let session = slot
        .as_mut()
        .ok_or_else(|| "the voice chain went away while the call was starting".to_string())?;
    let token = session.rejoin("you")?;
    tracing::info!(
        "livekit: joining a {} chain",
        if chain == cinderpaw_core::livekit::Chain::Warm { "warm" } else { "freshly booted" }
    );
    Ok(LiveKitCall {
        url: session.url.clone(),
        token,
        room: session.room.clone(),
        mode: session.mode.clone(),
        warm: chain == cinderpaw_core::livekit::Chain::Warm,
    })
}

/// Bring the whole chain up while the pre-call screen is on, so pressing Call
/// is a join and not a boot.
///
/// This used to run `ensure_agent` and stop — an npm install, which is already
/// done on every machine after the first call. The fifteen to twenty seconds a
/// person actually waits are the two things it never touched: the LiveKit
/// server booting until it answers HTTP, and Node loading the Agents SDK, the
/// vendor plugin and (for the pipeline) a voice-activity model. So the warmup
/// warmed the one step that was already warm, and the button still cost the
/// whole wait. It now does exactly what `start` does and parks the result where
/// `start` looks first.
///
/// Idempotent and silent. Failure is deliberately swallowed: the real `start`
/// does the same work and reports its own errors properly, and a warmup that
/// raises a dialog interrupts somebody who has not asked for anything yet.
#[tauri::command]
#[specta::specta]
pub(crate) async fn warm_livekit(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: Option<String>,
    voice: Option<String>,
    tts_engine: Option<String>,
    stt_model: Option<String>,
    stt_provider: Option<String>,
    stt_language: Option<String>,
) -> Result<(), String> {
    // Never touch a chain that already exists. It may be a live call, and a
    // warmup is not entitled to end one.
    if state.livekit_call.lock().is_some() {
        return Ok(());
    }
    if cinderpaw_core::toolchain::find_node().is_none() {
        return Ok(());
    }
    let extra: Vec<std::path::PathBuf> = app.path().resource_dir().ok().into_iter().collect();
    // A missing server binary means a download. `start` does that and reports
    // it; a background warmup must not silently pull megabytes on somebody
    // else's connection.
    if cinderpaw_core::livekit::find_server(&extra).is_none() {
        return Ok(());
    }

    let wanted = cinderpaw_core::livekit::session_spec(
        provider.as_deref(),
        voice.as_deref(),
        tts_engine.as_deref(),
        stt_model.as_deref(),
        stt_provider.as_deref(),
        stt_language.as_deref(),
    );

    let brief =
        cinderpaw_core::live::Briefing { current_task: None, workspace: None, context: None };
    let emitter = app.clone();
    let runtime = state.runtime.clone();
    // The same gate the button uses, asked not to wait. Two warmups racing
    // would boot two servers and two agents and only one could be parked; the
    // other would become orphan processes holding ports. The pre-call screen
    // can mount more than once (a re-render, a reopened overlay), so this is a
    // normal path, not a pathological one.
    let chain = match cinderpaw_core::livekit::join_or_boot(
        &cinderpaw_core::livekit::BOOT_GATE,
        &state.livekit_call,
        &wanted,
        |s| s.spec.as_str(),
        false,
        || async move {
            cinderpaw_core::livekit::start(
                &extra,
                "you",
                Some(cinderpaw_core::live::system_instruction(&brief)),
                provider,
                voice,
                tts_engine,
                stt_model,
                stt_provider,
                stt_language,
                move |event| {
                    if let Err(e) = emitter.emit("cinderpaw://livekit-event", event) {
                        tracing::warn!("livekit: could not forward an agent event ({e})");
                    }
                },
                Some(runtime),
            )
            .await
        },
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::info!("livekit: warmup did not finish ({e}); the call will do it");
            return Ok(());
        }
    };
    if chain != cinderpaw_core::livekit::Chain::Booted {
        return Ok(());
    }
    tracing::info!("livekit: warm, the next call is a join");

    // A warm chain nobody uses must not outlive the screen that asked for it.
    // The same timer the end of a call arms, for the same reason: somebody who
    // opened the voice panel once should not be left with a voice server and a
    // Node process for the rest of the session.
    let armed_at = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_SHUTDOWN).await;
        if GENERATION.load(Ordering::SeqCst) != armed_at {
            return; // a call came or went; that one owns the timer now
        }
        if let Some(state) = app.try_state::<AppState>() {
            let previous = state.livekit_call.lock().take();
            if previous.is_some() {
                tracing::info!("livekit: warm but unused, taking the voice server down");
            }
            drop(previous);
        }
    });

    Ok(())
}

/// Hang up, and let the machinery idle for a few minutes before taking it down.
///
/// Idempotent — the error path and the person pressing stop both end up here,
/// and a UI that had to track which one got there first would get it wrong
/// exactly when it matters.
#[tauri::command]
#[specta::specta]
pub(crate) async fn end_livekit_call(
    app: AppHandle,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let armed_at = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // The webview has already left the room by the time this runs, so the call
    // is over from the person's side no matter what happens below. What is
    // being delayed is only the teardown of the processes.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_SHUTDOWN).await;
        if GENERATION.load(Ordering::SeqCst) != armed_at {
            return; // another call came or went; that one owns the timer now
        }
        if let Some(state) = app.try_state::<AppState>() {
            let previous = state.livekit_call.lock().take();
            if previous.is_some() {
                tracing::info!("livekit: idle, taking the voice server down");
            }
            drop(previous);
        }
    });

    Ok(())
}
