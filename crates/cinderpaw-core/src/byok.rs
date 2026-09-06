//! BYOK (Bring Your Own Key) — Cloud AI provider integration.
//! Stores API keys and provides a unified proxy for cloud AI models.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Known cloud AI providers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Google,
    Kimi,
    Glm,
    Minimax,
    Groq,
    Mistral,
    Deepseek,
    Openrouter,
    Nvidia,
    Custom,
}

impl Provider {
    /// Returns the default base URL for each provider's API
    pub fn default_base_url(&self) -> &'static str {
        match self {
            Provider::Openai => "https://api.openai.com/v1",
            Provider::Anthropic => "https://api.anthropic.com/v1",
            // Google Gemini's OpenAI-compatible surface lives under
            // /v1beta/openai/. Without the `/openai/` segment, requests to
            // `/chat/completions` hit the native Gemini endpoint and 404 —
            // /v1beta/openai/chat/completions is the path the docs publish.
            Provider::Google => "https://generativelanguage.googleapis.com/v1beta/openai",
            Provider::Kimi => "https://api.kimi.com/coding/v1",
            Provider::Glm => "https://api.z.ai/api/coding/paas/v4",
            Provider::Minimax => "https://api.minimax.io/v1",
            Provider::Groq => "https://api.groq.com/openai/v1",
            Provider::Mistral => "https://api.mistral.ai/v1",
            Provider::Deepseek => "https://api.deepseek.com/v1",
            Provider::Openrouter => "https://openrouter.ai/api/v1",
            // NVIDIA NIM — OpenAI-compatible chat completions API.
            // Trailing /v1 because the API path is /v1/chat/completions.
            Provider::Nvidia => "https://integrate.api.nvidia.com/v1",
            Provider::Custom => "https://api.custom.com/v1",
        }
    }

    /// Returns the API key header name for this provider
    pub fn api_key_header(&self) -> &'static str {
        match self {
            Provider::Openai | Provider::Groq | Provider::Mistral | Provider::Deepseek |
            Provider::Openrouter | Provider::Kimi | Provider::Glm | Provider::Minimax |
            Provider::Nvidia => "Authorization",
            Provider::Anthropic => "x-api-key",
            Provider::Google => "Authorization",
            Provider::Custom => "Authorization",
        }
    }

    /// Returns the API key prefix format (e.g., "Bearer ")
    pub fn api_key_prefix(&self) -> &'static str {
        match self {
            Provider::Anthropic => "",
            Provider::Google => "Bearer ",
            Provider::Custom => "",
            _ => "Bearer ",
        }
    }

    /// Returns the chat completions endpoint path.
    /// Kept for the in-progress per-provider endpoint routing; not wired yet.
    #[allow(dead_code)]
    pub fn chat_endpoint(&self) -> &'static str {
        "/chat/completions"
    }

    /// Returns the path (relative to `default_base_url()`) used for a chat
    /// completion call. Anthropic uses `/v1/messages` — its protocol is
    /// similar to OpenAI but the endpoint is different, so the legacy
    /// `url_join(base_url, "chat/completions")` produced a 404.
    pub fn chat_endpoint_path(&self) -> &'static str {
        match self {
            Provider::Anthropic => "messages",
            _ => "chat/completions",
        }
    }

    /// Extra HTTP headers required by the provider. Anthropic requires
    /// `anthropic-version` on every Messages API request; the others use
    /// OpenAI's standard `Authorization: Bearer …` only.
    pub fn extra_headers(&self) -> Vec<(&'static str, &'static str)> {
        match self {
            Provider::Anthropic => vec![("anthropic-version", "2023-06-01")],
            _ => Vec::new(),
        }
    }

    /// Returns whether this provider uses OpenAI-compatible format.
    /// Kept for the in-progress per-provider request shaping; not wired yet.
    #[allow(dead_code)]
    pub fn is_openai_compatible(&self) -> bool {
        !matches!(self, Provider::Anthropic)
    }

    /// THE canonical provider-id → `Provider` mapping. Every call site that
    /// receives a provider id string (IPC commands, HTTP routes, CLI) must
    /// resolve through here — hand-rolled `match provider_id` copies drifted
    /// (three sites were missing `"nvidia"` and fell through to `Custom`,
    /// whose default base URL is a placeholder). Unknown ids map to
    /// `Custom`, which only works with an explicit user-supplied base URL.
    pub fn from_id(id: &str) -> Provider {
        match id {
            "openai" => Provider::Openai,
            "anthropic" => Provider::Anthropic,
            "google" => Provider::Google,
            "kimi" => Provider::Kimi,
            "glm" => Provider::Glm,
            "minimax" => Provider::Minimax,
            "groq" => Provider::Groq,
            "mistral" => Provider::Mistral,
            "deepseek" => Provider::Deepseek,
            "openrouter" => Provider::Openrouter,
            "nvidia" => Provider::Nvidia,
            _ => Provider::Custom,
        }
    }

    /// Protocol family as the sidecar's `set_model` handler understands it
    /// (`CinderpawAgent/src/sandbox/inference-router.ts` `#providers` map:
    /// unknown families default to OpenAI-compatible). Single source for
    /// the `provider_kind` previously matched inline in `api.rs`.
    pub fn family(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Google => "google",
            _ => "openai_compatible",
        }
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Provider::Openai => write!(f, "OpenAI"),
            Provider::Anthropic => write!(f, "Anthropic"),
            Provider::Google => write!(f, "Google"),
            Provider::Kimi => write!(f, "Kimi"),
            Provider::Glm => write!(f, "GLM"),
            Provider::Minimax => write!(f, "MiniMax"),
            Provider::Groq => write!(f, "Groq"),
            Provider::Mistral => write!(f, "Mistral"),
            Provider::Deepseek => write!(f, "DeepSeek"),
            Provider::Openrouter => write!(f, "OpenRouter"),
            Provider::Nvidia => write!(f, "NVIDIA NIM"),
            Provider::Custom => write!(f, "Custom"),
        }
    }
}

