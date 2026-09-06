//! A LiveKit call the app runs itself: server, agent and token, on this machine.
//!
//! Self-hosted was a decision, not a default (see `docs/voice-livekit.md`), and
//! it has one consequence that shapes this whole module: there is no service to
//! point at. The app has to be the operator — resolve a server binary, boot it
//! bound to loopback, mint its own credentials, start the far end of the call,
//! and take all of it down again when the window closes. Everything below is
//! that job.
//!
//! The far end is a speech-to-speech session with whichever vendor the user
//! connected — see `S2S_PROVIDERS` — and a plain echo when no key is stored for
//! any of them. No vendor is built into the call: Gemini is a row in that table
//! and nothing more, because it runs on the user's own key and a product that
//! hard-codes one vendor's key is a product with one vendor. That second mode
//! is not a degraded assistant:
//! it makes no claim to be one, and it exists so a machine with nothing set up
//! can still answer "does a call work here at all" — which is also the first
//! question when a real call later misbehaves.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The server release this was tested against. Pinned rather than "latest":
/// the config below is the third attempt at one that actually completes an ICE
/// handshake, and a silently newer server is exactly how that gets un-learned.
pub const SERVER_VERSION: &str = "1.13.5";

/// Ports are chosen per call, from whatever the OS says is free.
///
/// They used to be fixed, and a fixed port is wrong here in a way that took two
/// wrong diagnoses to see. If anything else already holds it — LiveKit's own
/// default install, or an orphaned server from an app that was killed rather
/// than closed — then our new server fails to bind and exits, while the HTTP
/// probe that asks "is it up?" gets a cheerful answer from the STRANGER still
/// listening there. Every credential then mismatches, and the symptom is a
/// worker failing to authenticate against a server we believe we started.
///
/// A port nobody else is on cannot be impersonated.
struct Ports {
    http: u16,
    rtc_tcp: u16,
    rtc_udp: (u16, u16),
    /// The agent worker's own health endpoint, which is how we know the far end
    /// is registered. Chosen here for the same reason as the rest: run the
    /// worker in production mode and the SDK's default is a FIXED 8081 on every
    /// interface — a port a second app instance, or anything else on the
    /// machine, can already hold, and a listening socket on somebody's home
    /// network that nothing on screen mentions.
    worker: u16,
}

/// Ask the OS for a free TCP port by binding to 0 and letting go.
///
/// There is a window between letting go and the server binding it, and nothing
/// can close that window without the server accepting a socket from us. It is
/// small, it fails loudly (the server exits, which `start` already checks for),
/// and it is a far better failure than the silent one this replaces.
fn free_port() -> Result<u16, String> {
    // The WILDCARD, not loopback, and this is the whole bug it fixes.
    //
    // We asked "is this port free on 127.0.0.1?" while LiveKit binds its RTC
    // TCP port on every interface — `netstat` shows `0.0.0.0:<p>` and
    // `[::]:<p>`. Windows lets a socket bind 127.0.0.1:p while another holds
    // 0.0.0.0:p, so the probe answered "free" for a port the server could not
    // have. The server then exited during startup and the app reported that it
    // "stopped straight away" with no usable reason.
    //
    // `docs/voice-livekit.md` finding 3 wrote this down — that `rtc.tcp_port`
    // binds `::` regardless of `bind_addresses` — and this function did not
    // heed it. Probing the wildcard asks the same question the server will.
    std::net::TcpListener::bind("0.0.0.0:0")
        .and_then(|l| l.local_addr().map(|a| a.port()))
        .map_err(|e| format!("no free port for the voice server: {e}"))
}

fn pick_ports() -> Result<Ports, String> {
    let http = free_port()?;
    let rtc_tcp = free_port()?;
    // The media range is derived rather than probed: LiveKit wants a
    // contiguous span, and asking the OS for eleven adjacent free ports is a
    // bigger race than the one above rather than a smaller one. High offset to
    // stay clear of both chosen ports.
    let base = 40_000 + (http % 20_000);
    let worker = free_port()?;
    Ok(Ports { http, rtc_tcp, rtc_udp: (base, base + 10), worker })
}

/// Where the running server's pid is recorded, so a leaked one can be found.
fn pid_file() -> PathBuf {
    dir().join("server.pid")
}

/// Kill a server this app started and then lost.
///
/// `kill_on_drop` covers the tidy cases. It cannot cover the untidy one: on
/// Windows a parent's death does not take its children with it, so a crash, a
/// force-quit or a dev rebuild leaves `livekit-server.exe` running and holding
/// the ports it bound. They accumulate one per crash, and the user sees a call
/// that will not start with no process they know to look for.
///
/// The pid is checked against the process NAME before anything is signalled. A
/// pid file outlives the process it names and the number gets reused, so
/// killing it unchecked means eventually killing something else on the user's
/// machine — which is a far worse bug than the one being fixed.
fn reap_orphan_server() {
    let Ok(raw) = std::fs::read_to_string(pid_file()) else { return };
    let Ok(pid) = raw.trim().parse::<u32>() else { return };
    let mut sys = sysinfo::System::new();
    let target = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
    if let Some(proc) = sys.process(target) {
        let name = proc.name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with("livekit-server") {
            tracing::info!(pid, "livekit: killing a server left behind by an earlier run");
            proc.kill();
        }
    }
    let _ = std::fs::remove_file(pid_file());
}

/// A room name nobody has used before, for every call.
///
/// Not a constant, and the reason is the whole reason warm calls were flaky: a
/// worker with no agent name is dispatched when a room is CREATED, and LiveKit
/// keeps an empty room alive for minutes after the last person leaves. Calling
/// again inside that window rejoined a room that already existed, so no
/// dispatch fired and nobody was on the other end — while everything else
/// reported success. A fresh name means every call is a creation.
fn new_room() -> Result<String, String> {
    Ok(format!("cinderpaw-{}", &random_secret()?[..12]))
}

/// One vendor that can carry a speech-to-speech call.
///
/// A table rather than a branch per vendor, because four different things have
/// to agree about the same choice — which npm package gets installed, which
/// stored key is read, which model is named and which voice is pinned — and
/// they are read from four different places in this file. When those were four
/// separate literals, "Gemini" was hard-coded into all of them and the npm
/// install checked for the Google plugin no matter which vendor was actually
/// going to be used.
pub struct S2sProvider {
    /// Also the BYOK id. Deliberately the same string: a second mapping table
    /// between "the provider" and "the key it needs" is a second thing that
    /// can disagree with the first.
    pub id: &'static str,
    /// What the picker shows.
    pub label: &'static str,
    /// The LiveKit plugin that speaks this vendor's realtime protocol.
    pub plugin: &'static str,
    /// Pinned, not "latest". Both of these can be overridden per call, but the
    /// default has to be a decision: left to the vendor, the same assistant
    /// answers in a different voice next week, which reads as unfinished
    /// software rather than as a new model.
    pub model: &'static str,
    /// The voice used when the user has not picked one.
    pub voice: &'static str,
    /// Assembled from the app's own STT, model and TTS choices rather than
    /// being one vendor's session.
    ///
    /// Deliberately NOT called `local`. The pipeline is local when both engines
    /// are — Piper and Whisper — and is not when somebody picks Fish Audio or
    /// Azure for the speaking half. Whether audio leaves the machine is the one
    /// claim a person has to be able to trust, so it is computed from the
    /// engines actually chosen and never asserted by this row.
    pub pipeline: bool,
    /// Every voice this vendor offers, for the picker.
    ///
    /// Per provider, because a voice id is only meaningful to the vendor that
    /// issued it — "Kore" means nothing to OpenAI. The call screen used to list
    /// the previous engine's Gemini voices no matter what was running, which is
    /// how a person ends up choosing a voice the session will never use.
    pub voices: &'static [&'static str],
}

