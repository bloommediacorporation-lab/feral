//! On-device STT: voice blob capture, Whisper model download, transcription
//! (local + cloud) — and the outbound half, TTS streamed to the webview.

use crate::*;
use base64::Engine as _;
use parking_lot::Mutex;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Persist a recorded audio blob to the on-disk `voice/` dir. Returns the path.
#[tauri::command]
#[specta::specta]
pub(crate) async fn save_voice_blob(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    // First stage of a call turn to reach Rust. If this never logs, the microphone
    // or the VAD is where to look, not the engines.
    tracing::info!(bytes = bytes.len(), ext = %ext, "voice: blob received from the webview");
    // A cap, and a cleanup. Nothing bounded how large a "voice blob" could be —
    // the webview hands over a byte array — so a bug in the recorder (or a
    // deliberately large post) wrote it straight to disk. 100 MB of 24 kHz mono
    // PCM is about half an hour of speech, well past any single utterance.
    const MAX_BLOB_BYTES: usize = 100 * 1024 * 1024;
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(format!(
            "voice recording is {} MB — refusing to store more than {} MB",
            bytes.len() / 1024 / 1024,
            MAX_BLOB_BYTES / 1024 / 1024
        ));
    }
    let safe_ext = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
    let ext = if safe_ext.is_empty() { "webm".to_string() } else { safe_ext };
    let dir = paths::voice_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    // Nothing ever removed these. A conversation deleted through the UI takes
    // its blobs with it, but a recording the user re-took, or one from a chat
    // that was never saved, stayed on disk for the life of the install —
    // megabytes a day on an install used by voice, growing silently.
    prune_old_voice_blobs(&dir);
    Ok(path.to_string_lossy().into_owned())
}

/// Drop ORPHANED voice recordings older than the retention window.
///
/// The word orphaned is the whole fix. This used to delete every file older
/// than thirty days, which included the audio of voice messages sitting in
/// conversations the user had deliberately kept: record something in January,
/// keep the chat, record anything at all in March, and January's recording was
/// gone and its message pointed at a missing file. Nothing said so, because
/// this runs on the recording path and is silent by design.
///
/// Two rules, in this order:
///
///  1. **Age is only a candidate, never a reason.** A file is deletable when it
///     is old AND no saved conversation points at it.
///  2. **Unknown means keep.** If the conversations cannot be enumerated, the
///     set of references is unknown and nothing is deleted. Some megabytes of
///     stale audio is a cost nobody notices; deleting a recording somebody kept
///     cannot be undone.
///
/// Still best-effort and silent about its own failures: a tidy-up that cannot
/// run must never stop a recording from being saved.
fn prune_old_voice_blobs(dir: &std::path::Path) {
    const RETAIN: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else { return };

    // Collect first, delete later. Building the candidate list before touching
    // the conversations means the common case — nothing is old enough — pays
    // nothing at all for the reference scan.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else { continue };
        if modified.elapsed().unwrap_or_default() > RETAIN {
            candidates.push(entry.path());
        }
    }
    if candidates.is_empty() {
        return;
    }

    let Ok(referenced) =
        crate::conversations::referenced_audio_names_in_dir(&paths::conversations_dir())
    else {
        // Rule 2. One unreadable conversation file is enough to stop the whole
        // sweep, and that is the intended severity: we do not know what it
        // referenced.
        tracing::warn!(
            "voice: skipping the retention sweep — the saved conversations could not be \
             read, so which recordings are still in use is unknown"
        );
        return;
    };

    for path in candidates {
        let still_used = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| referenced.contains(n));
        if !still_used {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// True if the whisper ggml model for `model_size` is already downloaded.
#[tauri::command]
#[specta::specta]
pub(crate) fn whisper_model_present(model_size: String) -> bool {
    paths::whisper_model_path(&model_size).exists()
}

/// Download the whisper ggml model for `model_size` into the whisper dir.
/// Streams over `cinderpaw://whisper-download-progress`; completion/failure over
/// `cinderpaw://whisper-download-complete` / `-error`. Distinct from `download_model`
/// so the LLM auto-load listener never tries to load a whisper model as a llama.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_whisper_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_size: String,
) -> Result<String, String> {
    let repo = paths::WHISPER_REPO.to_string();
    let filename = paths::whisper_filename(&model_size).to_string();
    let key = format!("whisper::{}", filename);

    {
        let map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {}", key));
        }
    }

    // Already present — nothing to do.
    if paths::whisper_model_path(&model_size).exists() {
        return Ok(key);
    }

    // Check and claim under one lock — see `download_model` for why the split
    // version let two concurrent calls write the same partial file.
    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {}", key));
        }
        map.insert(key.clone(), cancel.clone());
    }

    let (tx, mut rx) = mpsc::channel::<f32>(32);
    {
        let app = app.clone();
        let file = filename.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let _ = app.emit(
                    "cinderpaw://whisper-download-progress",
                    events::DownloadProgressEvent {
                        repo_id: "whisper".into(),
                        filename: file.clone(),
                        progress: p,
                    },
                );
            }
        });
    }

    let app_for_task = app.clone();
    let downloads_map = state.downloads.clone();
    let key_for_task = key.clone();
    let file_for_task = filename.clone();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        let result = models::download_hf_model_to(
            repo,
            file_for_task.clone(),
            paths::whisper_dir(),
            tx,
            cancel_for_task.clone(),
        )
        .await;
        // Only remove OUR entry. A download that finishes after a new one has
        // claimed the same key used to delete the newcomer's cancel flag, so
        // pressing Cancel on the second download did nothing at all — the flag
        // it would have set was no longer in the map.
        {
            let mut map = downloads_map.lock();
            if map
                .get(&key_for_task)
                .is_some_and(|f| std::sync::Arc::ptr_eq(f, &cancel_for_task))
            {
                map.remove(&key_for_task);
            }
        }
        match result {
            Ok(path) => {
                let _ = app_for_task.emit(
                    "cinderpaw://whisper-download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: "whisper".into(),
                        filename: file_for_task.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let _ = app_for_task.emit(
                    "cinderpaw://whisper-download-error",
                    events::DownloadErrorEvent {
                        repo_id: "whisper".into(),
                        filename: file_for_task.clone(),
                        error: e.to_string(),
                        cancelled,
                    },
                );
            }
        }
    });

    Ok(key)
}