/// Per-provider API key and configuration.
///
/// V6: `api_key` is NEVER serialized to disk. It lives only in memory (loaded
/// from the OS keychain on `load`, supplied by the UI on `save`). The
/// `skip_serializing` attribute keeps it out of `byok.json`; `default` lets it
/// still deserialize from a legacy plaintext file so existing keys can be
/// migrated into the keychain on first load.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[derive(Default)]
pub struct ProviderConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing)]
    pub api_key: String,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
}


/// BYOK settings — stored in settings.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ByokSettings {
    pub providers: HashMap<String, ProviderConfig>,
}

impl ByokSettings {
    /// Get a list of all supported providers with their current config
    pub fn get_all_providers(&self) -> Vec<ProviderInfo> {
        let defaults = Self::default_provider_configs();
        defaults.into_iter().map(|(id, name, provider)| {
            let config = self.providers.get(&id).cloned().unwrap_or_default();
            ProviderInfo {
                id: id.clone(),
                name,
                provider: provider.clone(),
                enabled: config.enabled,
                has_api_key: !config.api_key.is_empty(),
                base_url: config.base_url.or(Some(provider.default_base_url().to_string())),
                default_model: config.default_model,
            }
        }).collect()
    }

    /// Get default configurations for all known providers.
    /// Derived from `provider_catalog()` so the wizard catalog and the
    /// settings page can never list different providers.
    fn default_provider_configs() -> Vec<(String, String, Provider)> {
        provider_catalog()
            .into_iter()
            .map(|e| (e.id, e.name, e.provider))
            .collect()
    }

    /// Update config for a specific provider.
    ///
    /// Text fields are trimmed on the way in. A base URL is nearly always
    /// pasted, and a paste carries whatever came with it — a Gemini endpoint
    /// arrived here once as `" https://…/v1beta/openai"`, which worked only
    /// because the process that happened to send the request tolerated the
    /// space. Whether a provider works should not depend on that.
    ///
    /// A field trimmed to nothing becomes `None`, not `Some("")`: an empty box
    /// is the user saying "use the normal one", and storing the empty string
    /// makes every later reader build a request against nothing.
    pub fn update_provider(&mut self, id: &str, mut config: ProviderConfig) {
        config.base_url = config.base_url.and_then(clean);
        config.default_model = config.default_model.and_then(clean);
        self.providers.insert(id.to_string(), config);
    }

    /// Get config for a specific provider
    pub fn get_provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.get(id)
    }
}

/// Trim a user-entered field; `None` when nothing is left.
fn clean(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Provider info for the frontend
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub enabled: bool,
    pub has_api_key: bool,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
}

// ── Public provider catalog (Phase 1, 2026-07-07) ───────────────────────────
//
// The canonical source of "which providers exist and what to show for each"
// lives in Rust and is exposed via `GET /runtime/providers/catalog`. The
// Go TUI wizard and the desktop React OnboardingWizard both consume this
// catalog instead of maintaining their own parallel slices — that's the
// drift surface that the terminal-onboarding plan calls out as the
// root cause of the stale `qwen2.5:7b` placeholder reaching the wizard.
//
// Clients pin the catalog version via the `X-Cinderpaw-Catalog-Version`
// response header (see `api.rs::runtime_providers_catalog`). On a
// version mismatch the client falls back to its bundled slice with a
// clearly surfaced warning rather than silently dropping providers.

/// Catalog version. Bumped whenever a field is added/removed/renamed
/// in [`ProviderCatalogEntry`]. Currently `1`.
pub const CATALOG_VERSION: u32 = 1;