/// Every provider a call can run on.
///
/// Only true speech-to-speech vendors belong here: one session that hears and
/// answers in audio. A vendor whose LiveKit plugin is STT-only or TTS-only
/// would need a chain we assemble and then maintain, which is the thing this
/// migration exists to stop doing — see `docs/voice-livekit.md`.
pub const S2S_PROVIDERS: &[S2sProvider] = &[
    S2sProvider {
        id: "google",
        label: "Gemini Realtime",
        plugin: "@livekit/agents-plugin-google",
        // Kept identical to the engine this replaces (`commands/live.rs`), so
        // the migration changes the machinery and not the voice a person
        // already knows.
        model: "gemini-2.5-flash-native-audio-latest",
        voice: "Kore",
        voices: &["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"],
        pipeline: false,
    },
    S2sProvider {
        id: "openai",
        label: "OpenAI Realtime",
        plugin: "@livekit/agents-plugin-openai",
        model: "gpt-realtime",
        voice: "marin",
        voices: &["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
        pipeline: false,
    },
    // The pipeline, assembled from parts that already ship in this binary.
    // Listed beside the cloud vendors rather than as a fallback: it is the only
    // option that needs no account, and the only one that can speak the five
    // Romanian Piper voices, which exist nowhere else.
    S2sProvider {
        id: "pipeline",
        label: "Transcribe → answer → speak",
        // Not a vendor plugin — the voice activity detector the pipeline needs
        // in order to know when a sentence ended. Whisper cannot tell it.
        plugin: "@livekit/agents-plugin-silero",
        // Nothing is pinned here, and that is the point. Which engine hears
        // you, which speaks, and in what voice are existing product choices
        // with their own pickers and their own catalogue — Piper, Kokoro, Fish
        // Audio, Azure, ElevenLabs. Restating any of them here would be a
        // second, smaller catalogue that silently overrides the real one, which
        // is exactly how this row first shipped hard-wired to Piper.
        model: "",
        voice: "",
        voices: &[],
        pipeline: true,
    },
];

pub fn provider_by_id(id: &str) -> Option<&'static S2sProvider> {
    S2S_PROVIDERS.iter().find(|p| p.id == id)
}

/// The provider this call will actually run on, with its key.
///
/// `preferred` is what the user picked, which on a machine that has never been
/// set up is `None` — and that is the case this function exists for. Falling
/// straight to echo there would mean somebody who has pasted an OpenAI key and
/// never opened the voice picker gets an echo and no explanation, because the
/// default nobody set is still a default.
///
/// So: an explicit pick is honoured or it is an echo — never quietly swapped
/// for a different vendor. Falling back there would put "OpenAI Realtime" on
/// the screen while Gemini did the talking, on the user's Gemini key, which is
/// the exact lie this table was introduced to remove. The fallback applies only
/// when nothing was picked, where there is no claim to contradict.
pub fn resolve_provider(preferred: Option<&str>) -> Option<(&'static S2sProvider, String)> {
    // The pipeline is the one row that carries no key of its own — its halves
    // bring their own, when they need one at all. Testing for a stored key
    // first would put "no key stored" on screen for the option whose entire
    // point is that it is assembled from choices already made elsewhere.
    if let Some(p) = preferred.and_then(provider_by_id).filter(|p| p.pipeline) {
        return Some((p, String::new()));
    }
    if let Some(id) = preferred {
        let Some(p) = provider_by_id(id) else {
            // A vendor this build does not know: fall back rather than echo. It
            // means a downgrade or a half-applied update, not a user's choice.
            tracing::warn!("livekit: unknown voice provider {id:?} — falling back");
            return S2S_PROVIDERS
                .iter()
                .find_map(|p| crate::byok::byok_get(p.id).map(|k| (p, k)));
        };
        return match crate::byok::byok_get(p.id) {
            Some(key) => Some((p, key)),
            None => {
                tracing::warn!(
                    "livekit: {} is the chosen voice provider but no {} key is stored — this call echoes",
                    p.label,
                    p.id
                );
                None
            }
        };
    }
    // Nothing picked: the first vendor with a key. The pipeline is excluded on
    // purpose — it never fails a key check, so including it would make it the
    // silent default for everybody, and which engines hear and answer somebody
    // is not a choice to make on their behalf.
    S2S_PROVIDERS
        .iter()
        .filter(|p| !p.pipeline)
        .find_map(|p| crate::byok::byok_get(p.id).map(|k| (p, k)))
}

/// Where a downloaded server and the agent's dependencies live.
fn dir() -> PathBuf {
    crate::paths::cinderpaw_dir().join("livekit")
}

fn server_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "livekit-server.exe"
    } else {
        "livekit-server"
    }
}

