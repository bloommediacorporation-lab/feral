//! Model lifecycle (scan/load/unload/download), HuggingFace + Ollama
//! discovery, and the Cinderpaw Agent sidecar's active-model config.

use crate::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Another configured provider to fail over to, or `None`.
///
/// **`None` unless `settings.cloud_fallback_enabled` is on, and it is off by
/// default.** This used to be unconditional, on the reasoning that configuring
/// a provider is consent to using it. That reasoning is wrong. Configuring
/// OpenAI is consent to send OpenAI the messages you send while OpenAI is
/// selected; it is not consent to send OpenAI a conversation you had with
/// Anthropic because Anthropic returned 429. `PROMISES.md` promise 3 is about
/// the recipient the person chose, and the Privacy tab told them cloud
/// providers are "only contacted when you explicitly send a message" while
/// this function could contact a second one they never picked. The failure is
/// invisible from inside the app and visible in another company's logs.
///
/// The reliability problem it was written for is real: on a machine with no
/// local model a single 429 ends the turn. That trade is now the person's to
/// make, on the Privacy tab, with the cost spelled out.
///
/// Deterministic order, so a turn that fails over twice lands on the same
/// endpoint both times and a bug report is reproducible.
fn second_provider(primary: &str) -> Option<serde_json::Value> {
    let settings = cinderpaw_core::settings::load();
    let byok = cinderpaw_core::byok::load(&settings);
    let catalog = cinderpaw_core::byok::provider_catalog();
    pick_second_provider(
        settings.cloud_fallback_enabled,
        primary,
        &byok.providers,
        &catalog,
        &|id| cinderpaw_core::byok::byok_get(id),
    )
}