/// Auth header style the wizard should emit when constructing the
/// validation probe (`/providers/test`). Drives the rendered header line
/// and the key format hint, not the actual HTTP transport (which is
/// handled by `Provider::api_key_header` + `Provider::api_key_prefix`
/// once the user submits).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AuthStyle {
    /// `Authorization: Bearer <key>` — OpenAI / Groq / Mistral / DeepSeek /
    /// OpenRouter / Kimi / GLM / MiniMax / NVIDIA NIM / Google / Custom.
    Bearer,
    /// `x-api-key: <key>` (plus `anthropic-version: 2023-06-01`) — Anthropic.
    XApiKey,
}

/// One row of the public provider catalog.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProviderCatalogEntry {
    pub id: String,
    /// Display name shown in the picker (e.g. "OpenAI", "Anthropic",
    /// "NVIDIA NIM"). Distinct from `id` because `provider_kind` and
    /// display name don't always match ("minimax" → "MiniMax").
    pub name: String,
    /// The typed `Provider` enum. Duplicated with `id` so callers that
    /// already have a `Provider` value can do an O(1) lookup without
    /// string matching.
    pub provider: Provider,
    /// Default API base URL. Cached here so the catalog row is
    /// self-contained — the gateway doesn't need a second
    /// `Provider::default_base_url()` round-trip to render a card.
    pub default_base_url: String,
    /// Wizard's chosen-by-default model when the user hasn't picked
    /// one yet. The runtime replaces it with whatever the user saved
    /// in `byok.json`.
    pub default_model: String,
    /// Where to manage API keys (e.g. `https://platform.openai.com/api-keys`).
    /// None if the provider doesn't publish a stable console URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console_url: Option<String>,
    /// Recognised key prefix (e.g. `"sk-"` for OpenAI, `"sk-ant-"` for
    /// Anthropic). Client may render a hint next to the input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_format: Option<String>,
    /// Placeholder text shown in the key-entry input, e.g.
    /// `"Begins with sk-ant-…"`. Drives the wizard UI only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_format_hint: Option<String>,
    /// Free-tier note shown on the provider card, if any. Examples:
    /// "Free trial credits — no card required."
    /// Drives the wizard UI only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_tier_note: Option<String>,
    /// Whether the wizard should accept a custom base URL. False for
    /// hosted-only providers (Anthropic); true for self-host-friendly
    /// ones (OpenAI-compatible providers, where the user might want to
    /// point at a private deployment).
    pub supports_custom_base_url: bool,
    pub auth_style: AuthStyle,
}