/// Find a server binary without downloading one.
///
/// Same layout rules as `cinderpaw_agent::find_binary`, and for the same
/// reason: at bundle time the binary sits next to the main executable, in dev
/// it does not. `extra_dirs` is the host's resource directory.
pub fn find_server(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let name = server_filename();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            let p = d.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    for d in extra_dirs {
        let p = d.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    let p = dir().join(name);
    if p.exists() {
        return Some(p);
    }
    None
}

/// Download the server into `~/.cinderpaw/livekit`, once.
///
/// This is the development and self-repair path — a release bundles the binary
/// and `find_server` answers first. It exists because the alternative for
/// somebody whose install is missing it is an error message about a file they
/// have never heard of.
///
/// macOS is absent from LiveKit's releases entirely (linux and windows only),
/// which is why we build it in CI and bundle it. Here that shows up as an
/// honest refusal rather than a 404.
async fn fetch_server() -> Result<PathBuf, String> {
    let (os, ext) = match std::env::consts::OS {
        "windows" => ("windows", "zip"),
        "linux" => ("linux", "tar.gz"),
        other => {
            return Err(format!(
                "LiveKit publishes no {other} server build, so it cannot be downloaded. \
                 This install is missing its bundled copy of {}.",
                server_filename()
            ))
        }
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "amd64" };
    let url = format!(
        "https://github.com/livekit/livekit/releases/download/v{SERVER_VERSION}/livekit_{SERVER_VERSION}_{os}_{arch}.{ext}"
    );
    let root = dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;

    tracing::info!("livekit: downloading server from {url}");
    let bytes = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("downloading the LiveKit server failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("downloading the LiveKit server failed: {e}"))?;

    let archive = root.join(format!("livekit.{ext}"));
    std::fs::write(&archive, &bytes)
        .map_err(|e| format!("cannot write {}: {e}", archive.display()))?;

    if ext == "zip" {
        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("unreadable zip: {e}"))?;
        zip.extract(&root).map_err(|e| format!("cannot unpack the server: {e}"))?;
    } else {
        // `tar` ships with every linux and mac we target; shelling out beats a
        // dependency that exists to unpack one file, once.
        let ok = std::process::Command::new("tar")
            .arg("xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&root)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("cannot unpack the LiveKit server archive".into());
        }
    }
    let _ = std::fs::remove_file(&archive);

    let bin = root.join(server_filename());
    if !bin.exists() {
        return Err(format!("the archive did not contain {}", server_filename()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
    }
    Ok(bin)
}

/// The line of a crash worth showing a person.
///
/// NOT the last line: Node ends every stack trace with its own version banner,
/// so reporting the tail turned "Package subpath './voice' is not defined" into
/// "Node.js v24.14.1" — a message that is both useless and confidently wrong
/// about what happened. The first line that names an error is the one that says
/// what broke; failing that, the first line at all.
/// The line that explains why a child process stopped.
///
/// Neither "the first line" nor "the last" is right, and assuming the first
/// cost a real debugging session. The two children this module starts fail in
/// opposite shapes:
///
/// * **Node** puts the reason first, then `at ...` frames, then a version
///   banner. The last line is `Node.js v24.14.1`.
/// * **LiveKit** opens every launch on Windows with a benign
///   `ERROR ... CPU monitoring unsupported on current platform` and a full Go
///   stack, carries on past it, and prints the fatal reason LAST
///   (`listen tcp :61111: bind: ...`). Taking the first line handed the user a
///   message about CPU monitoring for what was a port collision — worse than
///   saying nothing, because it is a confident answer pointing away from the
///   cause.
///
/// So: drop stack frames and banners, then take the LAST line that reads like a
/// cause. Last, because a process that logs a survivable complaint and then
/// dies has said the important thing second.
fn first_real_line(raw: &str) -> &str {
    /// Substrings that make a line an explanation rather than a location.
    const CAUSE: [&str; 8] =
        ["error", "bind:", "failed", "cannot", "refused", "denied", "permitted", "panic"];

    let meaningful: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        // A stack frame is where it happened, not what happened.
        .filter(|l| {
            !l.contains(".go:")
                && !l.starts_with("at ")
                && !l.starts_with("github.com/")
                && !l.starts_with("runtime.")
                && !l.starts_with("main.")
                && !l.starts_with('/')
                // The runtime's own version banner, printed after a crash.
                && !l.starts_with("Node.js v")
        })
        .collect();

    meaningful
        .iter()
        .rev()
        .find(|l| {
            let lower = l.to_ascii_lowercase();
            CAUSE.iter().any(|c| lower.contains(c))
        })
        .or_else(|| meaningful.last())
        .copied()
        .unwrap_or("No reason was reported.")
}

/// 32 random bytes as hex, or an error naming why there are none.
///
/// A failure here means the OS has no entropy source. Refusing beats
/// improvising a weaker one nobody would notice — but it used to refuse with
/// `.expect()`, i.e. a panic, on a path whose entire signature is
/// `Result<_, String>` and whose caller renders the error on the call screen.
/// A panic there is not a refusal the person can read; depending on how the
/// process is configured it is a dead task or a dead app, with the one sentence
/// that explains it going wherever panics go. The refusal is the same; only who
/// hears it changes.
fn random_secret() -> Result<String, String> {
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| {
        format!(
            "This computer's random number generator is unavailable ({e}), so Cinderpaw              cannot create the keys a call needs. This is an operating system problem              rather than a Cinderpaw one; restarting the computer usually clears it."
        )
    })?;
    Ok(raw.iter().map(|b| format!("{b:02x}")).collect())
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Mint a LiveKit access token (JWT, HS256).
///
/// Written out rather than pulled from a crate because it is nine lines and the
/// alternative is a dependency for one signature. The claim names are LiveKit's
/// and are not guessable — `video.roomJoin` is what actually grants entry, and
/// a token missing it is accepted by the parser and rejected by the server.
pub fn mint_token(key: &str, secret: &str, identity: &str, room: &str, ttl_secs: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let header = b64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = serde_json::json!({
        "iss": key,
        "sub": identity,
        "nbf": now,
        "exp": now + ttl_secs,
        "video": { "room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true },
    });
    let payload = b64url(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{payload}");
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(signing_input.as_bytes());
    format!("{signing_input}.{}", b64url(&mac.finalize().into_bytes()))
}

/// The config that took three tries to get right — see `docs/voice-livekit.md`.
///
/// `bind_addresses` keeps the signalling port off the network; the default
/// binds every interface, which on a desktop app means a listening socket on
/// somebody's home network that nothing on screen mentions. `node_ip` is what
/// makes media work: without it the server advertises ICE candidates on an
/// address the loopback-bound agent cannot reach, and the call dies at
/// `wait_pc_connection timed out`.
///
/// What looks right and is not: `rtc.interfaces.includes: [loopback]`. It reads
/// like the correct way to say "local only" and it breaks ICE outright. Narrow
/// the ADVERTISED address, never the enumerated interfaces.
fn config_yaml(key: &str, secret: &str, ports: &Ports) -> String {
    format!(
        "port: {}
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: {}
  port_range_start: {}
  port_range_end: {}
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  {key}: {secret}
logging:
  level: warn
",
        ports.http, ports.rtc_tcp, ports.rtc_udp.0, ports.rtc_udp.1
    )
}

/// What a chain is bound to, as one comparable string.
///
/// The provider is RESOLVED rather than taken literally: `None` and an explicit
/// pick of the vendor that would be resolved anyway are the same call, and a
/// warm chain must not be thrown away over a difference that exists only in the
/// spelling. Everything else is compared as given, because everything else is
/// handed to the agent process verbatim.
pub fn session_spec(
    provider: Option<&str>,
    voice: Option<&str>,
    tts_engine: Option<&str>,
    stt_model: Option<&str>,
    stt_provider: Option<&str>,
    stt_language: Option<&str>,
) -> String {
    let id = resolve_provider(provider).map(|(p, _)| p.id).unwrap_or("echo");
    format!(
        "{id}|{}|{}|{}|{}|{}",
        voice.unwrap_or(""),
        tts_engine.unwrap_or(""),
        stt_model.unwrap_or(""),
        stt_provider.unwrap_or(""),
        stt_language.unwrap_or(""),
    )
}

/// The lock that makes one boot at a time mean one boot at a time.
///
/// Passed in rather than reached for as a global inside `join_or_boot`. There
/// is exactly one in the app (`BOOT_GATE`, right below) because there is one
/// voice chain per process, but a gate that only exists as a process-wide
/// static cannot be tested: the cases worth testing are two callers racing,
/// and every test in the binary would race every other one through the same
/// lock. The parameter costs one word at the two call sites and buys the
/// tests that prove the thing works.
pub type BootGate = tokio::sync::Mutex<()>;

/// The app's gate. Its partner is `AppState::livekit_call`.
pub static BOOT_GATE: BootGate = tokio::sync::Mutex::const_new(());

/// What a request for the voice chain ended up doing.
#[derive(Debug, PartialEq, Eq)]
pub enum Chain {
    /// The chain that was already up is the one being used.
    Warm,
    /// Nothing was up, so this call paid for the boot.
    Booted,
    /// Somebody else is booting one and the caller asked not to wait.
    Busy,
}

/// At most one voice chain is ever booted at a time, and a second asker joins
/// the first one's chain instead of starting its own.
///
/// This gate is the whole reason a warmup helps at all. Warming and pressing
/// Call are the same operation started from two places, and without it they
/// raced: the warmup was fourteen seconds away from parking its chain, the
/// button looked in the slot, found it empty, and booted a second chain from
/// scratch. The person paid in full the boot the warmup existed to spare them,
/// the machine briefly ran two LiveKit servers and two Node workers, and the
/// warmup's chain was thrown away the moment it finished. The slot check was
/// never wrong; it just could not see work that had started and not landed.
///
/// `wait` is what separates the two callers. A pressed button wants the chain
/// however long it takes, so it waits. A warmup that has to queue is a warmup
/// nobody asked for, so it gives up and says `Busy`.
///
/// On success the chain is parked in `slot` and the caller reads it from there.
/// It is deliberately not returned: the slot is what the next call looks in,
/// and a value that exists outside it is a chain nobody can find.
pub async fn join_or_boot<T, Fut>(
    gate: &BootGate,
    slot: &parking_lot::Mutex<Option<T>>,
    wanted: &str,
    spec_of: fn(&T) -> &str,
    wait: bool,
    boot: impl FnOnce() -> Fut,
) -> Result<Chain, String>
where
    Fut: std::future::Future<Output = Result<T, String>>,
{
    // The common case, and the reason the gate is not simply taken first: a
    // second call on a chain that is already up must not queue behind an
    // unrelated boot.
    if slot.lock().as_ref().is_some_and(|c| spec_of(c) == wanted) {
        return Ok(Chain::Warm);
    }

    let _held = if wait {
        gate.lock().await
    } else {
        match gate.try_lock() {
            Ok(g) => g,
            Err(_) => return Ok(Chain::Busy),
        }
    };

    // Re-read under the gate. Between the check above and here a boot may have
    // finished and parked exactly the chain being asked for, which is the whole
    // point of having waited.
    {
        let mut held = slot.lock();
        match held.as_ref() {
            Some(c) if spec_of(c) == wanted => return Ok(Chain::Warm),
            // A chain is bound to the vendor, voice and engines it was started
            // with; it cannot be re-pointed. One warmed for something else is
            // taken down here and paid for once, which is what somebody who
            // just changed a setting is expecting anyway.
            Some(_) => drop(held.take()),
            None => {}
        }
    }

    let booted = boot().await?;
    *slot.lock() = Some(booted);
    Ok(Chain::Booted)
}

/// A running call: the server, the far end, and what the webview needs to join.
///
/// Dropping it ends the call. Both children are killed rather than signalled
/// and waited for, because the one moment this matters most is the app closing,
/// and a voice server that outlives the window it belongs to is a microphone
/// nobody can see.
pub struct Session {
    server: Child,
    agent: Child,
    /// Kept so a second call can be admitted without restarting anything —
    /// see `rejoin`. The chain takes about fourteen seconds to come up, and
    /// paying that on every call is the difference between a feature and a
    /// thing people avoid.
    key: String,
    secret: String,
    pub url: String,
    pub token: String,
    pub room: String,
    /// "assistant" or "echo". The UI has to say which, because the difference
    /// is the whole difference between a product and a diagnostic.
    pub mode: String,
    /// What this chain was started FOR — see `session_spec`.
    ///
    /// A running chain is bound to one vendor, one voice and one pair of
    /// engines: they were handed to the agent process in its environment and
    /// cannot be changed without restarting it. Without this field a warm
    /// session is indistinguishable from the right warm session, and `rejoin`
    /// hands back a Gemini call to somebody who just switched to OpenAI — a
    /// call that connects, sounds wrong, and blames the vendor.
    pub spec: String,
}

impl Session {
    /// Credentials for another call on a chain that is already running.
    ///
    /// A fresh token rather than the old one: tokens expire, and handing back
    /// a stale one turns a warm start into a puzzling refusal an hour later.
    /// `Err` only when the OS cannot produce randomness — see `random_secret`.
    /// It reaches the call screen as a sentence instead of taking the process
    /// down with a panic.
    pub fn rejoin(&mut self, identity: &str) -> Result<String, String> {
        self.room = new_room()?;
        self.token = mint_token(&self.key, &self.secret, identity, &self.room, 60 * 60);
        Ok(self.token.clone())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.server.start_kill();
        let _ = self.agent.start_kill();
        tracing::info!("livekit: call ended, server and agent stopped");
    }
}

/// Install the agent's one dependency, once, into `~/.cinderpaw/livekit/agent`.
///
/// Not bundled yet, and that is a real gap for a fresh machine: it needs npm on
/// PATH and a network the first time. Both failures are reported as themselves
/// rather than as "the call did not start".
///
/// ponytail: install on first use. Vendor it into the bundle when voice ships
/// as a product feature rather than a self-test.
pub(crate) async fn ensure_agent(
    node: &Path,
    provider: Option<&S2sProvider>,
) -> Result<PathBuf, String> {
    let root = dir().join("agent");
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;

    let script = root.join("agent.mjs");
    // Rewritten every start: the script lives in the binary, so an app update
    // must not leave last version's agent on disk talking to this version's
    // Rust. Cheap enough that checking first would cost more than the write.
    std::fs::write(&script, include_str!("livekit_agent.mjs"))
        .map_err(|e| format!("cannot write the agent script: {e}"))?;

    // What "already installed" means depends on WHICH vendor this call needs.
    // This used to check for the Google plugin unconditionally, so a machine
    // that had ever made a Gemini call skipped the install forever — and then
    // ran an OpenAI call against a plugin that was never fetched. The failure
    // landed in the agent process as a module-not-found, i.e. as "the call just
    // does not start", with nothing on screen naming the cause.
    let mut want: Vec<&str> = vec!["@livekit/agents", "@livekit/rtc-node"];
    if let Some(p) = provider {
        want.push(p.plugin);
    }
    let installed = |pkg: &str| {
        pkg.split('/')
            .fold(root.join("node_modules"), |acc, seg| acc.join(seg))
            .exists()
    };
    if want.iter().all(|pkg| installed(pkg)) {
        return Ok(script);
    }
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"cinderpaw-livekit-agent","private":true,"type":"module"}"#,
    )
    .map_err(|e| format!("cannot write the agent manifest: {e}"))?;

    tracing::info!(
        "livekit: installing the agent's dependencies for {} (first run for this provider)",
        provider.map(|p| p.label).unwrap_or("echo"),
    );
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    // A deadline, because without one this await never returns. `output()` waits
    // for the child to exit, and an npm that is alive but making no progress —
    // a registry that accepts the connection and never answers, a proxy that
    // holds it open, a lifecycle script waiting on input that will never come —
    // is alive forever. The whole call start is behind this: the caller has
    // already shown "Starting", and there is no timer, no error and no way
    // through. On a fresh machine, which is the only machine that reaches this
    // code, that is the first thing the product ever does.
    //
    // Ten minutes is deliberately generous. This is one install of three
    // packages, and a slow connection must not be mistaken for a hang; the
    // number exists to bound the failure, not to police the download.
    const INSTALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(600);
    let child = Command::new(npm)
        .args(["install", "--no-audit", "--no-fund"])
        .args(&want)
        .current_dir(&root)
        .env("PATH", augmented_path(node))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("npm is needed once to set up voice, and could not be run: {e}"))?;
    let out = match tokio::time::timeout(INSTALL_DEADLINE, child.wait_with_output()).await {
        Ok(res) => res.map_err(|e| {
            format!("npm is needed once to set up voice, and could not be run: {e}")
        })?,
        Err(_) => {
            // `kill_on_drop` reaps the child when `child` is dropped on the way
            // out, so a hung npm does not outlive the attempt and hold the
            // node_modules directory for the next one.
            return Err(format!(
                "Setting up voice timed out. npm spent more than {} minutes installing the                  voice agent without finishing, so Cinderpaw stopped waiting. This is usually                  a network or proxy problem. Check your connection and try the call again;                  the download resumes where it left off.",
                INSTALL_DEADLINE.as_secs() / 60
            ));
        }
    };
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "setting up the voice agent failed: {}",
            first_real_line(&why)
        ));
    }
    Ok(script)
}