/// The choosing half, with the world passed in so it can be tested.
///
/// Two rules that were learned the hard way, both from one user whose Gemini
/// turn died with "no fallback configured" while five providers sat configured:
///
///   * **Only providers in the LLM catalog are candidates.** `byok.providers`
///     also holds speech services — Azure, Fish, Piper — which are enabled,
///     have keys, and have a `default_model` that is a VOICE. Nothing stopped
///     one being handed to the inference router as a chat model.
///   * **A candidate that cannot be resolved is skipped, not fatal.** The old
///     code used `?` on the model and base URL lookups inside the loop, which
///     returns from the whole function: the first unusable entry — alphabetically
///     `azure`, for that user — ended the search and every later, perfectly good
///     provider was never considered. A fallback that silently does not exist is
///     the failure this function was added to prevent.
fn pick_second_provider(
    // Off unless the person asked for it, and the gate lives HERE rather than
    // at the caller so the whole decision - including "never" - is one tested
    // function. Sending a conversation to a provider they did not pick is not
    // a reliability feature we get to choose on their behalf; see
    // `Settings::cloud_fallback_enabled` for the argument.
    enabled: bool,
    primary: &str,
    providers: &std::collections::HashMap<String, cinderpaw_core::byok::ProviderConfig>,
    catalog: &[cinderpaw_core::byok::ProviderCatalogEntry],
    key_of: &dyn Fn(&str) -> Option<String>,
) -> Option<serde_json::Value> {
    if !enabled {
        return None;
    }
    let mut candidates: Vec<_> = providers
        .iter()
        .filter(|(id, cfg)| id.as_str() != primary && cfg.enabled)
        // A speech provider is not somewhere to send a conversation.
        .filter(|(id, _)| catalog.iter().any(|e| &e.id == *id))
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(b.0));

    for (id, cfg) in candidates {
        // The key lives in the keychain, not in the record — an entry without
        // one is a provider the user started configuring and never finished,
        // and failing over to it would turn a rate limit into an auth error.
        let Some(key) = key_of(id).filter(|k| !k.trim().is_empty()) else {
            continue;
        };
        let entry = catalog.iter().find(|e| &e.id == id);
        let Some(model) = cfg
            .default_model
            .clone()
            .or_else(|| entry.map(|e| e.default_model.clone()))
        else {
            continue;
        };
        let Some(base_url) = cfg
            .base_url
            .clone()
            .or_else(|| entry.map(|e| e.default_base_url.clone()))
        else {
            continue;
        };
        return Some(serde_json::json!({
            "provider": id,
            "model": model,
            "baseUrl": base_url,
            "apiKey": key,
        }));
    }
    None
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_models() -> Result<Vec<ModelInfo>, String> {
    let mut list = models::scan_models_dir().map_err(|e| e.to_string())?;
    // No way to know "loaded" here without state; mark from singleton:
    // (intentionally left false — UI uses get_loaded_model below)
    let _ = &mut list;
    Ok(list)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_loaded_model(state: State<AppState>) -> Option<inference::LoadedModel> {
    state.manager.current()
}

/// Starts a download in a detached Tokio task and returns its ID immediately.
/// Progress streams over `cinderpaw://download-progress`.
/// Completion: `cinderpaw://download-complete`. Failure: `cinderpaw://download-error`.
/// Use `cancel_download(model_id)` to abort an in-flight download.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_id: String,
    filename: String,
) -> Result<String, String> {
    let key = download_key(&repo_id, &filename);

    // Refuse concurrent download of the same file (would race on the .part path).
    // Claim and check under ONE lock: taking the lock, dropping it, and taking
    // it again to insert left a window where two clicks both saw "not present"
    // and both spawned a download writing the same `.part` file.
    let cancel: CancelFlag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.downloads.lock();
        if map.contains_key(&key) {
            return Err(format!("Download already in progress: {}", key));
        }
        map.insert(key.clone(), cancel.clone());
    }

    // Progress forwarder: mpsc<f32> → Tauri events.
    let (tx, mut rx) = mpsc::channel::<f32>(32);
    {
        let app = app.clone();
        let repo = repo_id.clone();
        let file = filename.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let _ = app.emit(
                    "cinderpaw://download-progress",
                    events::DownloadProgressEvent {
                        repo_id: repo.clone(),
                        filename: file.clone(),
                        progress: p,
                    },
                );
            }
        });
    }

    // Detached download task — frees the IPC reply so UI stays fluid.
    let app_for_task = app.clone();
    let downloads_map = state.downloads.clone();
    let key_for_task = key.clone();
    let repo_for_task = repo_id.clone();
    let file_for_task = filename.clone();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        let result = models::download_hf_model(
            repo_for_task.clone(),
            file_for_task.clone(),
            tx,
            cancel_for_task.clone(),
        )
        .await;

        // Always release the slot first.
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
                    "cinderpaw://download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: repo_for_task.clone(),
                        filename: file_for_task.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let kind = if cancelled { "cancelled" } else { "error" };
                tracing::warn!(repo=%repo_for_task, file=%file_for_task, kind, error=%e, "download ended");
                let _ = app_for_task.emit(
                    "cinderpaw://download-error",
                    events::DownloadErrorEvent {
                        repo_id: repo_for_task.clone(),
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

/// Aborts an in-flight download by ID (`repo_id::filename`).
/// The download task observes the flag on its next chunk boundary,
/// deletes the partial `.part` file, and emits `cinderpaw://download-error`
/// with `cancelled: true`.
#[tauri::command]
#[specta::specta]
pub(crate) fn cancel_download(state: State<AppState>, model_id: String) -> Result<(), String> {
    let map = state.downloads.lock();
    match map.get(&model_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err(format!("No active download: {}", model_id)),
    }
}

/// Remember which model the user picked. Loading one IS the choice, so every
/// load path records it — the API's lazy-load and the RSI model gate both read
/// this back, and neither may ever guess a model on the user's behalf.
///
/// The agent-mode sidecar sync in ChatPage also persists a route, but only in
/// agent mode; a user who loads a model and stays in plain chat must not end up
/// with no recorded choice (their connectors would have nothing to reload after
/// a restart).
pub(crate) fn persist_active_route(route: String) {
    let mut s = settings::load();
    s.active_route = Some(route);
    if let Err(e) = settings::save(&s) {
        tracing::warn!(error = %e, "could not persist active_route");
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn load_model(
    state: State<'_, AppState>,
    path: String,
    max_context: Option<u32>,
) -> Result<inference::LoadedModel, String> {
    let manager = state.manager.clone();
    let n_gpu_layers = state.settings.default_gpu_layers;
    let loaded = tokio::task::spawn_blocking(move || {
        manager.load(PathBuf::from(path), n_gpu_layers, max_context).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    persist_active_route(format!("local:{}", loaded.name));
    Ok(loaded)
}

/// Load a model with real-time progress events emitted to the frontend.
/// Emits `"model-load-progress"` with `{ percentage: f64, status_text: String }`.
/// The progress task runs in a separate tokio task; the UI never freezes.
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_model_load(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    max_context: Option<u32>,
) -> Result<inference::LoadedModel, String> {
    use std::time::Duration;

    let path_buf = PathBuf::from(&path);
    // Before the progress bar starts, because a refusal that arrives after
    // ninety seconds of "Loading attention layers..." reads as a crash. The
    // pickers no longer offer an embedding model, but a list is not the only
    // way in: a saved preset, a stale path, or a future screen all land here.
    cinderpaw_core::models::refuse_if_embedding(
        path_buf.file_name().and_then(|n| n.to_str()).unwrap_or(&path),
    )?;

    let manager = state.manager.clone();
    let n_gpu_layers = state.settings.default_gpu_layers;

    let _ = app.emit("model-load-progress", events::ModelLoadProgressEvent {
        percentage: 0.0,
        status_text: "Initializing...".into(),
    });

    // Estimate load duration from file size (~80 MB/s mmap throughput), clamp 3s–90s.
    let file_size = std::fs::metadata(&path_buf).map(|m| m.len()).unwrap_or(2 << 30);
    let est_ms = ((file_size as f64 / (80.0 * 1024.0 * 1024.0)) * 1_000.0)
        .clamp(3_000.0, 90_000.0) as u64;

    let done = Arc::new(AtomicBool::new(false));
    let done2 = done.clone();
    let app2 = app.clone();

    let milestones: Vec<(f64, &'static str)> = vec![
        (8.0,  "Mapping model file..."),
        (28.0, "Loading attention layers..."),
        (52.0, "Allocating memory..."),
        (75.0, "Warming KV cache..."),
        (90.0, "Finalizing..."),
    ];

    tokio::spawn(async move {
        let mut prev = 0.0f64;
        for (target, label) in milestones {
            if done2.load(Ordering::Relaxed) { break; }
            let gap = target - prev;
            let steps = 12u64;
            let step_ms = ((est_ms as f64 * gap / 90.0) / steps as f64).max(50.0) as u64;
            for i in 1..=steps {
                if done2.load(Ordering::Relaxed) { break; }
                tokio::time::sleep(Duration::from_millis(step_ms)).await;
                let pct = (prev + gap * i as f64 / steps as f64).min(99.0);
                let _ = app2.emit("model-load-progress", events::ModelLoadProgressEvent {
                    percentage: pct,
                    status_text: label.to_string(),
                });
            }
            prev = target;
        }
    });

    let result = tokio::task::spawn_blocking(move || {
        manager.load(path_buf, n_gpu_layers, max_context).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    done.store(true, Ordering::Relaxed);

    match result {
        Ok(model) => {
            // Surface the REAL backend so a user can tell whether their GPU is
            // actually being used or inference silently fell back to CPU.
            let _ = app.emit("model-load-progress", events::ModelLoadProgressEvent {
                percentage: 100.0,
                status_text: format!("Model Loaded! · {}", inference::active_backend_label()),
            });

            // Record the choice — NOT an auto-reload. The startup auto-load is
            // still gone (2026-06-30: mmap lag froze non-technical machines) and
            // nothing here reloads at boot. This only remembers WHICH model the
            // user picked, so the things that must never guess one for them —
            // the API's lazy-load, the RSI gate — have an answer to read.
            persist_active_route(format!("local:{}", model.name));

            Ok(model)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn unload_model(state: State<AppState>) {
    state.manager.unload();
    // Unloading IS a choice: "I don't want this model resident." Forget it, or
    // the API's lazy-load would resurrect it on the next connector message and
    // the user would watch the RAM come straight back. A cloud route is left
    // alone — unloading the local engine says nothing about their cloud pick.
    let mut s = settings::load();
    if s.active_route.as_deref().is_some_and(|r| r.starts_with("local:")) {
        s.active_route = None;
        if let Err(e) = settings::save(&s) {
            tracing::warn!(error = %e, "could not clear active_route");
        }
    }
}

/// Faza 4 (L2): stage a personal LoRA adapter for the next model load, or
/// clear it with `None`. Takes effect on the next `load_model` — the champion
/// flow is: human approves the review card → stage adapter → reload model.
/// Returns the adapter active on the CURRENTLY loaded model (i.e. staging is
/// visible here only after the reload).
#[tauri::command]
#[specta::specta]
pub(crate) fn set_lora_adapter(path: Option<String>, scale: Option<f32>) -> Option<String> {
    inference::set_lora_adapter(path.map(PathBuf::from), scale.unwrap_or(1.0));
    inference::active_lora_adapter()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn delete_model(state: State<AppState>, path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("invalid path: {}", e))?;
    let models_dir = crate::paths::models_dir()
        .canonicalize()
        .map_err(|e| format!("could not resolve models dir: {}", e))?;
    if !target.starts_with(&models_dir) {
        return Err("path is outside models directory".into());
    }
    // Force-unload on the Rust side if this model is currently loaded.
    // The frontend already calls unload(), but a failed-load can leave
    // an llama.cpp file handle open without putting anything in the manager.
    // Unconditional unload + initial wait + retry loop gives the OS time
    // to release mmap handles (the C++ cleanup is asynchronous on Windows
    // — see `remove_file_with_retry` for the retry details).
    state.manager.unload();
    // Initial sleep before the first delete attempt: llama.cpp's
    // background cleanup needs a moment to start releasing the mmap.
    // The retry loop in `remove_file_with_retry` only fires AFTER the
    // first attempt fails — without this head-start sleep the loop is
    // chasing an unmoved release deadline.
    std::thread::sleep(std::time::Duration::from_millis(500));
    models::delete_model(&target).map_err(|e| e.to_string())
}

/// Fetches file size in bytes for a HuggingFace model file via HTTP HEAD.
/// Used by the frontend to display download size before starting a download.
#[tauri::command]
#[specta::specta]
pub(crate) async fn get_model_size_info(repo_id: String, filename: String) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://huggingface.co/{}/resolve/main/{}", repo_id, filename);
    let resp = client.head(&url).send().await.map_err(|e| e.to_string())?;

    resp.content_length()
        .ok_or_else(|| "Content-Length not present in response".to_string())
}

/// Fetches the size of the largest GGUF file in a HuggingFace model repository
/// by first getting the file list from the model details API, then making parallel
/// HEAD requests to get file sizes. Returns a human-readable string (e.g. "4.25 GB").
/// Used by the frontend Browse tab to show model sizes directly in the results list.
#[tauri::command]
#[specta::specta]
pub(crate) async fn get_hf_model_size(repo_id: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Fetch model details to get the list of GGUF files
    let detail_url = format!("https://huggingface.co/api/models/{}", repo_id);

    #[derive(serde::Deserialize)]
    struct ModelSibling {
        rfilename: String,
    }
    #[derive(serde::Deserialize)]
    struct ModelDetail {
        siblings: Vec<ModelSibling>,
    }

    let resp = client.get(&detail_url).send().await.map_err(|e| e.to_string())?;
    let model: ModelDetail = resp.json().await.map_err(|e| e.to_string())?;

    // Get all GGUF filenames
    let gguf_files: Vec<String> = model.siblings.into_iter()
        .filter(|s| s.rfilename.ends_with(".gguf"))
        .map(|s| s.rfilename)
        .collect();

    if gguf_files.is_empty() {
        return Err("No GGUF files found".to_string());
    }

    // Make parallel HEAD requests to get file sizes
    let sizes: Vec<u64> = futures::future::join_all(
        gguf_files.iter().map(|fname| {
            let client = client.clone();
            let repo_id = repo_id.clone();
            let fname = fname.clone();
            async move {
                let url = format!("https://huggingface.co/{}/resolve/main/{}", repo_id, fname);
                match client.head(&url).send().await {
                    Ok(resp) => resp.content_length().unwrap_or(0),
                    Err(_) => 0,
                }
            }
        })
    ).await;

    let largest_bytes = sizes.iter().max().copied().unwrap_or(0);

    if largest_bytes == 0 {
        return Err("Could not determine file size".to_string());
    }

    let gb = largest_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    Ok(format!("{:.2} GB", gb))
}

/// True when `url` addresses the local Cinderpaw API (loopback host on the
/// configured api port). Used to decide whether to inject the bearer token as
/// the sidecar's api key. Conservative: any parse failure returns false, so a
/// non-loopback target never gets the token.
fn is_local_api_url(url: &str, api_port: u16) -> bool {
    // Tolerate a missing scheme — the resolved url has been stripped of /v1
    // and trailing slashes but always carries http(s)://.
    let parsed = match reqwest::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host_is_loopback = matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1"));
    let port = parsed.port().unwrap_or(match parsed.scheme() {
        "https" => 443,
        _ => 80,
    });
    host_is_loopback && port == api_port
}

/// Hot-swap the Cinderpaw Agent's LLM backend without restarting the sidecar.
///
/// React passes `source` + optional fields — Rust injects the API key from
/// byok.json before forwarding. The key never appears in frontend state.
///
/// `source`:
///   - "ollama"            → local Ollama, no key needed
///   - "byok"             → cloud provider by id, key read from byok.json
///   - "openai_compatible" → arbitrary OpenAI-compatible endpoint, caller supplies base_url
#[tauri::command]
#[specta::specta]
pub(crate) async fn cinderpaw_set_model(
    state: State<'_, AppState>,
    source: String,
    provider_id: Option<String>,
    model: String,
    base_url: Option<String>,
) -> Result<(), String> {
    let (provider, mut resolved_url, api_key) = match source.as_str() {
        "ollama" => {
            let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            ("ollama".to_string(), url, String::new())
        }
        "byok" => {
            let pid = provider_id.as_deref().ok_or("byok source requires provider_id")?;
            let byok = byok::load(&state.settings);
            let cfg = byok.get_provider(pid)
                .ok_or_else(|| format!("provider '{}' is not configured", pid))?
                .clone();
            if !cfg.enabled {
                return Err(format!("provider '{}' is not enabled", pid));
            }
            if cfg.api_key.is_empty() {
                return Err(format!("provider '{}' has no API key saved", pid));
            }
            // Resolve base URL: user custom override → provider default
            let url = if let Some(ref custom) = cfg.base_url {
                custom.clone()
            } else {
                byok.get_all_providers()
                    .into_iter()
                    .find(|p| p.id == pid)
                    .and_then(|p| p.base_url)
                    .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
            };
            (pid.to_string(), url, cfg.api_key)
        }
        "openai_compatible" => {
            let url = base_url.ok_or("openai_compatible source requires base_url")?;
            ("openai_compatible".to_string(), url, String::new())
        }
        other => return Err(format!("unknown source: '{}'", other)),
    };

    // Strip trailing /v1 — the sidecar's InferenceRouter appends endpoint paths itself.
    resolved_url = resolved_url.trim_end_matches("/v1").trim_end_matches('/').to_string();

    // V4: when the sidecar is pointed at our own loopback API, it must present
    // the bearer token or the now-gated server rejects it. The token rides in
    // as the OpenAI-style api key (the InferenceRouter sends it as
    // `Authorization: Bearer <key>`), so no sidecar change is needed. Only
    // override an otherwise-empty key — a real cloud BYOK key must win.
    let api_key = if api_key.is_empty() && is_local_api_url(&resolved_url, state.settings.api_port) {
        state.local_api_token.to_string()
    } else {
        api_key
    };

    // For a local (loopback) model, tell the sidecar the active context window
    // so its transcript-compaction budget matches the KV cache the engine
    // actually allocated (Hardware can raise this well past the old 8192). Cloud
    // models omit it — the sidecar uses its generous cloud budget.
    let is_local = is_local_api_url(&resolved_url, state.settings.api_port);
    let context_window = if is_local {
        state.manager.current().map(|m| m.ctx_len)
    } else {
        None
    };

    // Switching to a remote model releases the local engine. Without this the
    // GGUF stayed resident for the whole session — a 9B Q4 is ~5 GB of RSS the
    // user is paying for while every token is being generated in the cloud
    // (2026-07-13: 6 GB working set on an app running entirely on MiniMax).
    if !is_local {
        state.manager.unload();
    }

    // After that unload the engine serves nothing, so the sidecar's
    // degrade-to-local fallback can only 503 ("no model selected") — which the
    // router used to staple onto every cloud failure, and which made the API's
    // lazy-load pull the GGUF we just released back into RSS. Tell the sidecar
    // the truth and let it drop the fallback while we're on a cloud route.
    let local_fallback_available = state.manager.current().is_some();

    // A second cloud provider, for the machines where the local one cannot be
    // the safety net.
    //
    // The sidecar's fallback has always been the bundled local engine, which
    // works on a box with a GGUF resident and is nothing at all on a box
    // without one — and on that second kind of machine the router reports
    // "primary inference failed and no fallback configured", so a single 429
    // ends the turn. That is not a missing feature, it is a fallback that
    // silently does not exist for the user who most needs it.
    let cloud_fallback = second_provider(&provider);

    let msg = serde_json::json!({
        "type": "set_model",
        "provider": provider,
        "model": model,
        "baseUrl": resolved_url,
        "apiKey": api_key,
        "contextWindow": context_window,
        "localFallbackAvailable": local_fallback_available,
        "fallback": cloud_fallback,
    })
    .to_string();

    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;

    // Persist the route so the next boot starts the sidecar on the SAME model.
    // The HTTP path (`POST /runtime/model`) has always done this; the desktop
    // command did not, so a restart silently reverted the UI's cloud model to
    // the last local one — and reloaded its GGUF. `local:` is the boot default,
    // so a loopback target writes that back rather than a provider id.
    persist_active_route(if is_local {
        format!("local:{}", model)
    } else {
        format!("{}:{}", provider, model)
    });

    // Optimistically cache the new config (confirmed by model_set event from sidecar).
    let display_name = if provider == "ollama" {
        format!("Ollama · {}", model)
    } else {
        format!("{} · {}", provider, model)
    };
    *state.cinderpaw_model_config.lock() = Some(CinderpawModelConfigView {
        provider,
        model,
        base_url: resolved_url,
        display_name,
    });

    Ok(())
}

/// Returns the display-safe model config currently active in the Cinderpaw Agent sidecar.
/// Returns None until the first cinderpaw_set_model call this session.
#[tauri::command]
#[specta::specta]
pub(crate) fn cinderpaw_get_model_config(state: State<'_, AppState>) -> Option<CinderpawModelConfigView> {
    state.cinderpaw_model_config.lock().clone()
}

/// Fetch the list of models available from a local Ollama instance.
/// Used by the Cinderpaw model selector to populate the Ollama model submenu.
#[tauri::command]
#[specta::specta]
pub(crate) async fn list_ollama_models(base_url: String) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Ollama unreachable: {}", e))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Ollama response parse failed: {}", e))?;
    let models = json["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

// ---------- HuggingFace browser ----------

/// Handles both missing fields AND explicit JSON nulls, falling back to Default.
/// `#[serde(default)]` alone only handles missing fields; `null` would still error
/// on non-Option primitives like u64/u32/String.
pub(crate) fn deser_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + serde::Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfModelSummary {
    pub id: String,
    pub author: String,
    #[specta(type = specta_typescript::Number)]
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfFile {
    pub rfilename: String,
    #[specta(type = Option<specta_typescript::Number>)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfModelDetail {
    pub id: String,
    pub author: String,
    #[specta(type = specta_typescript::Number)]
    pub downloads: u64,
    pub likes: u32,
    pub last_modified: String,
    pub tags: Vec<String>,
    pub gguf_files: Vec<HfFile>,
    pub readme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct HfSearchPage {
    pub models: Vec<HfModelSummary>,
    pub next_cursor: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn search_hf_models(query: String, cursor: Option<String>) -> Result<HfSearchPage, String> {
    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct RawModel {
        id: String,
        #[serde(default)]
        author: Option<String>,
        #[serde(default, deserialize_with = "deser_default")]
        downloads: u64,
        #[serde(default, deserialize_with = "deser_default")]
        likes: u32,
        #[serde(rename = "lastModified", default, deserialize_with = "deser_default")]
        last_modified: String,
        #[serde(default)]
        tags: Vec<String>,
    }

    let url = cursor.unwrap_or_else(|| {
        if query.is_empty() {
            // No query — show most downloaded GGUF models
            "https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=50&full=false".to_string()
        } else {
            // With query — HF default sort = relevance ranking
            format!(
                "https://huggingface.co/api/models?search={}&filter=gguf&limit=50&full=false",
                urlencoding::encode(&query)
            )
        }
    });

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;

    // Parse Link header for next-page cursor
    let next_cursor = resp.headers()
        .get("link")
        .and_then(|v| v.to_str().ok())
        .and_then(|link| {
            link.split(',')
                .find(|p| p.contains(r#"rel="next""#))
                .and_then(|p| {
                    let s = p.find('<')? + 1;
                    let e = p.find('>')?;
                    Some(p[s..e].trim().to_string())
                })
        });

    let raw: Vec<RawModel> = resp.json().await.map_err(|e| e.to_string())?;

    Ok(HfSearchPage {
        models: raw.into_iter().map(|m| HfModelSummary {
            author: m.author.unwrap_or_else(|| {
                m.id.split('/').next().unwrap_or("").to_string()
            }),
            id: m.id,
            downloads: m.downloads,
            likes: m.likes,
            last_modified: m.last_modified,
            tags: m.tags,
        }).collect(),
        next_cursor,
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_hf_model_detail(repo_id: String) -> Result<HfModelDetail, String> {
    let client = reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct RawModel {
        id: String,
        #[serde(default)]
        author: Option<String>,
        #[serde(default, deserialize_with = "deser_default")]
        downloads: u64,
        #[serde(default, deserialize_with = "deser_default")]
        likes: u32,
        #[serde(rename = "lastModified", default, deserialize_with = "deser_default")]
        last_modified: String,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        siblings: Vec<RawSibling>,
    }
    #[derive(Deserialize)]
    struct LfsInfo {
        size: u64,
    }
    #[derive(Deserialize)]
    struct RawSibling {
        rfilename: String,
        #[serde(default)]
        size: Option<u64>,
        #[serde(default)]
        lfs: Option<LfsInfo>,
    }

    #[derive(Deserialize)]
    struct TreeEntry {
        path: String,
        #[serde(default)]
        size: Option<u64>,
    }

    let url = format!("https://huggingface.co/api/models/{}", repo_id);
    let tree_url = format!("https://huggingface.co/api/models/{}/tree/main", repo_id);

    // Fetch model metadata and tree listing in parallel
    let (raw_resp, tree_resp) = tokio::join!(
        client.get(&url).send(),
        client.get(&tree_url).send()
    );

    let raw: RawModel = raw_resp.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    // Tree endpoint reliably returns actual file sizes (not LFS pointer sizes)
    let tree_sizes: std::collections::HashMap<String, u64> = match tree_resp {
        Ok(r) if r.status().is_success() => {
            r.json::<Vec<TreeEntry>>().await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|e| e.size.filter(|&n| n > 1_048_576).map(|s| (e.path, s)))
                .collect()
        }
        _ => std::collections::HashMap::new(),
    };

    let gguf_files = raw.siblings.into_iter()
        .filter(|s| s.rfilename.ends_with(".gguf"))
        .map(|s| {
            // Priority: tree API size > lfs.size > siblings.size
            let actual_size = tree_sizes.get(&s.rfilename).copied()
                .or_else(|| s.lfs.as_ref().map(|l| l.size))
                .or(s.size)
                .filter(|&n| n > 1_048_576);
            HfFile { rfilename: s.rfilename, size: actual_size }
        })
        .collect();

    // Fetch README
    let readme_url = format!("https://huggingface.co/{}/raw/main/README.md", repo_id);
    let readme = client.get(&readme_url).send().await.ok()
        .and_then(|r| if r.status().is_success() { Some(r) } else { None });
    let readme_text = if let Some(r) = readme {
        r.text().await.ok().map(|t| t.chars().take(2000).collect())
    } else {
        None
    };

    Ok(HfModelDetail {
        author: raw.author.unwrap_or_else(|| {
            raw.id.split('/').next().unwrap_or("").to_string()
        }),
        id: raw.id,
        downloads: raw.downloads,
        likes: raw.likes,
        last_modified: raw.last_modified,
        tags: raw.tags,
        gguf_files,
        readme: readme_text,
    })
}

/// Download the embedding model (bge-small) into the shared models dir for
/// Fractal Memory Search. Mirrors `download_whisper_model`: dedicated events so
/// the LLM auto-load listener never tries to load it as a chat model, a no-op
/// when already present, and cancellable. Idempotent — the frontend can fire
/// this at startup and it returns immediately if the model is on disk.
/// Progress: `cinderpaw://embedding-download-progress`. Completion/failure:
/// `cinderpaw://embedding-download-complete` / `-error`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_embedding_model(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo = paths::EMBED_REPO.to_string();
    let filename = paths::EMBED_FILENAME.to_string();
    let key = format!("embedding::{}", filename);

    // Already present — nothing to do.
    if paths::embedding_model_path().exists() {
        return Ok(key);
    }

    // Check and claim under one lock — see `download_model` for why the split
    // version let two concurrent calls both start writing the same `.part`.
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
                    "cinderpaw://embedding-download-progress",
                    events::DownloadProgressEvent {
                        repo_id: "embedding".into(),
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
            paths::models_dir(),
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
                    "cinderpaw://embedding-download-complete",
                    events::DownloadCompleteEvent {
                        repo_id: "embedding".into(),
                        filename: file_for_task.clone(),
                        path: path.to_string_lossy().into_owned(),
                    },
                );
            }
            Err(e) => {
                let cancelled = cancel_for_task.load(Ordering::Relaxed);
                let _ = app_for_task.emit(
                    "cinderpaw://embedding-download-error",
                    events::DownloadErrorEvent {
                        repo_id: "embedding".into(),
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

#[cfg(test)]
mod deser_default_tests {
    #[test]
    fn deser_default_handles_null() {
        // Simulates serde deserializing a JSON null into a type with Default
        let json = serde_json::json!(null);
        let result: u64 = serde_json::from_value::<Option<u64>>(json)
            .unwrap()
            .unwrap_or_default();
        assert_eq!(result, 0u64);
    }

    #[test]
    fn deser_default_handles_missing_via_option() {
        // Validates the pattern used in HfModelSummary/HfModelDetail deserialization
        #[derive(serde::Deserialize)]
        struct Row {
            #[serde(default, deserialize_with = "super::deser_default")]
            downloads: u64,
            #[serde(default, deserialize_with = "super::deser_default")]
            likes: u32,
        }
        let with_nulls: Row = serde_json::from_str(r#"{"downloads": null, "likes": null}"#).unwrap();
        assert_eq!(with_nulls.downloads, 0);
        assert_eq!(with_nulls.likes, 0);

        let with_values: Row = serde_json::from_str(r#"{"downloads": 1234, "likes": 42}"#).unwrap();
        assert_eq!(with_values.downloads, 1234);
        assert_eq!(with_values.likes, 42);

        let missing: Row = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(missing.downloads, 0);
    }
}

#[cfg(test)]
mod second_provider_tests {
    use super::pick_second_provider;
    use cinderpaw_core::byok::{provider_catalog, ProviderConfig};
    use std::collections::HashMap;

    fn cfg(enabled: bool, base_url: Option<&str>, model: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            enabled,
            api_key: String::new(),
            base_url: base_url.map(str::to_string),
            default_model: model.map(str::to_string),
        }
    }

    fn everyone_has_a_key(_id: &str) -> Option<String> {
        Some("key".to_string())
    }

    #[test]
    fn a_perfectly_good_second_provider_is_refused_while_the_setting_is_off() {
        // The default, and the whole point of the setting. This is the exact
        // configuration the feature was written for - a healthy, enabled,
        // keyed, resolvable second provider - and it must still be refused
        // until the person has asked for it on the Privacy tab. A conversation
        // reaching a company they did not choose is not something reliability
        // buys us the right to do.
        let mut providers = HashMap::new();
        providers.insert(
            "openrouter".to_string(),
            cfg(true, Some("https://openrouter.ai/api/v1"), Some("x/y")),
        );
        // Proof it is the flag and nothing else: same inputs, both answers.
        assert!(
            pick_second_provider(false, "google", &providers, &provider_catalog(), &everyone_has_a_key)
                .is_none(),
            "a conversation was routed to a provider the user never chose"
        );
        assert!(
            pick_second_provider(true, "google", &providers, &provider_catalog(), &everyone_has_a_key)
                .is_some(),
            "with the setting on, the fallback must still work"
        );
    }

    #[test]
    fn a_speech_provider_is_never_an_inference_fallback() {
        // Azure sits in the same map as the chat providers, is enabled, has a
        // key, and its default_model is a VOICE. Handing it to the inference
        // router would answer a user's question with a text-to-speech endpoint.
        let mut providers = HashMap::new();
        // A base_url is given on purpose: without one the old code rejected
        // azure for an unrelated reason and this test passed while proving
        // nothing. With one, only the catalog filter keeps it out.
        providers.insert(
            "azure".to_string(),
            cfg(true, Some("https://x.cognitiveservices.azure.com"), Some("en-US-EmmaNeural")),
        );
        let chosen = pick_second_provider(true, "google", &providers, &provider_catalog(), &everyone_has_a_key);
        assert!(chosen.is_none(), "a TTS provider was offered as a chat fallback: {chosen:?}");
    }

    #[test]
    fn an_unresolvable_candidate_does_not_end_the_search() {
        // The bug this test exists for: `?` inside the loop returned from the
        // whole function, so the first candidate that could not be resolved
        // hid every provider after it in alphabetical order.
        let mut providers = HashMap::new();
        // "custom" has no catalog default_base_url and none configured.
        providers.insert("custom".to_string(), cfg(true, None, Some("some-model")));
        providers.insert(
            "openrouter".to_string(),
            cfg(true, Some("https://openrouter.ai/api/v1"), Some("x/y")),
        );

        let chosen = pick_second_provider(true, "google", &providers, &provider_catalog(), &everyone_has_a_key)
            .expect("openrouter should have been found after custom was skipped");
        assert_eq!(chosen["provider"], "openrouter");
    }

    #[test]
    fn the_failing_provider_is_never_its_own_fallback() {
        let mut providers = HashMap::new();
        providers.insert(
            "openrouter".to_string(),
            cfg(true, Some("https://openrouter.ai/api/v1"), Some("x/y")),
        );
        assert!(pick_second_provider(true, "openrouter", &providers, &provider_catalog(), &everyone_has_a_key).is_none());
    }

    #[test]
    fn a_provider_without_a_key_is_skipped_for_the_next_one() {
        let mut providers = HashMap::new();
        providers.insert("groq".to_string(), cfg(true, None, Some("llama-3.3-70b")));
        providers.insert(
            "openrouter".to_string(),
            cfg(true, Some("https://openrouter.ai/api/v1"), Some("x/y")),
        );
        let only_openrouter = |id: &str| (id == "openrouter").then(|| "key".to_string());
        let chosen = pick_second_provider(true, "google", &providers, &provider_catalog(), &only_openrouter)
            .expect("openrouter has a key");
        assert_eq!(chosen["provider"], "openrouter");
    }

    #[test]
    fn a_disabled_provider_is_not_a_candidate() {
        let mut providers = HashMap::new();
        providers.insert(
            "openrouter".to_string(),
            cfg(false, Some("https://openrouter.ai/api/v1"), Some("x/y")),
        );
        assert!(pick_second_provider(true, "google", &providers, &provider_catalog(), &everyone_has_a_key).is_none());
    }
}