/// Returns the canonical, deduplicated provider catalog.
///
/// This is the **single source of truth** for "which providers can the
/// user pick in the wizard?" Adding a new provider = one new entry here plus
/// a gateway rebuild. TUI + desktop pick it up automatically without code
/// changes on their side.
///
/// `Provider::default_base_url()` remains the canonical per-variant URL
/// (used by the runtime to issue requests); the catalog row carries a
/// copy as `default_base_url: String` so the API response is
/// self-contained — the client doesn't need a second map.
pub fn provider_catalog() -> Vec<ProviderCatalogEntry> {
    use AuthStyle::*;
    vec![
        ProviderCatalogEntry {
            id: "openai".into(),
            name: "OpenAI".into(),
            provider: Provider::Openai,
            default_base_url: Provider::Openai.default_base_url().to_string(),
            default_model: "gpt-4o".into(),
            console_url: Some("https://platform.openai.com/api-keys".into()),
            key_format: Some("sk-".into()),
            key_format_hint: Some("Begins with sk-…".into()),
            free_tier_note: None,
            supports_custom_base_url: true,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            provider: Provider::Anthropic,
            default_base_url: Provider::Anthropic.default_base_url().to_string(),
            default_model: "claude-sonnet-4-20250514".into(),
            console_url: Some("https://console.anthropic.com/settings/keys".into()),
            key_format: Some("sk-ant-".into()),
            key_format_hint: Some("Begins with sk-ant-…".into()),
            free_tier_note: Some("Free trial credits — no card required.".into()),
            supports_custom_base_url: false,
            auth_style: XApiKey,
        },
        ProviderCatalogEntry {
            id: "google".into(),
            name: "Google Gemini".into(),
            provider: Provider::Google,
            default_base_url: Provider::Google.default_base_url().to_string(),
            default_model: "gemini-2.0-flash".into(),
            console_url: Some("https://aistudio.google.com/apikey".into()),
            key_format: None,
            key_format_hint: None,
            free_tier_note: Some("Free tier: 15 req/min, 1500 req/day.".into()),
            supports_custom_base_url: true,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "kimi".into(),
            name: "Kimi (Moonshot AI)".into(),
            provider: Provider::Kimi,
            default_base_url: Provider::Kimi.default_base_url().to_string(),
            default_model: "moonshot-v1-8k".into(),
            console_url: Some("https://platform.moonshot.ai/console/api-keys".into()),
            key_format: None,
            key_format_hint: None,
            free_tier_note: None,
            supports_custom_base_url: false,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "glm".into(),
            name: "GLM (Zhipu)".into(),
            provider: Provider::Glm,
            default_base_url: Provider::Glm.default_base_url().to_string(),
            default_model: "glm-4-plus".into(),
            console_url: Some("https://bigmodel.cn/console/overview".into()),
            key_format: None,
            key_format_hint: None,
            free_tier_note: None,
            supports_custom_base_url: false,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "minimax".into(),
            name: "MiniMax".into(),
            provider: Provider::Minimax,
            default_base_url: Provider::Minimax.default_base_url().to_string(),
            default_model: "MiniMax-M3".into(),
            console_url: Some("https://api.minimax.io/user-center/basic-information/api-keys".into()),
            key_format: None,
            key_format_hint: None,
            free_tier_note: None,
            supports_custom_base_url: false,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "groq".into(),
            name: "Groq".into(),
            provider: Provider::Groq,
            default_base_url: Provider::Groq.default_base_url().to_string(),
            default_model: "llama-3.1-70b-versatile".into(),
            console_url: Some("https://console.groq.com/keys".into()),
            key_format: Some("gsk_".into()),
            key_format_hint: Some("Begins with gsk_…".into()),
            free_tier_note: Some("Free tier: 30 req/min for most models.".into()),
            supports_custom_base_url: false,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "mistral".into(),
            name: "Mistral AI".into(),
            provider: Provider::Mistral,
            default_base_url: Provider::Mistral.default_base_url().to_string(),
            default_model: "mistral-large-latest".into(),
            console_url: Some("https://console.mistral.ai/api-keys".into()),
            key_format: None,
            key_format_hint: None,
            free_tier_note: None,
            supports_custom_base_url: false,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            provider: Provider::Deepseek,
            default_base_url: Provider::Deepseek.default_base_url().to_string(),
            default_model: "deepseek-chat".into(),
            console_url: Some("https://platform.deepseek.com/api_keys".into()),
            key_format: None,
            key_format_hint: None,
            free_tier_note: None,
            supports_custom_base_url: false,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "openrouter".into(),
            name: "OpenRouter".into(),
            provider: Provider::Openrouter,
            default_base_url: Provider::Openrouter.default_base_url().to_string(),
            default_model: "openai/gpt-4o".into(),
            console_url: Some("https://openrouter.ai/keys".into()),
            key_format: Some("sk-or-".into()),
            key_format_hint: Some("Begins with sk-or-…".into()),
            free_tier_note: Some("Free credits on signup; per-model pay-as-you-go.".into()),
            supports_custom_base_url: true,
            auth_style: Bearer,
        },
        ProviderCatalogEntry {
            id: "nvidia".into(),
            name: "NVIDIA NIM".into(),
            provider: Provider::Nvidia,
            default_base_url: Provider::Nvidia.default_base_url().to_string(),
            default_model: "stepfun-ai/step-3.7-flash".into(),
            console_url: Some("https://build.nvidia.com/settings/api-keys".into()),
            key_format: Some("nvapi-".into()),
            key_format_hint: Some("Begins with nvapi-…".into()),
            free_tier_note: Some("Free tier: 1000 req/month on most hosted models.".into()),
            supports_custom_base_url: true,
            auth_style: Bearer,
        },
    ]
}

/// Request to test a provider connection.
/// Part of the in-progress "test connection" command; not wired to a handler yet.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct TestProviderRequest {
    pub provider_id: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

/// Response from testing a provider
#[derive(Debug, Serialize, specta::Type)]
pub struct TestProviderResponse {
    pub success: bool,
    pub message: String,
    pub models: Vec<String>,
}