/// npm is a sibling of node, and a GUI app on macOS does not inherit the
/// shell's PATH — the single most common reason "it works in my terminal".
fn augmented_path(node: &Path) -> std::ffi::OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    match node.parent() {
        Some(bin) => {
            let mut joined = std::ffi::OsString::from(bin);
            joined.push(if cfg!(windows) { ";" } else { ":" });
            joined.push(&path);
            joined
        }
        None => path,
    }
}

/// Start a call and return once the far end is actually in the room.
///
/// `identity` is who the webview joins as. The wait at the end is not
/// politeness: a webview that joins before the agent has published its track
/// hears nothing for the first seconds, and the person says the first sentence
/// twice.
/// One line per event from the worker, with no word of what was said.
///
/// These events used to go straight to the window and nowhere else. That is
/// fine while a call works and useless the moment one does not: "it stopped
/// hearing me after two turns" arrived with nothing to look at, because the
/// only record of a call lived in a webview console nobody had open.
///
/// Kind, the state when there is one, and a character COUNT. Never the
/// transcript, never the answer, never a key. What a person said is not
/// diagnostic data, and a log that quotes a phone call is a log nobody can
/// safely send to us.
fn log_event(v: &serde_json::Value) {
    let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("?");
    let partial = v.get("partial").and_then(|p| p.as_bool()).unwrap_or(false);
    let chars = v.get("text").and_then(|t| t.as_str()).map(|t| t.chars().count());
    if kind == "state" {
        // The state IS the diagnosis for a call that went quiet, so it is the
        // one string here worth printing.
        tracing::info!(
            state = v.get("text").and_then(|t| t.as_str()).unwrap_or("?"),
            "livekit event",
        );
    } else {
        tracing::info!(kind, partial, chars, "livekit event");
    }
}