/// Whether this build can transcribe on the machine at all.
///
/// It cannot, in every build we ship: `whisper-rs-sys` and `llama-cpp-sys-2`
/// each vendor their own ggml, so the two cannot be linked into one binary —
/// see the note on `default` in `src-tauri/Cargo.toml`. The picker offered
/// "local" anyway, which is a choice that can only fail, so it asks first now.
///
/// A compile-time answer over IPC rather than a `cfg!` in the frontend: the
/// frontend is one bundle for every build, and it cannot know which features
/// the binary beside it was compiled with.
#[tauri::command]
#[specta::specta]
pub(crate) fn stt_local_available() -> bool {
    cfg!(feature = "whisper")
}

/// Transcribe 16 kHz mono f32 PCM. Errors: "model-missing" | "voice-unavailable".
#[tauri::command]
#[specta::specta]
pub(crate) async fn transcribe_audio(pcm: Vec<f32>, model_size: String) -> Result<String, String> {
    let model_path = paths::whisper_model_path(&model_size);
    if !model_path.exists() {
        return Err("model-missing".into());
    }
    #[cfg(feature = "whisper")]
    {
        // Whisper is CPU-bound; run off the async runtime thread.
        tokio::task::spawn_blocking(move || {
            transcription::transcribe_pcm(&pcm, &model_path).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "whisper"))]
    {
        let _ = (pcm, model_path);
        Err("voice-unavailable".into())
    }
}

/// Print a line from the webview into the terminal running the app.
///
/// The voice loop lives in JavaScript, and its `console.log` goes to the WebView2
/// console — which is not the terminal, not the dev-server output, and not
/// reachable without attaching devtools. That made the loop's own decisions the
/// only part of a call nobody could observe, and cost several rounds of guessing
/// at a bug whose evidence existed but had nowhere to go.
#[tauri::command]
#[specta::specta]
pub(crate) fn ui_log(scope: String, message: String) {
    tracing::info!(target: "ui", scope = %scope, "{message}");
}

/// Names the transcriber has no reason to know, fed to it as a vocabulary hint.
///
/// Kept short deliberately: the hint biases decoding, so a long list of words the
/// user never says would start pulling ordinary speech toward them.
const PROPER_NOUNS: &str = "Cinderpaw, Cubby, Bloom, Darius, Piper, Kokoro.";

/// The language the last long-enough transcript came back in, kept for one
/// reason: telling a flip apart from a steady state.
///
/// It is deliberately NOT fed back into the next request. Whisper's `language`
/// is an override, not a hint, so doing that made the loop self-sealing — we
/// forced `ro`, the response therefore said "romanian", and that re-learned
/// `ro`. Nothing else reads it — no code anywhere sends a language to Whisper.
static LAST_LANG: OnceLock<Mutex<Option<&'static str>>> = OnceLock::new();