/// Probe a provider with an API key and return whether the key is accepted.
/// Lifted out of `src-tauri/src/lib.rs::test_byok_provider` so the headless
/// gateway can also serve it (Sprint 2 / audit C-2). Same shape: OpenAI-
/// compatible providers get a `GET /v1/models` probe first (cheap, no model
/// id required), Anthropic skips straight to a minimal chat completion.
///
/// `base_url` is optional — when `None` we use the provider's default.
/// Returns a `TestProviderResponse` whose `success` is true iff the key is
/// accepted. The `message` is the real provider response text on failure
/// ("401 Unauthorized", "Invalid API key", …) so the wizard can surface
/// the actual reason instead of a fake ✓.
pub async fn test_provider(
    provider_id: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> TestProviderResponse {
    let provider = Provider::from_id(provider_id);
    let url = base_url
        .map(|s| s.to_string())
        .unwrap_or_else(|| provider.default_base_url().to_string());
    let chat_endpoint = url_join(&url, provider.chat_endpoint_path());

    let client = match reqwest::Client::builder()
        .user_agent("cinderpaw/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return TestProviderResponse {
                success: false,
                message: format!("client build: {e}"),
                models: vec![],
            };
        }
    };

    let header_key = provider.api_key_header();
    let header_prefix = provider.api_key_prefix();
    let auth_value = format!("{}{}", header_prefix, api_key);

    // Anthropic does NOT publish a `/v1/models` endpoint, so the GET /models
    // probe only applies to OpenAI-compatible providers.
    let probe_status: Option<reqwest::Response> = if !provider.is_openai_compatible() {
        None
    } else {
        let models_endpoint = url_join(&url, "models");
        match client
            .get(&models_endpoint)
            .header(header_key, &auth_value)
            .send()
            .await
        {
            Ok(r) => Some(r),
            Err(e) => {
                return TestProviderResponse {
                    success: false,
                    message: format!("probe /models: {e}"),
                    models: vec![],
                };
            }
        }
    };

    if let Some(models_resp) = probe_status {
        let models_status = models_resp.status();
        if models_status.is_success() {
            #[derive(serde::Deserialize)]
            struct ModelList {
                data: Option<Vec<serde_json::Value>>,
            }
            let models: Vec<String> = models_resp
                .json::<ModelList>()
                .await
                .ok()
                .and_then(|r| r.data)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| {
                            v.get("id")
                                .and_then(|id| id.as_str())
                                .map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default();
            return TestProviderResponse {
                success: true,
                message: "Connection successful".to_string(),
                models,
            };
        }
        if models_status == 401 || models_status == 403 {
            let body = models_resp.text().await.unwrap_or_default();
            return TestProviderResponse {
                success: false,
                message: format!("Auth failed (HTTP {}): {}", models_status.as_u16(), body),
                models: vec![],
            };
        }
        // Non-auth error — fall through to chat probe.
    }

    // /models unavailable (or provider doesn't expose it). Send a minimal
    // non-streaming completion to verify credentials.
    let probe = if provider.is_openai_compatible() {
        serde_json::json!({
            "model": "__probe__",
            "messages": [{ "role": "user", "content": "Hi" }],
            "max_tokens": 1,
            "stream": false,
        })
    } else {
        serde_json::json!({
            "model": "__probe__",
            "messages": [{ "role": "user", "content": "Hi" }],
            "max_tokens": 1,
        })
    };
    let mut chat_req = client
        .post(&chat_endpoint)
        .header(header_key, &auth_value)
        .header("Content-Type", "application/json")
        .json(&probe);
    for (name, value) in provider.extra_headers() {
        chat_req = chat_req.header(name, value);
    }
    let chat_resp = match chat_req.send().await {
        Ok(r) => r,
        Err(e) => {
            return TestProviderResponse {
                success: false,
                message: format!("probe chat: {e}"),
                models: vec![],
            };
        }
    };

    let chat_status = chat_resp.status();
    let chat_body = chat_resp.text().await.unwrap_or_default();

    if chat_status == 401 || chat_status == 403 {
        TestProviderResponse {
            success: false,
            message: format!("Auth failed (HTTP {}): {}", chat_status.as_u16(), chat_body),
            models: vec![],
        }
    } else {
        TestProviderResponse {
            success: true,
            message: "Connection successful (auth verified via chat endpoint)".to_string(),
            models: vec![],
        }
    }
}

/// Tiny URL join helper — appends `path` to `base` exactly once, dropping
/// any trailing `/` from `base`. The provider tests above use it to build
/// `https://api.example.com/v1/models` from `default_base_url()` outputs
/// that may or may not include a trailing slash.
fn url_join(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{}/{}", base, path)
}

// ── OS keychain storage for API keys (V6) ───────────────────────────────────
//
// API keys are stored in the platform secret store (Windows Credential
// Manager / macOS Keychain / Linux Secret Service) under one service name,
// keyed by provider id. byok.json keeps only non-secret metadata. This means
// a copy of the config file — backed up, synced, or leaked — never carries
// the keys.

/// Keychain service name. Stable across launches so keys persist; namespaced
/// to Cinderpaw so it never collides with other apps' credentials.
const KEYCHAIN_SERVICE: &str = "ai.bloom.cinderpaw.byok";

/// Human label for a keychain-probe error, so callers (e.g. `cinderpaw doctor`)
/// can report the kind without depending on the `keyring` crate themselves.
pub fn keychain_error_kind(err: &keyring::Error) -> &'static str {
    match err {
        keyring::Error::NoStorageAccess(_) => "NoStorageAccess",
        keyring::Error::PlatformFailure(_) => "PlatformFailure",
        _ => "other",
    }
}