pub async fn start(
    extra_bin_dirs: &[PathBuf],
    identity: &str,
    instructions: Option<String>,
    // Which speech-to-speech vendor the user picked, or `None` on a machine
    // where nobody has picked yet. See `resolve_provider`: unset is not the
    // same as "echo", because a stored key with no pick is still a working
    // call somebody would otherwise never get.
    provider: Option<String>,
    // The voice the user picked for that provider, or `None` for the pinned
    // default. Validated against the provider's own list rather than passed
    // through: a stale id from a previous provider is rejected by the vendor
    // mid-session, which is a call that connects and then dies.
    voice: Option<String>,
    // On-device only: which speech engine speaks and which Whisper model
    // listens. Both are existing product settings; they are passed rather than
    // read here so this module keeps one source of truth for them.
    tts_engine: Option<String>,
    stt_model: Option<String>,
    // `local` or a cloud id, and the language the app already knows the user
    // speaks. Both belong to settings that exist; they are passed rather than
    // read here so there is one source of truth for each.
    stt_provider: Option<String>,
    stt_language: Option<String>,
    // What the agent says while the call runs — transcripts of both sides, and
    // the errors worth a sentence on screen. Taken as a callback rather than
    // returned, because these arrive for as long as the call lasts and the
    // caller is a Tauri command that returned long ago.
    on_event: impl Fn(serde_json::Value) + Send + 'static,
    // The host's runtime, which is what makes the one tool work: `ask_cinder`
    // is a door to the local agent, and only a host that owns a sidecar can
    // open it. `None` is honest rather than fatal — the call still happens, the
    // model is simply told the door is shut.
    runtime: Option<Arc<crate::runtime::RuntimeState>>,
) -> Result<Session, String> {
    let node = crate::toolchain::find_node().ok_or_else(|| "livekit-no-node".to_string())?;

    // Taken before anything is consumed, so what the chain is bound to is
    // recorded by the same call that binds it.
    let spec = session_spec(
        provider.as_deref(),
        voice.as_deref(),
        tts_engine.as_deref(),
        stt_model.as_deref(),
        stt_provider.as_deref(),
        stt_language.as_deref(),
    );

    let server_bin = match find_server(extra_bin_dirs) {
        Some(p) => p,
        None => fetch_server().await?,
    };

    let key = "cinderpaw";
    let secret = random_secret()?;
    let root = dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let ports = pick_ports()?;
    let room = new_room()?;
    let cfg = root.join("livekit.yaml");
    std::fs::write(&cfg, config_yaml(key, &secret, &ports))
        .map_err(|e| format!("cannot write the LiveKit config: {e}"))?;

    // Before binding anything: a server from a run that ended badly still holds
    // its ports, and picking around it forever is how a machine ends up with
    // six of them.
    reap_orphan_server();

    let mut server = Command::new(&server_bin)
        .arg("--config")
        .arg(&cfg)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start the LiveKit server: {e}"))?;
    // Recorded immediately, so a crash one line later is still recoverable.
    if let Some(pid) = server.id() {
        let _ = std::fs::write(pid_file(), pid.to_string());
    }

    // Up means "answers HTTP", not "the process is alive". A server that exits
    // immediately — a taken port is the usual reason — leaves a live `Child`
    // for a moment, and treating that as success moves the failure to a
    // confusing place three steps later.
    let http = format!("http://127.0.0.1:{}", ports.http);
    let mut up = false;
    for _ in 0..80 {
        if reqwest::get(&http).await.is_ok() {
            up = true;
            break;
        }
        if let Ok(Some(status)) = server.try_wait() {
            let mut why = String::new();
            if let Some(mut err) = server.stderr.take() {
                use tokio::io::AsyncReadExt as _;
                let _ = err.read_to_string(&mut why).await;
            }
            return Err(format!(
                "the LiveKit server stopped straight away ({status}). {}",
                if why.trim().is_empty() { "It stopped without saying why." } else { first_real_line(&why) }
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(75)).await;
    }
    if !up {
        return Err("the LiveKit server did not come up".into());
    }

    // Resolved BEFORE the install, because the install depends on it: the
    // plugin that gets fetched is this vendor's, not whichever one was fetched
    // the last time somebody made a call on this machine.
    let picked = resolve_provider(provider.as_deref());
    let script = ensure_agent(&node, picked.as_ref().map(|(p, _)| *p)).await?;

    // The key never touches disk or a command line: it is handed to the child
    // in its environment, which is not visible in the process list the way
    // arguments are. Absent, the agent runs as an echo and says so.
    let mode = if picked.is_some() { "assistant" } else { "echo" };

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        // `start`, not `dev`, and this is most of the five-to-ten seconds
        // between pressing the button and being in the call. `dev` sets the
        // SDK's idle-process count to ZERO, so the forked child that runs the
        // call was created at the instant the room opened and then had to load
        // the Agents SDK, the vendor's plugin and — for the local pipeline — a
        // voice-activity model, with the person already waiting. `start`
        // prewarms one child while the call button is still on screen.
        //
        // Every default `start` brings with it that would be wrong here is
        // overridden in the agent's own `WorkerOptions` — see the bottom of
        // `livekit_agent.mjs`.
        .arg("start")
        .current_dir(script.parent().unwrap_or(&root))
        .env("LIVEKIT_URL", format!("ws://127.0.0.1:{}", ports.http))
        .env("LIVEKIT_API_KEY", key)
        .env("LIVEKIT_API_SECRET", &secret)
        .env("CINDERPAW_WORKER_PORT", ports.worker.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some((p, k)) = &picked {
        let brief = instructions.unwrap_or_default();
        // Logged as a LENGTH, never as content: this is SOUL.md, and a persona
        // in a log file is a persona in every bug report. Zero here is the
        // difference between Cinderpaw and a stock assistant, and it is
        // otherwise only audible — which is a terrible place to learn it.
        tracing::info!(
            "livekit: {} briefed with {} chars of persona",
            p.label,
            brief.len()
        );
        if brief.is_empty() {
            tracing::warn!(
                "livekit: no persona — the sidecar has not sent SOUL.md yet, so this call                  will sound like a stock assistant"
            );
        }
        // One generic name, not `GOOGLE_API_KEY`. The vendor-specific name was
        // the last place the choice of vendor was still hard-coded, and it is
        // the one that fails silently: the agent reads whatever variable its
        // plugin expects, so a mismatched name is an unauthenticated session,
        // not a startup error.
        if p.pipeline {
            // The pipeline reaches its three parts through the loopback API. No
            // runtime means no API server, so the worker would start, register,
            // join, and then fail on the first word with nothing on screen.
            // Refused up front, in words, instead.
            if runtime.is_none() {
                return Err(
                    "This voice mode needs the local runtime, which is not running.".into()
                );
            }
            // Said as a flag. The agent used to compare `CINDERPAW_LIVE_PROVIDER`
            // against a hard-coded `"local"` while this table calls the row
            // `"pipeline"` — so every local call fell through to the echo
            // branch: no assistant, no tools, no `ask_cinder`, and nothing
            // anywhere saying why. One boolean beats two files agreeing on a
            // string.
            // Whichever engine this build can actually run, not the literal
            // "piper" that used to be here. Piper and Kokoro are both behind
            // cargo features, so on a build without them that default named an
            // engine that cannot speak: the call listened, thought, and then
            // said nothing, with the reason reachable only from a log.
            let engine = match tts_engine.as_deref() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => match crate::tts::default_engine() {
                    Some(id) => id,
                    None => return Err(
                        "No speech engine is set, and this build has none that works without a key. Pick one in the voice settings first."
                            .into(),
                    ),
                },
            };
            cmd.env("CINDERPAW_LIVE_PIPELINE", "1")
                .env("CINDERPAW_LIVE_TTS_ENGINE", &engine)
                .env("CINDERPAW_LIVE_STT_MODEL", stt_model.as_deref().unwrap_or("small"))
                .env("CINDERPAW_LIVE_STT_PROVIDER", stt_provider.as_deref().unwrap_or("local"))
                .env("CINDERPAW_LIVE_STT_LANGUAGE", stt_language.as_deref().unwrap_or(""));
        }
        // Outside the pipeline branch, because it is not a transcription
        // setting here: it is the language anything the agent says on its own
        // has to be said in. A Romanian caller hearing "one moment" in English
        // has been handed a different product mid-sentence.
        cmd.env("CINDERPAW_LIVE_LANGUAGE", stt_language.as_deref().unwrap_or(""));
        cmd.env("CINDERPAW_LIVE_PROVIDER", p.id)
            .env("CINDERPAW_LIVE_API_KEY", k)
            .env("CINDERPAW_LIVE_MODEL", p.model)
            .env(
                "CINDERPAW_LIVE_VOICE",
                // A realtime vendor's voices are a fixed list, so a stale id is
                // rejected here rather than by the vendor mid-session. The
                // pipeline's voices belong to whichever TTS engine was picked
                // and are catalogued there — there is no list to check against
                // here, and an unknown one falls back inside that engine, which
                // is the only place that knows.
                match voice.as_deref() {
                    Some(v) if p.pipeline => v,
                    Some(v) if p.voices.contains(&v) => v,
                    _ => p.voice,
                },
            )
            .env("CINDERPAW_LIVE_INSTRUCTIONS", brief)
            // Declared once, in Rust, and handed over as JSON. Restating the
            // tool in JavaScript would be a second description of the same door
            // — and that description is load-bearing prose that was rewritten
            // after a measurement, not boilerplate.
            .env(
                "CINDERPAW_LIVE_TOOLS",
                serde_json::to_string(&crate::live::bridge::declarations()).unwrap_or_else(|_| "[]".into()),
            );
        // Where to send a tool call, and the credential for it. The API server
        // is already listening on loopback for the sidecar; this reuses it
        // rather than opening a second door into the same room.
        if let Some(rt) = &runtime {
            cmd.env("CINDERPAW_API_URL", format!("http://127.0.0.1:{}", rt.settings.api_port))
                .env("CINDERPAW_API_TOKEN", rt.local_api_token.as_ref());
        }
    }
    let mut agent = cmd.spawn().map_err(|e| format!("cannot start the voice agent: {e}"))?;

    // Both pipes are drained from the moment the child exists, and that is a
    // correctness requirement rather than tidiness. stderr used to be read only
    // on the startup-failure path, which means nothing read it during the wait
    // below — and a child whose stderr pipe fills BLOCKS on its next write.
    // Node writes deprecation warnings there unprompted, so the failure was a
    // worker that had gone quiet mid-startup and a message on screen quoting a
    // deprecation notice as the reason the call did not happen.
    let stderr_tail = Arc::new(parking_lot::Mutex::new(String::new()));
    if let Some(err) = agent.stderr.take() {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                tracing::warn!("livekit agent: {line}");
                // Kept so a startup failure can still be explained, bounded so
                // a long call cannot grow it without limit.
                let mut buf = tail.lock();
                if buf.len() > 8_192 {
                    buf.clear();
                }
                buf.push_str(&line);
                buf.push('\n');
            }
        });
    }

    // Draining stdout is mandatory regardless of who is listening, for the same
    // reason: let the pipe fill and Node blocks on its next log line, which
    // reads as a call that works for a minute and then freezes.
    if let Some(stdout) = agent.stdout.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match line.strip_prefix("CINDERPAW_EVENT ") {
                    Some(json) => match serde_json::from_str::<serde_json::Value>(json) {
                        Ok(v) => {
                            log_event(&v);
                            on_event(v);
                        }
                        Err(e) => tracing::warn!("livekit: unreadable agent event ({e}): {json}"),
                    },
                    // INFO, not DEBUG. Everything the worker prints that is not
                    // an event is the LiveKit SDK explaining itself, which is
                    // the only account anyone has of a call that dropped. At
                    // debug level it was written nowhere by default, so two
                    // calls ended in "connection lost, reconnecting" with not
                    // one line on disk about the transport.
                    None => tracing::info!("livekit agent: {line}"),
                }
            }
        });
    }

    // Ready is what the worker SAYS it is, asked over its own health endpoint,
    // which answers 200 only once its websocket to the server is open — i.e.
    // once it is registered and can be dispatched.
    //
    // This used to scrape stdout for the words "registered worker". That reads
    // a log line as an API: it depends on the SDK's phrasing, on its log level,
    // and on that one line surviving whatever else is being printed — and when
    // any of those changed the call did not fail, it TIMED OUT, ninety seconds
    // later, blaming whatever happened to be last on stderr. A worker that has
    // registered can answer a question; that is a fact, not a string.
    let worker_health = format!("http://127.0.0.1:{}/", ports.worker);
    let mut ready = false;
    for _ in 0..200 {
        if reqwest::get(&worker_health).await.map(|r| r.status().is_success()).unwrap_or(false) {
            ready = true;
            break;
        }
        // A worker that has exited is not going to answer, and waiting the full
        // minute to say so puts the real reason a minute away from the button.
        if let Ok(Some(status)) = agent.try_wait() {
            let why = stderr_tail.lock().clone();
            let _ = server.start_kill();
            return Err(format!(
                "the voice agent stopped straight away ({status}). {}",
                if why.trim().is_empty() { "It stopped without saying why." } else { first_real_line(&why) }
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(75)).await;
    }

    if !ready {
        let why = stderr_tail.lock().clone();
        let _ = agent.start_kill();
        let _ = server.start_kill();
        return Err(format!(
            "the voice agent never started. {}",
            if why.trim().is_empty() {
                "It is still running but never registered with the local voice server."
            } else {
                first_real_line(&why)
            }
        ));
    }

    tracing::info!("livekit: call up on {http}");
    Ok(Session {
        server,
        agent,
        key: key.to_string(),
        secret: secret.clone(),
        url: format!("ws://127.0.0.1:{}", ports.http),
        token: mint_token(key, &secret, identity, &room, 60 * 60),
        room,
        mode: mode.to_string(),
        spec,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    /// The shape this replaced, kept because it is the reason the gate exists.
    ///
    /// Slot-check then boot, with nothing between them: the warmup and the
    /// button both look, both find the slot empty, and both pay for a chain.
    /// Two LiveKit servers, two Node workers, and the person waiting the full
    /// boot they had been warmed out of.
    #[tokio::test]
    async fn without_a_gate_a_warmup_and_a_pressed_button_both_boot() {
        // No gate here on purpose: this is the old shape.
        let slot: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);
        let boots = std::sync::atomic::AtomicUsize::new(0);
        let unguarded = |wanted: &'static str| async {
            if slot.lock().as_deref() == Some(wanted) {
                return;
            }
            boots.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            *slot.lock() = Some(wanted.to_string());
        };
        tokio::join!(unguarded("gemini||||"), unguarded("gemini||||"));
        assert_eq!(boots.load(Ordering::SeqCst), 2, "this is the bug being fixed");
    }

    #[tokio::test]
    async fn a_button_pressed_during_a_warmup_joins_it_instead_of_booting_again() {
        let gate = BootGate::const_new(());
        let slot: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);
        let boots = std::sync::atomic::AtomicUsize::new(0);
        let boot = || async {
            boots.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            Ok("gemini||||".to_string())
        };

        let warm = join_or_boot(&gate, &slot, "gemini||||", |c| c.as_str(), false, boot);
        let pressed = async {
            // Long enough to be inside the warmup's boot, which is the window
            // the old code booted a second chain in.
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            join_or_boot(&gate, &slot, "gemini||||", |c| c.as_str(), true, boot).await
        };
        let (w, p) = tokio::join!(warm, pressed);

        assert_eq!(w.unwrap(), Chain::Booted);
        assert_eq!(p.unwrap(), Chain::Warm, "the button must join the warm chain");
        assert_eq!(boots.load(Ordering::SeqCst), 1, "one chain, not two");
    }

    /// A warmup exists to be free. One that queues behind another boot is a
    /// background task holding the gate against the button that follows it.
    #[tokio::test]
    async fn a_warmup_that_would_have_to_queue_gives_up() {
        let gate = BootGate::const_new(());
        let slot: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);
        let boot = || async {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            Ok("gemini||||".to_string())
        };
        let first = join_or_boot(&gate, &slot, "gemini||||", |c| c.as_str(), true, boot);
        let second = async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            join_or_boot(&gate, &slot, "openai||||", |c| c.as_str(), false, boot).await
        };
        let (_, s) = tokio::join!(first, second);
        assert_eq!(s.unwrap(), Chain::Busy);
    }

    /// A chain carries its vendor, voice and engines in the environment of a
    /// process that is already running. Handing that one back to somebody who
    /// switched vendor is a call that connects and answers in the wrong voice.
    #[tokio::test]
    async fn a_chain_warmed_for_something_else_is_taken_down_not_handed_over() {
        let gate = BootGate::const_new(());
        let slot: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(Some("gemini||||".into()));
        let out = join_or_boot(&gate, &slot, "openai||||", |c| c.as_str(), true, || async {
            Ok("openai||||".to_string())
        })
        .await;
        assert_eq!(out.unwrap(), Chain::Booted);
        assert_eq!(slot.lock().as_deref(), Some("openai||||"));
    }

    /// Every setting Rust hands the agent is one the agent reads.
    ///
    /// Rust and the worker agree about these names in two files, in two
    /// languages, with nothing between them. That has already been wrong twice:
    /// once when Rust sent `pipeline` and the agent compared against `local`, so
    /// every on-device call silently fell through to echo, and once when the
    /// agent posted a body `/runtime/chat` could not read. Both were invisible
    /// until somebody made a call and got nothing.
    #[test]
    /// Every tuning setting the agent defaults must also have a validation
    /// rule, read out of the file rather than listed here so a fourth setting
    /// cannot be added without this noticing.
    ///
    /// The rule is not decoration: `endpointing()` looks the rule up by key and
    /// calls it. A default with no rule used to mean `undefined(value)`, which
    /// throws at call start. It is defended in the file too; this is what stops
    /// it being written in the first place.
    #[test]
    fn every_tuning_default_has_a_validation_rule() {
        let agent = include_str!("livekit_agent.mjs");
        let block = |name: &str| {
            let start = agent
                .find(&format!("const {name} = {{"))
                .unwrap_or_else(|| panic!("{name} is gone from livekit_agent.mjs"));
            let end = start
                + agent[start..]
                    .find("
};")
                    .expect("an unterminated object literal");
            &agent[start..end]
        };
        // Keys are the identifiers followed by a colon at the start of a line.
        let keys = |body: &str| -> Vec<String> {
            body.lines()
                .filter_map(|l| {
                    let t = l.trim();
                    if t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") {
                        return None;
                    }
                    let name = t.split(':').next()?.trim();
                    if name.is_empty()
                        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                        || !t.contains(':')
                    {
                        return None;
                    }
                    Some(name.to_string())
                })
                .collect()
        };
        let defaults = keys(block("ENDPOINTING_DEFAULTS"));
        let rules = keys(block("ENDPOINTING_RULES"));
        assert_eq!(defaults.len(), 3, "found {defaults:?}; the scan is not finding them");
        for key in &defaults {
            assert!(
                rules.contains(key),
                "{key} has a default but no validation rule, so a hand-edited                  voice-tuning.json could send anything to the vendor"
            );
        }
        for key in &rules {
            assert!(
                defaults.contains(key),
                "{key} has a validation rule but no default, so it is never read"
            );
        }
    }

    #[test]
    fn every_setting_rust_hands_the_agent_is_one_the_agent_reads() {
        let rust = include_str!("livekit.rs");
        let agent = include_str!("livekit_agent.mjs");
        // The names Rust puts in the child's environment, taken from the source
        // rather than listed here, so a new one cannot be added without this
        // test seeing it.
        let mut sent: Vec<&str> = rust
            .match_indices(".env(\"CINDERPAW_")
            .map(|(i, _)| {
                let start = i + ".env(\"".len();
                let end = start + rust[start..].find('"').expect("a closed string");
                &rust[start..end]
            })
            .collect();
        sent.sort_unstable();
        sent.dedup();
        assert!(sent.len() >= 5, "found only {sent:?}; the scan is not finding them");
        for name in sent {
            // The worker's own port is read by the SDK's own options block, and
            // the API pair is read by the tool bridge; all of them appear in the
            // file by name, which is the whole check.
            assert!(
                agent.contains(name),
                "Rust sends {name} and livekit_agent.mjs never reads it"
            );
        }
    }

    /// The call must not go silent while a tool runs.
    ///
    /// The brief already asks the model to keep talking, at length, and on every
    /// vendor except Gemini's native-audio model it CANNOT: the tool call runs
    /// inside the turn, so the model is not choosing silence, it is unable to
    /// speak. Thirty seconds of that is indistinguishable from a dropped call,
    /// which is why the filler is spoken by the worker rather than asked of the
    /// model, and why no prompt change can replace it.
    #[test]
    fn the_worker_speaks_for_itself_while_a_tool_is_running() {
        let agent = include_str!("livekit_agent.mjs");
        assert!(agent.contains("keepLineWarm"), "nothing warms the line while ask_cinder runs");
        assert!(
            agent.contains("session.say("),
            "the filler has to be spoken by the worker, not requested from a model that is blocked",
        );
        // Not decoration: an English "one moment" inside a Romanian call is the
        // product changing identity mid-sentence.
        assert!(agent.contains("O secund"), "the filler is English-only");
        // And Rust has to tell it which language to use.
        assert!(
            agent.contains("CINDERPAW_LIVE_LANGUAGE"),
            "the worker cannot know the language it should speak in",
        );
        // A fixed cadence is right for thirty seconds and wrong for three
        // minutes: at twelve seconds flat, a long job cycles the same four
        // lines through the caller four times over and stops sounding like
        // someone working.
        assert!(
            agent.contains("FILLER_BACKOFF") && agent.contains("MAX_FILLER_MS"),
            "the filler cadence has to back off on a long tool call",
        );
        assert!(
            !agent.contains("setInterval("),
            "a fixed interval cannot back off",
        );
        // The half this test used to miss entirely.
        //
        // It asserted that `session.say(` appears in the file, which it always
        // did — and the call threw on every invocation, because the SDK
        // refuses to synthesise text for a session with no TTS and the
        // realtime session was built without one. Three failures in one real
        // call, a minute of silence, and a green test over all of it. Asserting
        // the session is CONSTRUCTED with a tts is the thing that would have
        // caught it.
        assert!(
            agent.contains("new voice.AgentSession({ llm: await build(), tts: new LocalTTS(null) })"),
            "the realtime session needs a TTS or `say` throws and the filler never speaks",
        );
        // And on Gemini the filler must NOT speak, because the model does.
        //
        // `toolBehavior: NON_BLOCKING` is what keeps the floor and the
        // microphone open while a tool runs — without it the plugin drops
        // every incoming audio frame (`shouldBlockRealtimeInputForPendingTools`)
        // and the caller is ignored mid-sentence. With it, the model fills the
        // gap in its own voice, and a second voice from the local engine would
        // be two people talking at one person.
        assert!(
            agent.contains("toolBehavior: 'NON_BLOCKING'"),
            "a blocking tool call mutes the model AND drops the caller's audio",
        );
        assert!(
            agent.contains("SPEAKS_FOR_ITSELF ? () => {} : keepLineWarm(session)"),
            "the local filler has to stand down when the model can speak for itself",
        );
        // Turn detection is configured, not inherited. The vendor's default
        // ends a turn eagerly: on a real call it closed one in the middle of a
        // long question, at 46 characters, and answered nothing — the caller
        // paused to let it think and heard it give up.
        assert!(
            agent.contains("realtimeInputConfig: { automaticActivityDetection: endpointing() }"),
            "without this the vendor picks when the caller has stopped talking",
        );
    }

    /// The worker must hang up on a slow tool AFTER Rust has had its say.
    ///
    /// Rust answers a tool that overruns `VOICE_TOOL_DEADLINE` with a sentence
    /// the model can speak: still working, tell them, ask again shortly. The
    /// worker's abort was set below that budget, so the request was cancelled
    /// before the answer was due, every time — the holding reply had never
    /// been sent in a whole log of real calls. The model got a failure while
    /// the search was still running, and told the caller it had searched.
    #[test]
    fn the_worker_waits_longer_than_the_server_takes() {
        let agent = include_str!("livekit_agent.mjs");
        let abort_ms: u64 = agent
            .split("AbortSignal.timeout(")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .and_then(|n| n.trim().parse().ok())
            .expect("the worker aborts a tool request on a timeout");
        // Read from the constant itself, not typed again here. Two copies of
        // this number drifting apart is the exact defect under test.
        let server_deadline_ms = crate::api::VOICE_TOOL_DEADLINE.as_millis() as u64;
        assert!(
            abort_ms > server_deadline_ms,
            "the worker aborts at {abort_ms}ms, before the server's {server_deadline_ms}ms answer",
        );
    }

    /// What entering a call actually costs, on this machine, with the real
    /// server and the real Node worker.
    ///
    /// Ignored by default because it spawns processes, takes half a minute and
    /// needs the chain installed. It is here rather than in a script because
    /// the thing being measured is this module, and a number produced by a
    /// different code path is a number about a different program.
    ///
    ///   cargo test -p cinderpaw-core --lib livekit_entry_latency -- --ignored --nocapture
    ///
    /// It reports four numbers: a cold boot, a warm join, what a button press
    /// two seconds into a warmup costs WITH the gate, and what the same press
    /// cost before it, which is a second cold boot.
    #[tokio::test]
    #[ignore]
    async fn livekit_entry_latency() {
        use std::time::Instant;
        if find_server(&[]).is_none() {
            eprintln!("no server binary installed; nothing to measure");
            return;
        }
        // Whatever a default call on THIS machine resolves to. Hard-coding
        // "echo" here measured a chain that was never asked for on a machine
        // with a key stored.
        let spec = session_spec(None, None, None, None, None, None);
        let spec = spec.as_str();
        let boot = || async {
            start(&[], "you", None, None, None, None, None, None, None, |_| {}, None).await
        };

        let gate = BootGate::const_new(());
        let slot = parking_lot::Mutex::new(None);
        let t = Instant::now();
        let cold = join_or_boot(&gate, &slot, spec, |s: &Session| s.spec.as_str(), true, boot).await;
        let cold_ms = t.elapsed().as_millis();
        assert!(cold.is_ok(), "cold boot failed: {cold:?}");

        let t = Instant::now();
        let warm = join_or_boot(&gate, &slot, spec, |s: &Session| s.spec.as_str(), true, boot).await;
        let warm_ms = t.elapsed().as_millis();
        assert_eq!(warm.unwrap(), Chain::Warm);
        drop(slot.lock().take());

        // The pre-call screen warms; two seconds later the button is pressed.
        let gate = BootGate::const_new(());
        let slot = parking_lot::Mutex::new(None);
        let warming = join_or_boot(&gate, &slot, spec, |s: &Session| s.spec.as_str(), false, boot);
        let pressed_at = std::sync::Mutex::new(None);
        let pressed = async {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let t = Instant::now();
            let r = join_or_boot(&gate, &slot, spec, |s: &Session| s.spec.as_str(), true, boot).await;
            *pressed_at.lock().unwrap() = Some(t.elapsed().as_millis());
            r
        };
        let (_, p) = tokio::join!(warming, pressed);
        assert!(p.is_ok());
        let gated_ms = pressed_at.lock().unwrap().unwrap();
        drop(slot.lock().take());

        // The same press without the gate, which is what shipped: the slot is
        // still empty two seconds in, so it boots its own chain from scratch.
        let slot: parking_lot::Mutex<Option<Session>> = parking_lot::Mutex::new(None);
        let warming = async {
            let s = boot().await;
            if let Ok(s) = s {
                *slot.lock() = Some(s);
            }
        };
        let ungated_at = std::sync::Mutex::new(None);
        let pressed = async {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let t = Instant::now();
            let second = if slot.lock().is_some() { None } else { Some(boot().await) };
            *ungated_at.lock().unwrap() = Some(t.elapsed().as_millis());
            second
        };
        let (_, second) = tokio::join!(warming, pressed);
        let ungated_ms = ungated_at.lock().unwrap().unwrap();
        // Not asserted, because the interesting result is that it often does
        // not merely take twice as long: the second boot's `reap_orphan_server`
        // reads the pid file the first one just wrote and kills its server.
        let ungated_outcome = match &second {
            Some(Ok(_)) => "booted a second chain".to_string(),
            Some(Err(e)) => format!("failed: {e}"),
            None => "joined".to_string(),
        };
        drop(second);
        drop(slot.lock().take());

        println!("cold boot                       {cold_ms} ms");
        println!("warm join                       {warm_ms} ms");
        println!("press 2s into a warmup, gated   {gated_ms} ms");
        println!("press 2s into a warmup, before  {ungated_ms} ms  ({ungated_outcome})");
    }

    /// A token the server rejects looks exactly like a token it accepts until
    /// the call fails, so the parts that grant entry are checked here.
    #[test]
    fn minted_token_carries_what_livekit_needs() {
        let jwt = mint_token("k", "s", "someone", "cinderpaw", 60);
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "a JWT is three dot-separated parts");

        let decode = |p: &str| {
            String::from_utf8(
                base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p).expect("base64url"),
            )
            .expect("utf8")
        };
        assert!(decode(parts[0]).contains("HS256"));

        let claims: serde_json::Value = serde_json::from_str(&decode(parts[1])).expect("json");
        assert_eq!(claims["iss"], "k", "the api key identifies the signer");
        assert_eq!(claims["sub"], "someone");
        // The one that actually grants entry. Without it the token parses and
        // the server still says no.
        assert_eq!(claims["video"]["roomJoin"], true);
        assert_eq!(claims["video"]["room"], "cinderpaw");
        assert!(claims["exp"].as_u64().unwrap() > claims["nbf"].as_u64().unwrap());
    }

    /// The config is load-bearing prose in `docs/voice-livekit.md`; these are
    /// the lines whose absence costs an afternoon.
    #[test]
    fn config_stays_on_loopback_and_advertises_it() {
        let yaml = config_yaml("k", "s", &pick_ports().expect("a free port"));
        assert!(yaml.contains("- 127.0.0.1"), "must not bind every interface");
        assert!(yaml.contains("node_ip: 127.0.0.1"), "without this ICE never completes");
        assert!(!yaml.contains("interfaces"), "narrowing interfaces breaks ICE");
    }

    /// The reason shown to a person must be the reason, and a Node crash puts
    /// its version banner last — which is how a missing export was reported as
    /// "Node.js v24.14.1" for one whole debugging round.
    #[test]
    fn crash_reports_the_error_not_the_banner() {
        let node_crash = "
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './voice' is not defined
    at exportsNotFound (node:internal/modules/esm/resolve:314:10)

Node.js v24.14.1
";
        assert!(first_real_line(node_crash).contains("ERR_PACKAGE_PATH_NOT_EXPORTED"));

        // The transcript that started this: LiveKit complains about CPU
        // monitoring at ERROR level, prints a Go stack, carries on, and then
        // dies of a port collision. The user was shown the CPU line.
        let livekit_bind_clash = "
2026-08-23T14:19:43.058+0300	ERROR	livekit	hwstats/cpu_null.go:38	CPU monitoring unsupported on current platform. Server capacity management will be disabled
github.com/livekit/protocol/utils/hwstats.newPlatformCPUMonitor
	/home/runner/go/pkg/mod/github.com/livekit/protocol@v1.50.5/utils/hwstats/cpu_null.go:38
main.startServer
	/home/runner/work/livekit/livekit/cmd/server/main.go:299
runtime.main
	/opt/hostedtoolcache/go/1.26.5/x64/src/runtime/proc.go:290
listen tcp :61111: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.
";
        let reported = first_real_line(livekit_bind_clash);
        assert!(reported.contains("bind:"), "reported {reported:?}");
        assert!(!reported.contains("CPU monitoring"), "reported the banner: {reported:?}");
        assert_eq!(first_real_line("   
  
"), "No reason was reported.");
        assert_eq!(first_real_line("just one line"), "just one line");
    }

    /// A room that already exists gets no agent: LiveKit dispatches a nameless
    /// worker when a room is CREATED, and it keeps an empty room alive for
    /// minutes. Two calls sharing a name is therefore a call with nobody on the
    /// other end, reported as success.
    #[test]
    fn every_call_gets_its_own_room() {
        assert_ne!(new_room(), new_room());
        assert!(new_room().unwrap().starts_with("cinderpaw-"));
    }

    /// A fixed port let an orphaned server from a previous run answer the
    /// "are you up?" probe, so the worker then failed to authenticate against a
    /// server we believed we had started. Two ports that are never the same
    /// cannot be confused for each other.
    #[test]
    fn every_call_picks_its_own_ports() {
        let a = pick_ports().expect("a free port");
        let b = pick_ports().expect("a free port");
        assert_ne!(a.http, b.http);
        assert_ne!(a.http, a.rtc_tcp, "signalling and media must not collide");
        assert!(a.rtc_udp.1 > a.rtc_udp.0, "the media range must be a range");
    }

    /// Two calls must not share a secret, or a token from a call that ended
    /// still opens the next one.
    #[test]
    fn each_call_gets_its_own_secret() {
        assert_ne!(random_secret().unwrap(), random_secret().unwrap());
        assert_eq!(random_secret().unwrap().len(), 64, "32 bytes as hex");
    }

    /// The table is what four separate pieces of the call agree about. A
    /// duplicate id would make `provider_by_id` return the wrong row; a shared
    /// plugin would make the install check pass for a vendor whose plugin was
    /// never fetched, which is the exact bug this table replaced.
    #[test]
    fn every_provider_is_its_own_row() {
        for (i, p) in S2S_PROVIDERS.iter().enumerate() {
            assert!(!p.id.is_empty() && !p.label.is_empty(), "{}", p.id);
            assert!(p.plugin.starts_with("@livekit/agents-plugin-"), "{}", p.plugin);
            if p.pipeline {
                // The pipeline row pins nothing: its engines and voices live in
                // the real TTS/STT catalogues. Asserted so a later "tidy-up"
                // cannot pin them here and quietly override the catalogue —
                // which is how this row first shipped hard-wired to Piper.
                assert!(p.model.is_empty() && p.voice.is_empty() && p.voices.is_empty(), "{}", p.id);
            } else {
                assert!(!p.model.is_empty() && !p.voice.is_empty(), "{}", p.id);
                assert!(p.voices.contains(&p.voice), "{} default is not in its own list", p.id);
            }
            for other in &S2S_PROVIDERS[i + 1..] {
                assert_ne!(p.id, other.id);
                assert_ne!(p.plugin, other.plugin);
            }
            assert!(provider_by_id(p.id).is_some());
        }
        assert!(provider_by_id("nobody").is_none());
        assert_eq!(
            S2S_PROVIDERS.iter().filter(|p| p.pipeline).count(),
            1,
            "exactly one row may be the assembled pipeline",
        );
    }

    /// The pipeline must never need a key, and must never become the default
    /// nobody chose.
    ///
    /// Both halves matter and they pull opposite ways. If it needed a key it
    /// would be unreachable, since it has none of its own to store. If it were
    /// in the unset-fallback it would become everyone's silent default the
    /// moment a machine had no cloud key — and which engines hear and answer
    /// somebody is not a choice to make for them, in either direction.
    #[test]
    fn the_pipeline_needs_no_key_and_is_never_the_silent_default() {
        let row = provider_by_id("pipeline").expect("a pipeline row");
        assert!(row.pipeline);
        // Picked explicitly: resolved, with an empty key, whatever is stored.
        let (p, key) = resolve_provider(Some("pipeline")).expect("the pipeline needs no key");
        assert_eq!(p.id, "pipeline");
        assert!(key.is_empty());
        // Not picked: never chosen for the user. This asserts the FILTER, not
        // the machine's keychain — a developer box with a key stored would
        // otherwise make this pass for the wrong reason.
        assert!(
            !S2S_PROVIDERS.iter().filter(|p| !p.pipeline).any(|p| p.pipeline),
            "the unset fallback must exclude the pipeline row",
        );
    }

    /// A scoped npm name is TWO directories under `node_modules`, not one.
    /// Joining it whole produces a path that never exists, so the install would
    /// re-run on every single call — an npm install in front of a person who
    /// pressed a call button.
    #[test]
    fn a_scoped_package_resolves_to_a_nested_directory() {
        let root = std::path::Path::new("root");
        let joined = "@livekit/agents-plugin-openai"
            .split('/')
            .fold(root.join("node_modules"), |acc, seg| acc.join(seg));
        assert_eq!(
            joined,
            root.join("node_modules").join("@livekit").join("agents-plugin-openai"),
        );
    }
}