/// A transcript at least this long is treated as real evidence of a language.
/// Below it, Whisper is guessing from too little audio: one evening of logs has
/// the same Romanian speaker decoded as English ("mă auzi" → "Mouse") and as
/// Portuguese ("Mano, isso aí é…"), while every full sentence came back correct.
const CONFIDENT_TRANSCRIPT_CHARS: usize = 25;

/// What may be put on the wire as Whisper's `language`.
///
/// Only an explicit request from the caller. Extracted so the rule has a name
/// and a test, because the bug it encodes was invisible in the diff that caused
/// it — an `.or_else(learned)` reads like a sensible fallback and is in fact an
/// override that no later evidence can undo.
fn request_language(asked: Option<String>) -> Option<String> {
    asked.map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Whisper's `verbose_json` names languages in full ("romanian"); the `language`
/// request parameter takes ISO-639-1 ("ro"). Only languages this app is actually
/// used in are mapped — an unknown name yields `None`, which means "send no hint"
/// rather than "send a guess".
fn iso_code_of(language_name: &str) -> Option<&'static str> {
    match language_name.trim().to_ascii_lowercase().as_str() {
        "romanian" | "ro" => Some("ro"),
        "english" | "en" => Some("en"),
        _ => None,
    }
}

/// Transcribe a recorded audio file via a cloud STT provider. Reads the file
/// from disk and uploads it as multipart. The API key comes from the BYOK
/// keychain (`provider` id). Works in any build — not gated on the local
/// `whisper` feature. Errors: "stt-no-key" | "stt-cloud-failed".
///
/// `language` is an ISO-639-1 hint ("ro", "en"). Without it Groq guesses per
/// request, and guessing the language of two words is a coin flip: "Salut, Cinderpaw"
/// came back as "Salut, Mouth!" and near-silence came back as Japanese. The app
/// already knows which language the user speaks, so it says so.
#[tauri::command]
#[specta::specta]
pub(crate) async fn transcribe_audio_cloud(
    audio_path: String,
    provider: String,
    language: Option<String>,
) -> Result<String, String> {
    // Traced because the voice pipeline crosses four boundaries (webview → Rust →
    // vendor → back) and the webview's own console never reaches the terminal
    // running the app. Without a line per stage, a failed call is indistinguishable
    // from a call that never started.
    // The language is logged further down, AFTER the learned fallback is resolved.
    // Printing the caller's value here showed `<none>` for requests that were in
    // fact sending a hint — a diagnostic that reports the wrong thing is worse than
    // none, because it makes you conclude confidently and wrongly. That cost two
    // rounds of debugging tonight, on two separate labels.
    tracing::info!(provider = %provider, path = %audio_path, "stt: cloud transcribe requested");
    let key = byok::byok_get(&provider).ok_or_else(|| {
        tracing::warn!(provider = %provider, "stt: no key stored for this provider");
        "stt-no-key".to_string()
    })?;

    // Endpoint per provider. Only Groq (whisper-large-v3) is wired today; the
    // `provider` arg keeps the call site stable when more are added.
    let endpoint = match provider.as_str() {
        "groq" => "https://api.groq.com/openai/v1/audio/transcriptions",
        _ => return Err("stt-cloud-failed".into()),
    };

    // Only a blob this app recorded is ours to upload. `audio_path` arrives
    // from the webview, and without this the command reads any file on the
    // machine and POSTs it to Groq as "audio" — an exfiltration primitive one
    // injected script away, where the bytes leave the machine even though the
    // transcript comes back as nonsense. `is_under` canonicalises, so
    // `voice/../../.ssh/id_rsa` fails the check rather than passing it, and it
    // fails closed when the voice dir does not exist yet.
    let voice_dir = paths::voice_dir();
    if !matches!(
        cinderpaw_core::rsi::paths::is_under(&voice_dir, std::path::Path::new(&audio_path)),
        Ok(true)
    ) {
        tracing::warn!(
            path = %audio_path,
            "stt: refusing to upload a file outside {}",
            voice_dir.display()
        );
        return Err("stt-cloud-failed".into());
    }
    let bytes = std::fs::read(&audio_path).map_err(|_| "stt-cloud-failed".to_string())?;
    let file_name = std::path::Path::new(&audio_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio.webm")
        .to_string();

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(|_| "stt-cloud-failed".to_string())?;
    // ONLY the caller's explicit choice. Whisper's `language` is an override,
    // not a hint, so filling it in from what was detected last time made the
    // loop self-sealing: we forced `ro`, the response therefore said "romanian",
    // and that re-learned `ro`. A first mistake became permanent and a user
    // switching language could never be heard again. Detection is free every
    // turn now — a wrong guess costs one turn instead of all of them.
    let language = request_language(language);
    tracing::info!(sending = language.as_deref().unwrap_or("<none>"), "stt: language");

    let mut form = reqwest::multipart::Form::new()
        .text("model", "whisper-large-v3")
        // `verbose_json` so the response carries the language it decided on. That
        // answer is the input to the next request's hint.
        .text("response_format", "verbose_json")
        // Proper nouns Whisper has never seen, so it approximates them phonetically:
        // "Cinderpaw" came back as Mouth, Molaus, Paula and Mose across one evening of
        // testing, and each miss became a message the agent had to answer as if it
        // were a different word. The prompt field is a vocabulary hint, not an
        // instruction — it biases decoding toward these spellings when the audio is
        // ambiguous, which is exactly the failure being fixed.
        .text("prompt", PROPER_NOUNS)
        .part("file", part);
    if let Some(lang) = language.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
        form = form.text("language", lang.to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "stt-cloud-failed".to_string())?;

    let resp = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", key))
        .multipart(form)
        .send()
        .await
        .map_err(|_| "stt-cloud-failed".to_string())?;

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!(status = code, body = %body, "cloud STT request failed");
        return Err("stt-cloud-failed".into());
    }

    #[derive(serde::Deserialize)]
    struct TranscriptionResponse {
        text: String,
        /// Present with `verbose_json`, named in full ("romanian"). Optional so a
        /// provider that ignores the format still parses.
        language: Option<String>,
    }
    let parsed: TranscriptionResponse = resp
        .json()
        .await
        .map_err(|_| "stt-cloud-failed".to_string())?;
    let text = parsed.text.trim().to_string();

    // Every language flip, reported — but only between transcripts long enough
    // to be evidence rather than a guess.
    //
    // Two things produce this line and they are opposites: the user genuinely
    // switched language, or Whisper mis-detected and TRANSLATED (measured once:
    // fluent Romanian out of English audio, indistinguishable from a switch by
    // reading the transcript alone). No fix is shipped, because none is known —
    // forcing the language brings back a latch that cannot correct itself. What
    // is shipped is the count, so the next session can say how often it happens
    // instead of arguing about whether it does.
    if let Some(code) = parsed.language.as_deref().and_then(iso_code_of) {
        if text.chars().count() >= CONFIDENT_TRANSCRIPT_CHARS {
            let mut slot = LAST_LANG.get_or_init(|| Mutex::new(None)).lock();
            if slot.is_some_and(|previous| previous != code) {
                tracing::warn!(
                    from = slot.unwrap_or(""),
                    to = code,
                    chars = text.chars().count(),
                    transcript = %text,
                    "stt: language flipped — a real switch, or a translation",
                );
            }
            *slot = Some(code);
        }
    }

    // The transcript itself, not just its length: "did it hear me correctly" is
    // the first question of any voice bug, and this text is already on screen and
    // already persisted with the conversation, so the log adds no new exposure.
    tracing::info!(
        chars = text.chars().count(),
        detected = parsed.language.as_deref().unwrap_or("<none>"),
        transcript = %text,
        "stt: transcribed"
    );
    Ok(text)
}