/// Probe the OS keychain with a throwaway credential so `cinderpaw doctor`
/// can surface "keychain unavailable — byok will fall back to the file
/// store" BEFORE the user types their API key and hits the 500. Returns
/// `Ok(())` when the keychain round-trips (`set` then `delete`), or
/// `Err` with the keyring error kind so the caller can decide what to
/// print. We probe under a reserved name (`__cinderpaw_doctor_probe__`) so
/// a real provider's slot is never touched. On non-Linux targets this
/// is reported as available — Windows Credential Manager and macOS
/// Keychain are assumed reliable on every SKU Cinderpaw ships to.
pub fn keychain_probe() -> Result<(), keyring::Error> {
    const PROBE_USER: &str = "__cinderpaw_doctor_probe__";
    match keyring::Entry::new(KEYCHAIN_SERVICE, PROBE_USER) {
        Ok(entry) => {
            // round-trip a 1-byte value: set → get → delete. get_password
            // returning NoEntry is fine (the slot was never used); the
            // signal we want is "set_password didn't reject with
            // NoStorageAccess / PlatformFailure".
            entry.set_password("0")?;
            let _ = entry.get_password();
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

/// True when the file-store fallback has ever been used on this machine.
/// On non-Linux targets this is always `false` (the file store is
/// Linux-only); on Linux it inspects `~/.cinderpaw/byok.keys` existence.
/// Surfaced by `cinderpaw doctor` to report "your keys live on disk, not in
/// the OS keychain" without forcing the user to `ls ~/.cinderpaw/`.
pub fn file_fallback_used() -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::byok_file_store::file_store_used()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Store a provider's API key. Tries the OS keychain first; on
/// `NoStorageAccess` / `PlatformFailure` (the classic Linux-headless case),
/// falls back transparently to the encrypted file store at
/// `~/.cinderpaw/byok.keys`. The fallback is Linux-only — Windows Credential
/// Manager and macOS Keychain are reliable on every SKU Cinderpaw targets.
///
/// On a successful keychain write we also clear any stale file-store entry
/// so the keychain stays canonical: a key that's migrated off the file
/// store should not re-appear there on the next boot.
pub fn byok_set(provider_id: &str, key: &str) -> anyhow::Result<()> {
    // File key stays un-namespaced (bare provider id) for back-compat with
    // ~/.cinderpaw/byok.keys — existing installs must keep reading their keys.
    crate::secret_store::set_with_file_key(KEYCHAIN_SERVICE, provider_id, provider_id, key)
}

/// Read a provider's API key. Keychain first; on the same
/// `NoStorageAccess` / `PlatformFailure` pair, reads from the file store.
/// Other errors collapse to `None` (matching the old behaviour) — the
/// caller treats absent key the same as unreadable key.
pub fn byok_get(provider_id: &str) -> Option<String> {
    crate::secret_store::get_with_file_key(KEYCHAIN_SERVICE, provider_id, provider_id)
}

/// Remove a provider's API key from BOTH stores. The keychain and the
/// file fallback are siblings, not primary/replica: clearing must clear
/// both so a later write can't resurrect a key from the other side.
fn clear_key(provider_id: &str) -> anyhow::Result<()> {
    crate::secret_store::clear_with_file_key(KEYCHAIN_SERVICE, provider_id, provider_id)
}

/// May the legacy plaintext `byok.json` be deleted after a migration pass?
///
/// Only when something moved AND nothing failed. The previous condition was
/// `migrated_any` alone, which deleted the file whenever any single provider
/// migrated — taking with it the plaintext key of every provider whose own
/// migration had just failed. `byok.json` is the only copy of those, so that
/// was a key destroyed by a neighbour's success.
fn may_remove_legacy_file(migrated_any: bool, failed: &[String]) -> bool {
    migrated_any && failed.is_empty()
}

/// Load BYOK settings: non-secret metadata from `byok.json`, API keys from the
/// OS keychain. Migrates any plaintext keys found in a legacy `byok.json` into
/// the keychain, and deletes the legacy file only once every key is safely in
/// the keychain.
pub fn load(_settings: &crate::settings::Settings) -> ByokSettings {
    let path = crate::paths::cinderpaw_dir().join("byok.json");
    let mut s: ByokSettings =
        crate::atomic_file::read_json_or_report(&path, "your provider settings");

    let mut migrated_any = false;
    // Which providers could NOT be moved into the keychain. This list is the
    // reason the file survives below: `byok.json` is the only copy of a key
    // whose migration failed, so deleting it because a DIFFERENT provider
    // migrated destroys it. One locked keychain, one rejected entry, one
    // transient error, and the key is gone on the next start with nothing to
    // recover it from.
    let mut failed: Vec<String> = Vec::new();
    for (id, cfg) in s.providers.iter_mut() {
        if !cfg.api_key.is_empty() {
            // Legacy plaintext key present in the file → migrate to keychain.
            if let Err(e) = byok_set(id, &cfg.api_key) {
                tracing::warn!(provider = %id, ?e, "byok: failed to migrate key to keychain");
                failed.push(id.clone());
            } else {
                migrated_any = true;
            }
            // Keep it in memory for this load; the rewrite below drops it from disk.
        } else if let Some(k) = byok_get(id) {
            cfg.api_key = k;
        }
    }

    if may_remove_legacy_file(migrated_any, &failed) {
        // After migration, remove the legacy plaintext file entirely.
        // The metadata is regenerated on-demand when save() is called.
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(?e, "byok: failed to delete legacy byok.json after migration");
        } else {
            tracing::info!("byok: migrated plaintext API key(s) into the OS keychain and removed byok.json");
        }
    } else if !failed.is_empty() {
        // The file stays exactly as it is. The keys that DID reach the keychain
        // are still in it as plaintext, which is not worse than the state we
        // were already in: this branch only runs when the keychain is failing,
        // and the file already held every one of them. The next start retries
        // every provider, and the first start where all of them succeed takes
        // the branch above and removes the file.
        //
        // Said on stderr as well as in the log, because the log is where this
        // went to die: nobody reads it, and the symptom on the other side is a
        // provider that silently stops answering.
        let names = failed.join(", ");
        tracing::warn!(
            providers = %names,
            "byok: keeping byok.json — these providers' keys could not be moved to the OS keychain, \
             and the file is the only copy of them"
        );
        eprintln!(
            "[cinderpaw] WARNING: could not move the API key(s) for {names} into the OS keychain. \
             {} has been left in place because it is the only copy of them. \
             Cinderpaw will try again on the next start.",
            path.display()
        );
    }

    s
}

/// Persist BYOK settings: API keys to the keychain, metadata to `byok.json`.
///
/// An empty `api_key` means "leave the stored key untouched" — the UI sends a
/// blank field to mean "unchanged" (its placeholder reads "Key saved — enter a
/// new key to update"). `save` therefore never deletes on empty; explicit
/// removal goes through [`remove_provider`]. This makes routine edits (toggling
/// `enabled`, changing the default model) safe without re-typing the key.
pub fn save(settings: &ByokSettings) -> anyhow::Result<()> {
    crate::paths::ensure_dirs()?;
    for (id, cfg) in &settings.providers {
        if !cfg.api_key.is_empty() {
            byok_set(id, &cfg.api_key)?;
        }
    }
    write_metadata(settings)
}

/// Explicitly remove a provider's API key and disable it. The metadata row is
/// kept (so the provider still appears in the UI) but its key is purged from
/// the keychain.
pub fn remove_provider(id: &str) -> anyhow::Result<()> {
    clear_key(id)?;
    let mut settings = load_metadata();
    if let Some(cfg) = settings.providers.get_mut(id) {
        cfg.enabled = false;
        cfg.api_key = String::new();
    }
    write_metadata(&settings)
}

/// Persist a single provider's configuration: the API key to the OS keychain
/// (when `config.api_key` is non-empty) and the metadata row to `byok.json`.
///
/// Added 2026-07-07 (Phase 0b of the terminal-onboarding slice) so the headless
/// HTTP gateway exposes the same single-provider write path that
/// `src-tauri`'s `save_byok_provider` Tauri command uses. Going through this
/// helper keeps the persistence contract identical across both surfaces:
///
///   * Empty `api_key` means "leave the keychain entry untouched" — matching
///     the existing `save` semantics (`byok.rs:486-501`).
///   * The keychain write happens before the metadata write so a partial
///     failure leaves byok.json matching what's in the keychain (the metadata
///     only stores presence + non-secret config; on retry, a re-save with the
///     same key will converge).
///   * The returned error preserves the original `keyring::Error` in the
///     chain so callers (e.g. `api.rs::runtime_byok_save`) can classify it
///     into typed 4xx vs 5xx responses.
pub fn save_provider(id: &str, config: ProviderConfig) -> anyhow::Result<()> {
    // 1. Keychain write (if the caller provided a non-empty key).
    if !config.api_key.is_empty() {
        byok_set(id, &config.api_key)?;
    }
    // 2. Metadata write. We can't reuse `save(&ByokSettings)` here because
    //    that path re-walks every provider — for a single-provider write from
    //    a network handler we want the minimum disturbance.
    let mut settings = load_metadata();
    settings.update_provider(id, config);
    write_metadata(&settings)?;
    Ok(())
}

/// Read only the on-disk metadata (no keychain access). Used by mutation paths
/// that must not re-trigger migration or key population.
fn load_metadata() -> ByokSettings {
    let path = crate::paths::cinderpaw_dir().join("byok.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<ByokSettings>(&bytes).unwrap_or_default(),
        Err(_) => ByokSettings::default(),
    }
}

/// Write only the non-secret metadata to disk (api_key is skip_serializing).
fn write_metadata(settings: &ByokSettings) -> anyhow::Result<()> {
    let path = crate::paths::cinderpaw_dir().join("byok.json");
    crate::atomic_file::write_secret_atomic(&path, &serde_json::to_vec_pretty(settings)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression: one provider migrating used to authorise deleting the
    /// file that held another provider's un-migrated key.
    #[test]
    fn a_failed_migration_keeps_the_only_copy_of_its_key() {
        let none: [String; 0] = [];
        // Nothing to do: no file to remove.
        assert!(!may_remove_legacy_file(false, &none));
        // Everything moved: the plaintext file is now redundant, remove it.
        assert!(may_remove_legacy_file(true, &none));
        // The bug. Something moved, something did not — the file is the only
        // place the failed key still exists, so it must survive.
        assert!(!may_remove_legacy_file(true, &["openai".to_string()]));
        // And a pass where nothing moved and something failed keeps it too.
        assert!(!may_remove_legacy_file(false, &["openai".to_string()]));
    }

    #[test]
    fn google_default_base_url_uses_openai_compat_path() {
        // The OpenAI-compatible surface for Gemini is published at
        // /v1beta/openai/. The previous default `/v1beta` was the native
        // Gemini endpoint and 404'd on every chat-completions call.
        assert_eq!(
            Provider::Google.default_base_url(),
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );
    }

    #[test]
    fn anthropic_uses_messages_endpoint_and_x_api_key() {
        // Anthropic's protocol is similar to OpenAI but the path is `/v1/messages`
        // (not `/v1/chat/completions`), the auth header is `x-api-key` without a
        // `Bearer ` prefix, and `anthropic-version` is mandatory.
        assert_eq!(Provider::Anthropic.chat_endpoint_path(), "messages");
        assert_eq!(Provider::Anthropic.api_key_header(), "x-api-key");
        assert_eq!(Provider::Anthropic.api_key_prefix(), "");
        assert_eq!(
            Provider::Anthropic.extra_headers(),
            vec![("anthropic-version", "2023-06-01")]
        );
        assert!(!Provider::Anthropic.is_openai_compatible());
    }

    #[test]
    fn openai_uses_chat_completions_and_bearer() {
        // OpenAI and the OpenAI-compatible providers route through
        // `/v1/chat/completions` with `Authorization: Bearer …` and no extra
        // headers.
        for p in [
            Provider::Openai,
            Provider::Kimi,
            Provider::Glm,
            Provider::Minimax,
            Provider::Groq,
            Provider::Mistral,
            Provider::Deepseek,
            Provider::Openrouter,
            Provider::Nvidia,
        ] {
            assert_eq!(p.chat_endpoint_path(), "chat/completions", "endpoint for {p:?}");
            assert_eq!(p.api_key_header(), "Authorization", "header for {p:?}");
            assert_eq!(p.api_key_prefix(), "Bearer ", "prefix for {p:?}");
            assert!(p.extra_headers().is_empty(), "no extras for {p:?}");
            assert!(p.is_openai_compatible(), "{p:?} should be OpenAI-compat");
        }
        // Custom is OpenAI-shaped but sends the key verbatim (empty prefix) so
        // users can paste a full `Bearer …`/`Basic …`/raw token themselves.
        assert_eq!(Provider::Custom.chat_endpoint_path(), "chat/completions");
        assert_eq!(Provider::Custom.api_key_header(), "Authorization");
        assert_eq!(Provider::Custom.api_key_prefix(), "");
        assert!(Provider::Custom.is_openai_compatible());
    }

    #[test]
    fn google_uses_openai_compat_path() {
        // Gemini follows the OpenAI shape (after the /openai/ fix above) —
        // /chat/completions, Bearer, no extras.
        assert_eq!(Provider::Google.chat_endpoint_path(), "chat/completions");
        assert_eq!(Provider::Google.api_key_header(), "Authorization");
        assert_eq!(Provider::Google.api_key_prefix(), "Bearer ");
    }

    /// R4 (single provider record): every catalog row's id must round-trip
    /// through `Provider::from_id` back to the row's own `provider`. This is
    /// the drift check that would have caught the three call sites whose
    /// hand-rolled matches were missing "nvidia".
    #[test]
    fn catalog_ids_round_trip_through_from_id() {
        let catalog = provider_catalog();
        assert!(!catalog.is_empty());
        for entry in &catalog {
            assert_eq!(
                Provider::from_id(&entry.id),
                entry.provider,
                "catalog id {:?} does not resolve to its own provider",
                entry.id
            );
            assert_ne!(
                entry.provider,
                Provider::Custom,
                "catalog must not list Custom (id {:?})",
                entry.id
            );
        }
        assert_eq!(Provider::from_id("no-such-provider"), Provider::Custom);
    }

    /// The catalog's `auth_style` is a second representation of
    /// `api_key_header()` — assert they can never disagree.
    #[test]
    fn catalog_auth_style_matches_enum_header() {
        for entry in provider_catalog() {
            let expected = match entry.provider.api_key_header() {
                "Authorization" => AuthStyle::Bearer,
                "x-api-key" => AuthStyle::XApiKey,
                other => panic!("unmapped api_key_header {other:?} for {:?}", entry.id),
            };
            assert_eq!(
                std::mem::discriminant(&entry.auth_style),
                std::mem::discriminant(&expected),
                "auth_style drift for {:?}",
                entry.id
            );
        }
    }

    /// `default_base_url` in the catalog row must be the enum's canonical
    /// URL — the row carries a copy for self-containedness, not a fork.
    #[test]
    fn catalog_base_urls_match_enum() {
        for entry in provider_catalog() {
            assert_eq!(
                entry.default_base_url,
                entry.provider.default_base_url(),
                "default_base_url drift for {:?}",
                entry.id
            );
        }
    }
}