/// Every voice engine the picker offers, built or not.
///
/// The catalog lives in `cinderpaw_core::tts` rather than in the React component so
/// that "does audio leave the machine" and "is this engine actually built" have
/// exactly one source. A picker that infers either from the id will eventually
/// infer wrong, and the failure mode is telling someone their voice stayed home
/// when it did not.
#[tauri::command]
#[specta::specta]
pub(crate) fn tts_providers() -> Vec<tts::TtsEngine> {
    tts::catalog()
}

/// Every file a local engine needs on disk, as `(repo, path-in-repo, destination)`.
///
/// The LAST entry is the big one: it gets the progress bar, everything before it
/// is fetched silently. A tokenizer or a config is a few kilobytes next to a
/// ~90 MB model, and a bar that jumps to 100% for the small file and restarts is
/// worse than no bar at all.
///
/// `None` means the engine does not exist, is not built into this version, or
/// the voice id is not one it can place — all three are "there is nothing to
/// download", and refusing here is what stops a 404 page landing in a `.onnx`.
fn local_voice_files(engine: &str, voice: &str) -> Option<Vec<(String, String, std::path::PathBuf)>> {
    match engine {
        #[cfg(feature = "piper")]
        tts::PIPER_ID => {
            let (model_repo, model_rel) = paths::piper_source(voice, "")?;
            let (config_repo, config_rel) = paths::piper_source(voice, ".json")?;
            Some(vec![
                (config_repo.to_string(), config_rel, paths::piper_config_path(voice)?),
                (model_repo.to_string(), model_rel, paths::piper_voice_path(voice)?),
            ])
        }
        #[cfg(feature = "kokoro")]
        tts::KOKORO_ID => {
            use tts::kokoro;
            let repo = kokoro::REPO.to_string();
            Some(vec![
                (repo.clone(), kokoro::TOKENIZER_FILE.into(), kokoro::tokenizer_path()),
                (repo.clone(), kokoro::voice_rel_path(voice)?, kokoro::voice_path(voice)?),
                (repo, kokoro::MODEL_FILE.into(), kokoro::model_path()),
            ])
        }
        _ => {
            let _ = voice;
            None
        }
    }
}

/// The voice a local engine falls back to when the user has not named one.
///
/// Empty for anything else, which reads as "not present" everywhere it is
/// used — an engine nobody has taught this function about must not be reported
/// ready on a guess.
fn default_voice_for(engine: &str) -> &'static str {
    match engine {
        #[cfg(feature = "piper")]
        tts::PIPER_ID => tts::piper::DEFAULT_VOICE,
        #[cfg(feature = "kokoro")]
        tts::KOKORO_ID => tts::kokoro::DEFAULT_VOICE,
        _ => "",
    }
}

/// Is this engine's voice ready to speak?
///
/// A build without the engine can never have a usable voice, whatever is on
/// disk — answering "true" here would let the picker start a mute call.
fn engine_voice_present(engine: &str, voice: &str) -> bool {
    match engine {
        #[cfg(feature = "piper")]
        tts::PIPER_ID => tts::piper::voice_present(voice),
        #[cfg(feature = "kokoro")]
        tts::KOKORO_ID => tts::kokoro::voice_present(voice),
        _ => {
            let _ = voice;
            false
        }
    }
}

/// True if a local engine's voice is fully downloaded — every file it needs,
/// not just the one with the voice's name on it.
#[tauri::command]
#[specta::specta]
pub(crate) fn tts_voice_present(engine: String, voice: String) -> bool {
    engine_voice_present(&engine, &voice)
}

/// Download everything a local engine needs to speak in `voice`.
///
/// One progress stream per download, whatever the engine: streams over
/// `cinderpaw://tts-download-progress`, ends on `cinderpaw://tts-download-complete` /
/// `-error`, matching the whisper channels. The engine id rides along as
/// `repo_id` so a UI listening to one channel can tell whose download it is.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_tts_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: String,
    voice: String,
) -> Result<String, String> {
    let Some(files) = local_voice_files(&engine, &voice) else {
        return Err("tts-bad-voice".into());
    };

    let key = format!("{engine}::{voice}");
    if engine_voice_present(&engine, &voice) {
        return Ok(key);
    }

    // Check and claim under one lock — see `download_model` for why the split
    // version let two concurrent calls write the same partial file.
    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {key}"));
        }
        map.insert(key.clone(), cancel.clone());
    }
    let cancel_for_task = cancel.clone();

    let (tx, mut rx) = mpsc::channel::<f32>(32);
    {
        let app = app.clone();
        let engine = engine.clone();
        let voice = voice.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let _ = app.emit(
                    "cinderpaw://tts-download-progress",
                    events::DownloadProgressEvent {
                        repo_id: engine.clone(),
                        filename: voice.clone(),
                        progress: p,
                    },
                );
            }
        });
    }

    let downloads_map = state.downloads.clone();
    let key_for_task = key.clone();
    tokio::spawn(async move {
        let mut result = Ok(std::path::PathBuf::new());
        let last = files.len() - 1;
        for (i, (repo, rel, dest)) in files.into_iter().enumerate() {
            // Everything but the last file reports into a channel nobody reads,
            // so one bar tracks one download.
            let progress = if i == last {
                tx.clone()
            } else {
                let (quiet_tx, mut quiet_rx) = mpsc::channel::<f32>(4);
                tokio::spawn(async move { while quiet_rx.recv().await.is_some() {} });
                quiet_tx
            };
            result = models::download_hf_file_as(repo, rel, dest, progress, cancel.clone()).await;
            if result.is_err() {
                break;
            }
        }

        // Only remove OUR entry. A download that finishes after a new one has
        // claimed the same key used to delete the newcomer's cancel flag, so
        // pressing Cancel on the second download did nothing at all — the flag
        // it would have set was no longer in the map.
        {
            let mut map = downloads_map.lock();
            if map
                .get(&key_for_task)
                .is_some_and(|f| std::sync::Arc::ptr_eq(f, &cancel_for_task))
            {
                map.remove(&key_for_task);
            }
        }
        match result {
            Ok(path) => {
                let _ = app.emit(
                    "cinderpaw://tts-download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: engine.clone(),
                        filename: voice.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "cinderpaw://tts-download-error",
                    events::DownloadErrorEvent {
                        repo_id: engine.clone(),
                        filename: voice.clone(),
                        error: e.to_string(),
                        cancelled: cancel.load(Ordering::Relaxed),
                    },
                );
            }
        }
    });

    Ok(key)
}

/// Whether a key is stored for a voice engine.
///
/// `get_byok_settings` cannot answer this: it is derived from
/// `provider_catalog()`, which is the list of LLM backends, so a voice engine
/// only ever appears there by being mis-declared as a chat provider. The key
/// itself lives in the same keychain under the same id, so reading it needs no
/// new storage — only a way to ask.
#[tauri::command]
#[specta::specta]
pub(crate) fn tts_has_key(provider_id: String) -> bool {
    byok::byok_get(&provider_id).is_some_and(|k| !k.trim().is_empty())
}

/// Can this engine actually speak right now?
///
/// One question instead of the caller assembling it from parts, because the parts
/// differ per engine: a hosted engine needs a key, Piper needs its voice on disk,
/// an unbuilt engine can never be ready. Only Rust can answer it — the configured
/// voice lives in the BYOK record and the keychain is not readable from the UI.
///
/// The failure this prevents is specific: with `tts_has_key` alone, Piper (which
/// needs no key) reported ready with no voice downloaded, and the call opened the
/// microphone, listened, thought, and then had nothing to say with.
#[tauri::command]
#[specta::specta]
pub(crate) fn tts_ready(state: State<AppState>, provider_id: String) -> bool {
    let catalog = tts::catalog();
    let Some(entry) = catalog.iter().find(|e| e.id == provider_id) else {
        return false; // not an engine we know
    };
    if !entry.available {
        return false; // catalogued, not built into this version
    }

    // An engine whose voice lives on disk is ready only once that voice is
    // there. Driven by the catalog's flag rather than by an id compared here:
    // this used to name Piper, so Kokoro — the next engine with a download —
    // fell through to `true` and enabled a Call button for an engine with
    // nothing to speak with. A call that listens, thinks, then cannot answer is
    // the exact failure this check exists to prevent, so it asks the property.
    if entry.needs_download {
        let settings = byok::load(&state.settings);
        let voice = settings
            .get_provider(&provider_id)
            .and_then(|c| c.default_model.clone())
            .unwrap_or_else(|| default_voice_for(&provider_id).to_string());
        return engine_voice_present(&provider_id, &voice);
    }

    if entry.needs_key {
        return byok::byok_get(&provider_id).is_some_and(|k| !k.trim().is_empty());
    }
    true
}

/// Build a configured engine from the stored settings.
///
/// Shared by synthesis and voice listing so the two can never disagree about
/// which endpoint, key or model a provider is using — listing voices from one
/// region and speaking to another is a 400 that reads like a broken voice.
fn engine_for(state: &AppState, provider_id: &str) -> Result<Box<dyn tts::TtsProvider>, String> {
    let byok_settings = byok::load(&state.settings);
    let stored = byok_settings.get_provider(provider_id);
    tts::from_id(
        provider_id,
        tts::EngineConfig {
            api_key: &byok::byok_get(provider_id).unwrap_or_default(),
            base_url: stored.and_then(|c| c.base_url.as_deref()),
            model: stored.and_then(|c| c.default_model.as_deref()),
        },
    )
    .map_err(|e| e.to_string())
}

/// The voices an engine offers, asked of the vendor every time.
///
/// Not cached: a cloned Fish voice or a new Azure locale should appear without
/// restarting the app, and the list is one small request.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tts_voices(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<tts::Voice>, String> {
    let engine = engine_for(&state, &provider_id)?;
    match engine.voices().await {
        Ok(voices) => {
            tracing::info!(engine = %provider_id, count = voices.len(), "tts: voices listed");
            Ok(voices)
        }
        Err(e) => {
            tracing::warn!(engine = %provider_id, error = %e, "tts: voice list failed");
            Err(e.to_string())
        }
    }
}

/// Speech and generation stop independently: a barge-in silences the voice
/// without killing the reply still being written, so the two must not collide
/// on one key in `StopRegistry`.
fn speech_stop_key(session_id: &str) -> String {
    format!("tts::{session_id}")
}

/// Speak `text`, streaming PCM to the webview as it is synthesised.
///
/// Chunks leave on `cinderpaw://tts-chunk` the moment they arrive. That is the whole
/// feature: measured against the live Fish API, synthesis runs ~3x faster than
/// playback (61 chunks, 0.91s of wall clock for 2.64s of audio), so a streaming
/// consumer starts speaking after the first chunk instead of the last. Anything
/// that accumulates here — a `Vec` the loop pushes into, one emit after the
/// loop — spends that lead for nothing and turns voice mode back into a
/// walkie-talkie.
///
/// Returns PCM bytes emitted. Resolves when synthesis ends, NOT when playback
/// does: the webview owns the audio clock, so only it knows when the last
/// scheduled buffer finished.
#[tauri::command]
#[specta::specta]
pub(crate) async fn speak_text(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    provider: Option<String>,
    voice: Option<String>,
) -> Result<u32, String> {
    // No default engine. Picking one here would mean speaking through whatever
    // this function happened to name first — and the difference between engines
    // includes whether the audio left the machine, which is not a detail to
    // decide on the user's behalf in a fallback.
    let Some(provider_id) = provider.filter(|p| !p.trim().is_empty()) else {
        return Err("no voice engine chosen".into());
    };
    // An unknown or unbuilt id is refused rather than swapped — deliberately,
    // and the reason lives in `cinderpaw_core::tts::from_id`.
    let engine = engine_for(&state, &provider_id).map_err(|e| {
        tracing::warn!(engine = %provider_id, error = %e, "tts: engine could not be resolved");
        e
    })?;
    // Read before the engine moves into the synthesis task.
    let rate = engine.sample_rate();
    tracing::info!(
        engine = %provider_id,
        chars = text.chars().count(),
        sample_rate = rate,
        voice = voice.as_deref().unwrap_or("<vendor default>"),
        "tts: synthesising"
    );

    let key = speech_stop_key(&session_id);
    let flag = state.stop_signals.begin(&key);
    let _slot = StopSlot {
        registry: state.stop_signals.clone(),
        session_id: key,
        flag: flag.clone(),
    };

    let req = tts::SpeechRequest { text, voice };
    // Eight chunks of headroom: enough that a webview repaint cannot starve
    // playback, small enough that a barge-in is not left discarding a queue of
    // audio that was already synthesised and paid for.
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(8);
    let synth = tokio::spawn(async move { engine.speak(&req, tx).await });

    let mut total = 0usize;
    while let Some(chunk) = rx.recv().await {
        if flag.load(Ordering::Relaxed) {
            break;
        }
        total += chunk.len();
        let _ = app.emit(
            "cinderpaw://tts-chunk",
            events::TtsChunkEvent {
                session_id: session_id.clone(),
                pcm: base64::engine::general_purpose::STANDARD.encode(&chunk),
                // The engine's own rate, not the module constant: a local model
                // emits whatever it was trained at (Piper: 22.05 kHz) and
                // labelling those bytes 24 kHz plays them fast and high while
                // looking like a working feature.
                sample_rate: rate,
            },
        );
    }
    // Closing the receiver IS the cancellation signal the provider trait
    // documents. Explicit, because `rx` would otherwise live to the end of this
    // function and the HTTP body would keep being pulled after a barge-in.
    drop(rx);

    let stopped = flag.load(Ordering::Relaxed);
    let outcome = match synth.await {
        Ok(Ok(_)) => Ok(total as u32),
        // A stop races the provider's own unwind, so it can surface as an error.
        // The user asked for silence and got silence; that is not a failure to
        // show them.
        _ if stopped => Ok(total as u32),
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match &outcome {
        Ok(bytes) => tracing::info!(
            engine = %provider_id,
            bytes = bytes,
            seconds = tts::duration_secs(total),
            stopped,
            "tts: done"
        ),
        // The only line that says why a call went silent. Without it the failure
        // exists solely as a toast the user may never have seen.
        Err(e) => tracing::warn!(engine = %provider_id, error = %e, "tts: failed"),
    }
    outcome
}

/// Silence `session_id`'s current utterance. The barge-in primitive: safe to
/// call when nothing is speaking, and it leaves text generation running.
#[tauri::command]
#[specta::specta]
pub(crate) fn stop_speaking(state: State<AppState>, session_id: String) {
    state.stop_signals.request_stop(&speech_stop_key(&session_id));
}

#[cfg(test)]
mod stt_language_tests {
    use super::*;

    #[test]
    fn only_languages_this_app_is_used_in_become_hints() {
        assert_eq!(iso_code_of("romanian"), Some("ro"));
        assert_eq!(iso_code_of("Romanian"), Some("ro"));
        assert_eq!(iso_code_of("ro"), Some("ro"));
        assert_eq!(iso_code_of("english"), Some("en"));
        // The failure this guards: Whisper decided "portuguese" from two words of
        // Romanian. Sending that back as a hint would lock the whole call into the
        // wrong language — an unknown name must mean "no hint", never "guess".
        assert_eq!(iso_code_of("portuguese"), None);
        assert_eq!(iso_code_of(""), None);
    }

    #[test]
    fn the_learned_language_never_becomes_an_order_to_the_transcriber() {
        // The latch this guards, in one line: Whisper's `language` is an
        // override, not a hint. Filling it from the learned value made the loop
        // observe its own instruction — we sent `ro`, the response said
        // "romanian", that re-learned `ro` — so a first mistake was permanent
        // and English speech came back as Romanian. Only an explicit request
        // may reach the wire.
        assert_eq!(request_language(Some("en".into())).as_deref(), Some("en"));
        assert_eq!(request_language(None), None);
        // Blank is not a choice.
        assert_eq!(request_language(Some("  ".into())), None);
    }
}

#[cfg(test)]
mod stt_prompt_probe {
    use super::*;

    /// Why English speech came back as fluent Romanian.
    ///
    /// Not a mis-heard transcript — a translation: "Ce puteți face pentru un
    /// video demo?" is correct Romanian for a sentence spoken in English, which
    /// means Whisper understood the audio and decoded it into another language.
    /// Two candidates: the vocabulary `prompt` we attach, which Whisper treats
    /// as the *preceding text of the same recording* and which contains names a
    /// Romanian speaker would use, or plain mis-detection now that no language
    /// is forced.
    ///
    /// Run against the exact file that failed, so this is the real audio and not
    /// a re-enactment. Pass the path:
    ///
    ///     CINDERPAW_STT_PROBE=C:\Users\Darius\.cinderpaw\voice\<id>.webm \
    ///       cargo test -p cinderpaw --lib probe_whisper_prompt -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "sends a stored recording to Groq"]
    async fn probe_whisper_prompt() {
        let path = std::env::var("CINDERPAW_STT_PROBE").expect("set CINDERPAW_STT_PROBE to a .webm path");
        let key = byok::byok_get("groq").expect("no groq key stored");
        let bytes = std::fs::read(&path).expect("read the recording");
        let client = reqwest::Client::new();

        for (label, prompt, language) in [
            ("as shipped (prompt, no language)", Some(PROPER_NOUNS), None),
            ("no prompt, no language", None, None),
            ("prompt + language=en", Some(PROPER_NOUNS), Some("en")),
            ("no prompt + language=en", None, Some("en")),
        ] {
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name("probe.webm")
                .mime_str("application/octet-stream")
                .unwrap();
            let mut form = reqwest::multipart::Form::new()
                .text("model", "whisper-large-v3")
                .text("response_format", "verbose_json")
                .part("file", part);
            if let Some(p) = prompt {
                form = form.text("prompt", p);
            }
            if let Some(l) = language {
                form = form.text("language", l);
            }
            let res = client
                .post("https://api.groq.com/openai/v1/audio/transcriptions")
                .header("Authorization", format!("Bearer {key}"))
                .multipart(form)
                .send()
                .await
                .expect("groq request");
            let body: serde_json::Value = res.json().await.expect("groq json");
            println!(
                "  {label}\n     lang={} text={}",
                body["language"].as_str().unwrap_or("?"),
                body["text"].as_str().unwrap_or("?").trim(),
            );
        }
    }
}

#[cfg(test)]
mod tts_bridge_tests {
    use super::*;

    #[test]
    fn stopping_the_reply_does_not_silence_the_voice_and_vice_versa() {
        let reg = StopRegistry::default();
        let speech = reg.begin(&speech_stop_key("s1"));
        let reply = reg.begin("s1");

        reg.request_stop("s1"); // the "stop generating" button
        assert!(reply.load(Ordering::SeqCst));
        assert!(!speech.load(Ordering::SeqCst), "stopping text must not cut the audio mid-word");

        reg.request_stop(&speech_stop_key("s1")); // a barge-in
        assert!(speech.load(Ordering::SeqCst));
    }
}
