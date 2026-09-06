use anyhow::{Context as _, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceMeta {
    pub audio_path: String,
    pub duration_ms: u32,
    pub transcript: String,
    /// Normalized 0..1 peak buckets for the waveform.
    pub peaks: Vec<f32>,
}

/// What the agent wrote in its own scratchpad (`~/.cinderpaw/workspace`) during one
/// turn.
///
/// Persisted rather than kept in memory because the whole point of the line is
/// to be read AFTER the fact — by someone who walked away, and quite possibly
/// after restarting the app. A trace that survives only until the next launch is
/// the ephemeral tool strip again, one layer up.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ScratchStats {
    pub edits: u32,
    pub added: u32,
    pub removed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PersistedMessage {
    pub role: String,
    pub content: String,
    /// Chain-of-thought content shown as a collapsible "Thought for Xs" block.
    /// Optional so existing on-disk conversations without this field load cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// Present when this user turn was recorded as a voice message. Optional and
    /// `#[serde(default)]` so conversations saved before this field load cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceMeta>,
    /// Scratchpad churn for this turn. Absent on most messages and on every
    /// conversation saved before this field existed — same `#[serde(default)]`
    /// contract as the two above, so no migration and no unreadable history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch: Option<ScratchStats>,
    /// When the message was created, epoch milliseconds.
    ///
    /// Nothing recorded it before, so the UI invented one on reload — every
    /// message in a re-opened conversation claimed to be seconds old, whatever
    /// day it was actually written. Optional and `#[serde(default)]` like the
    /// fields above: conversations saved before this still load, they just have
    /// nothing better than the old guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<PersistedMessage>,
    /// Agent that owns this conversation, if it was created in the Agents tab.
    /// `None` for ordinary chat conversations. `#[serde(default)]` keeps existing
    /// on-disk conversations (saved before this field existed) loadable.
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    /// Mirrors `Conversation::agent_id` so the sidebar can route a click to the
    /// right tab (Agents vs Chat) without loading the full conversation.
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ConversationIndex {
    conversations: Vec<ConversationSummary>,
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn read_index(dir: &Path) -> Result<Vec<ConversationSummary>> {
    let path = index_path(dir);
    if !path.exists() {
        return Ok(vec![]);
    }
    let bytes = std::fs::read(&path)?;
    let index: ConversationIndex = serde_json::from_slice(&bytes)?;
    Ok(index.conversations)
}

/// Serialises every read-modify-write of the index.
///
/// `save_to_dir` and `delete_from_dir` both read the whole index, change one
/// entry and write it back. Two of them at once — a chat autosave landing while
/// the user deletes another conversation — each start from the same "before",
/// and the second write erases the first change with nothing to show for it.
/// The sidebar then disagrees with what is on disk until the next full reload.
static INDEX_WRITE: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn write_index(dir: &Path, summaries: &[ConversationSummary]) -> Result<()> {
    let index = ConversationIndex { conversations: summaries.to_vec() };
    // Atomic: a truncate-in-place that dies halfway leaves an index.json no
    // parser accepts, and the whole conversation list reads as empty — every
    // chat still on disk, none of them visible.
    cinderpaw_core::atomic_file::write_atomic(&index_path(dir), &serde_json::to_vec(&index)?)?;
    Ok(())
}

/// Redact credentials from every message body (and from the thinking
/// block, which quotes the conversation back and would otherwise keep a
/// copy of anything redacted above it).
///
/// Returns an owned Vec either way; a conversation with no secrets in it
/// comes back byte-identical.
fn redact_messages(messages: &[PersistedMessage]) -> Vec<PersistedMessage> {
    messages
        .iter()
        .map(|m| {
            let content = cinderpaw_core::secret_redact::redact_secrets(&m.content);
            let thinking = m.thinking.as_ref().map(|t| {
                let r = cinderpaw_core::secret_redact::redact_secrets(t);
                r.text
            });
            if content.redactions > 0 {
                tracing::info!(
                    role = %m.role,
                    count = content.redactions,
                    "conversation save: credential redacted from the stored copy"
                );
            }
            PersistedMessage { content: content.text, thinking, ..m.clone() }
        })
        .collect()
}

// ── Dir-parameterised core (used by both Tauri commands and tests) ─────────────

pub fn save_to_dir(
    dir: &Path,
    id: &str,
    title: &str,
    messages: &[PersistedMessage],
    agent_id: Option<&str>,
) -> Result<()> {
    let _guard = INDEX_WRITE.lock();
    std::fs::create_dir_all(dir)?;

    let conv_path = dir.join(format!("{}.json", id));
    // Preserve created_at and a previously-stored agent_id across re-saves. A
    // caller that doesn't supply agent_id (e.g. the chat path) must not wipe an
    // existing agent tag.
    let existing: Option<Conversation> = if conv_path.exists() {
        std::fs::read(&conv_path).ok()
            .and_then(|b| serde_json::from_slice::<Conversation>(&b).ok())
    } else {
        None
    };
    let created_at = existing
        .as_ref()
        .map(|c| c.created_at.clone())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let agent_id = agent_id
        .map(str::to_string)
        .or_else(|| existing.and_then(|c| c.agent_id));

    let updated_at = Utc::now().to_rfc3339();

    // Strip credentials before anything reaches the disk.
    //
    // The connector flow asks the user, in plain words, to paste a bot
    // token into the chat. The sidecar already keeps that out of memory,
    // but this file is a second store and it kept the token in
    // plaintext — a transcript anyone can open, sitting next to the
    // keychain we went to the trouble of using.
    //
    // This runs on the SAVED copy only. The conversation on screen is
    // untouched, so the user still sees what they typed in the session
    // they typed it in.
    let messages = redact_messages(messages);

    let conv = Conversation {
        id: id.to_string(),
        title: title.to_string(),
        created_at,
        updated_at: updated_at.clone(),
        messages,
        agent_id: agent_id.clone(),
    };

    cinderpaw_core::atomic_file::write_atomic(&conv_path, &serde_json::to_vec(&conv)?)?;

    let mut summaries = read_index(dir)?;
    let summary = ConversationSummary {
        id: id.to_string(),
        title: title.to_string(),
        updated_at,
        agent_id,
    };
    match summaries.iter_mut().find(|s| s.id == id) {
        Some(existing) => *existing = summary,
        None => summaries.push(summary),
    }
    write_index(dir, &summaries)?;

    Ok(())
}

/// Change a conversation's title, and nothing else.
///
/// Deliberately not "load it and call `save_to_dir`". That path rewrites
/// `updated_at`, which would send a chat from March to the top of the list
/// under "Today" the moment somebody fixed a typo in its name — the list is
/// ordered by when you last TALKED to it, and renaming is not talking.
///
/// Takes the same index lock as save and delete: it is another read-modify-
/// write of the shared index, and without the lock a rename landing beside an
/// autosave loses one of the two.
pub fn rename_in_dir(dir: &Path, id: &str, title: &str) -> Result<()> {
    let _guard = INDEX_WRITE.lock();

    let conv_path = dir.join(format!("{}.json", id));
    let bytes = std::fs::read(&conv_path)
        .with_context(|| format!("no conversation to rename at {}", conv_path.display()))?;
    let mut conv: Conversation = serde_json::from_slice(&bytes)?;
    conv.title = title.to_string();
    cinderpaw_core::atomic_file::write_atomic(&conv_path, &serde_json::to_vec(&conv)?)?;

    // The index is what the list reads. A rename that only touched the
    // conversation file would show the old name everywhere until something
    // else happened to rewrite the index.
    let mut summaries = read_index(dir)?;
    if let Some(entry) = summaries.iter_mut().find(|s| s.id == id) {
        entry.title = title.to_string();
        write_index(dir, &summaries)?;
    }
    Ok(())
}

pub fn load_from_dir(dir: &Path, id: &str) -> Result<Conversation> {
    let bytes = std::fs::read(dir.join(format!("{}.json", id)))?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn load_index_from_dir(dir: &Path) -> Result<Vec<ConversationSummary>> {
    read_index(dir)
}

/// File names of every voice blob any saved conversation still points at.
///
/// Names, not paths, deliberately. `audio_path` is an absolute path written on
/// whatever machine and drive the recording was made on, and comparing absolute
/// paths across Windows separators and a case-insensitive filesystem is exactly
/// the comparison this codebase has already got wrong four separate times. The
/// names are UUIDs generated by `save_voice_blob`, so a name is as unique as a
/// path and cannot be spelled two ways.
///
/// Returns `Err` if any conversation could not be read. The caller must treat
/// that as "do not delete anything": an unreadable conversation is one whose
/// references are unknown, and the safe answer to unknown is to keep the audio.
/// Leaving a few megabytes on disk costs nothing anyone will notice; deleting
/// the recording of a conversation somebody kept is not recoverable.
pub fn referenced_audio_names_in_dir(dir: &Path) -> Result<std::collections::HashSet<String>> {
    let mut names = std::collections::HashSet::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // No conversations directory at all: nothing is referenced, and that is
        // a real answer rather than a failure to look.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(e) => return Err(e).context("listing conversations"),
    };
    for entry in entries {
        let entry = entry.context("reading a conversation directory entry")?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|n| n.to_str()) == Some("index.json") {
            continue;
        }
        let bytes = std::fs::read(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let conv: Conversation = serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing {}", path.display()))?;
        for m in &conv.messages {
            if let Some(v) = &m.voice {
                if let Some(name) = Path::new(&v.audio_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                {
                    names.insert(name.to_string());
                }
            }
        }
    }
    Ok(names)
}

pub fn delete_from_dir(dir: &Path, id: &str) -> Result<()> {
    let _guard = INDEX_WRITE.lock();
    let path = dir.join(format!("{}.json", id));
    // Best-effort cleanup of on-disk voice blobs referenced by this conversation
    // before the JSON is removed (errors ignored — orphaned files are harmless).
    //
    // `audio_path` is read back out of a JSON file, so it is untrusted input by
    // the time we get here: anything that can write a conversation (a model
    // fabricating voice metadata, a hand-edited file, a malicious import) would
    // otherwise aim this `remove_file` at ~/.ssh/id_rsa. Only blobs that really
    // live in the voice directory — where `save_voice_blob` puts them — are
    // ours to delete. `is_under` canonicalises, so `voice/../../secrets` fails
    // the check rather than passing it syntactically. It also fails closed when
    // the voice dir does not exist yet (fresh install, no recording ever made).
    if let Ok(conv) = load_from_dir(dir, id) {
        let voice_dir = paths::voice_dir();
        for m in &conv.messages {
            if let Some(v) = &m.voice {
                let audio = Path::new(&v.audio_path);
                match cinderpaw_core::rsi::paths::is_under(&voice_dir, audio) {
                    Ok(true) => {
                        let _ = std::fs::remove_file(audio);
                    }
                    _ => tracing::warn!(
                        path = %v.audio_path,
                        "conversation delete: refusing to remove a voice blob outside {}",
                        voice_dir.display()
                    ),
                }
            }
        }
    }
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let mut summaries = read_index(dir)?;
    summaries.retain(|s| s.id != id);
    write_index(dir, &summaries)?;
    Ok(())
}

// ── Tauri-facing wrappers ──────────────────────────────────────────────────────

pub fn save(id: &str, title: &str, messages: &[PersistedMessage], agent_id: Option<&str>) -> Result<()> {
    paths::ensure_dirs()?;
    save_to_dir(&paths::conversations_dir(), id, title, messages, agent_id)
}

pub fn load_all() -> Result<Vec<ConversationSummary>> {
    paths::ensure_dirs()?;
    load_index_from_dir(&paths::conversations_dir())
}

pub fn load(id: &str) -> Result<Conversation> {
    load_from_dir(&paths::conversations_dir(), id)
}

pub fn rename(id: &str, title: &str) -> Result<()> {
    paths::ensure_dirs()?;
    rename_in_dir(&paths::conversations_dir(), id, title)
}

pub fn delete(id: &str) -> Result<()> {
    paths::ensure_dirs()?;
    delete_from_dir(&paths::conversations_dir(), id)
}

pub fn clear_all() -> Result<()> {
    paths::ensure_dirs()?;
    let dir = paths::conversations_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    write_index(&dir, &[])
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("cinderpaw_conv_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn msgs(n: usize) -> Vec<PersistedMessage> {
        (0..n)
            .map(|i| PersistedMessage {
                role: if i % 2 == 0 { "user".into() } else { "assistant".into() },
                content: format!("Message {}", i),
                thinking: None,
                voice: None,
                scratch: None, created_at: None })
            .collect()
    }

    fn voice_msg(audio_path: &str) -> PersistedMessage {
        PersistedMessage {
            role: "user".into(),
            content: "spoken".into(),
            thinking: None,
            voice: Some(VoiceMeta {
                audio_path: audio_path.to_string(),
                duration_ms: 1200,
                transcript: "spoken".into(),
                peaks: vec![0.1, 0.9],
            }),
            scratch: None,
            created_at: None,
        }
    }

    /// The bug: the retention sweep deleted every voice blob older than thirty
    /// days, including the audio of messages in conversations the user had
    /// kept. This is the lookup that now stands between the sweep and those
    /// files, so what it reports has to be exactly right.
    #[test]
    fn audio_still_attached_to_a_saved_conversation_is_reported_as_in_use() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "kept", &[voice_msg("/somewhere/else/aaa-111.webm")], None).unwrap();
        save_to_dir(&dir, "c2", "also kept", &[voice_msg("C:\Users\d\voice\bbb-222.ogg")], None).unwrap();
        save_to_dir(&dir, "c3", "no voice here", &msgs(2), None).unwrap();

        let names = referenced_audio_names_in_dir(&dir).unwrap();
        // Matched by file name, so a path written on another machine, another
        // drive, or with the other separator still resolves to the same blob.
        assert!(names.contains("aaa-111.webm"));
        assert!(names.contains("bbb-222.ogg"));
        assert_eq!(names.len(), 2, "text-only conversations must contribute nothing: {names:?}");
    }

    /// Rule 2: unknown means keep. One unreadable conversation must fail the
    /// whole lookup, because its references are exactly what we cannot see —
    /// and the caller answers a failure by deleting nothing.
    #[test]
    fn one_unreadable_conversation_fails_the_whole_lookup_rather_than_under_reporting() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "kept", &[voice_msg("/v/aaa-111.webm")], None).unwrap();
        std::fs::write(dir.join("broken.json"), b"{ this is not json").unwrap();

        assert!(
            referenced_audio_names_in_dir(&dir).is_err(),
            "a conversation we cannot read must not be silently treated as referencing nothing"
        );
    }

    /// A fresh install has no conversations directory. That is an answer, not a
    /// failure: nothing is referenced, and the sweep may proceed.
    #[test]
    fn a_missing_conversations_directory_reports_nothing_referenced_and_is_not_an_error() {
        let dir = tmp().join("never-created");
        assert!(referenced_audio_names_in_dir(&dir).unwrap().is_empty());
    }

    /// Renaming changes the name and nothing else — above all not
    /// `updated_at`.
    ///
    /// The list is ordered and grouped by when you last TALKED to a
    /// conversation. Routing a rename through `save_to_dir` would stamp it with
    /// the current time, so correcting a typo in a chat from March would move it
    /// to the top of the sidebar under "Today". The chat would be findable
    /// exactly once — right after you renamed it — and then lost among the
    /// recent ones forever.
    #[test]
    fn renaming_does_not_touch_when_the_chat_last_happened() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "Old name", &msgs(4), None).unwrap();
        let before = load_from_dir(&dir, "c1").unwrap();

        rename_in_dir(&dir, "c1", "New name").unwrap();

        let after = load_from_dir(&dir, "c1").unwrap();
        assert_eq!(after.title, "New name");
        assert_eq!(after.updated_at, before.updated_at, "a rename is not a conversation");
        assert_eq!(after.created_at, before.created_at);
        assert_eq!(after.messages.len(), 4, "the messages must survive a rename");

        // The index is what the sidebar reads; a rename only the file knows
        // about shows the old name everywhere.
        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.iter().find(|s| s.id == "c1").unwrap().title, "New name");
        assert_eq!(index.iter().find(|s| s.id == "c1").unwrap().updated_at, before.updated_at);
    }

    #[test]
    fn renaming_a_chat_that_is_not_there_is_an_error_not_a_new_file() {
        let dir = tmp();
        assert!(rename_in_dir(&dir, "ghost", "Name").is_err());
        assert!(!dir.join("ghost.json").exists());
    }

    // ── RED tests written first ────────────────────────────────────────────────

    /// A conversation whose `voice.audio_path` points outside the voice
    /// directory must not have that file deleted along with it. The path comes
    /// out of a JSON file, so it is attacker-reachable; before the guard,
    /// deleting a conversation deleted whatever it named.
    #[test]
    fn delete_refuses_voice_blob_outside_voice_dir() {
        let dir = tmp();
        let victim = dir.join("not-a-voice-blob.txt");
        std::fs::write(&victim, b"a file that must survive").unwrap();

        let messages = vec![PersistedMessage {
            role: "user".into(),
            content: "hi".into(),
            thinking: None,
            voice: Some(VoiceMeta {
                audio_path: victim.to_string_lossy().into_owned(),
                duration_ms: 1,
                transcript: String::new(),
                peaks: vec![],
            }),
            scratch: None, created_at: None }];
        save_to_dir(&dir, "c1", "t", &messages, None).unwrap();

        delete_from_dir(&dir, "c1").unwrap();

        assert!(victim.exists(), "delete_from_dir removed a file outside the voice dir");
    }


    #[test]
    fn loads_message_without_voice_field() {
        let json = r#"{"role":"user","content":"hi"}"#;
        let m: PersistedMessage = serde_json::from_str(json).unwrap();
        assert!(m.voice.is_none());
        assert_eq!(m.content, "hi");
    }

    #[test]
    fn loads_message_written_before_the_scratch_field_existed() {
        // Every conversation already on a user's disk looks like this. Failing to
        // deserialize it would lose their whole history to a telemetry field.
        let json = r#"{"role":"assistant","content":"done","thinking":"hmm"}"#;
        let m: PersistedMessage = serde_json::from_str(json).unwrap();
        assert!(m.scratch.is_none());
        assert_eq!(m.thinking.as_deref(), Some("hmm"));
    }

    #[test]
    fn scratch_stats_survive_a_restart() {
        // The point of the whole change: the desktop used to hold this only in
        // memory, so "1 scratchpad edit +71" vanished the next time the app
        // launched — which is precisely when someone who walked away reads it.
        let dir = tmp();
        let msgs = vec![PersistedMessage {
            role: "assistant".into(),
            content: "wrote my notes".into(),
            thinking: None,
            voice: None,
            scratch: Some(ScratchStats { edits: 1, added: 71, removed: 0 }), created_at: None }];
        save_to_dir(&dir, "c1", "Title", &msgs, None).unwrap();

        // Nothing in memory — read back off disk exactly as a fresh launch does.
        let conv = load_from_dir(&dir, "c1").unwrap();
        let s = conv.messages[0].scratch.as_ref().expect("scratch stats should survive");
        assert_eq!((s.edits, s.added, s.removed), (1, 71, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_turn_that_touched_no_scratchpad_stores_no_field_at_all() {
        // `skip_serializing_if` — otherwise every message on disk grows a
        // `"scratch":null` for a line that will never be rendered.
        let m = PersistedMessage {
            role: "user".into(),
            content: "hi".into(),
            thinking: None,
            voice: None,
            scratch: None, created_at: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("scratch"), "absent stats must not be written: {json}");
    }

    #[test]
    fn save_creates_json_file_for_conversation() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "Title", &msgs(3), None).unwrap();
        assert!(dir.join("c1.json").exists(), "conversation file should exist on disk");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_returns_all_messages_after_save() {
        let dir = tmp();
        save_to_dir(&dir, "c1", "Title", &msgs(3), None).unwrap();

        let conv = load_from_dir(&dir, "c1").unwrap();
        assert_eq!(conv.messages.len(), 3);
        assert_eq!(conv.messages[0].content, "Message 0");
        assert_eq!(conv.messages[2].content, "Message 2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_conversations_persist_and_reload_independently() {
        let dir = tmp();

        save_to_dir(&dir, "conv-a", "Alpha", &msgs(3), None).unwrap();
        save_to_dir(&dir, "conv-b", "Beta", &msgs(4), None).unwrap();

        // Simulate "app closed" — read fresh from disk, no in-memory state.
        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 2, "index must contain both conversations");

        let ids: Vec<&str> = index.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"conv-a"), "conv-a missing from index");
        assert!(ids.contains(&"conv-b"), "conv-b missing from index");

        let a = load_from_dir(&dir, "conv-a").unwrap();
        let b = load_from_dir(&dir, "conv-b").unwrap();
        assert_eq!(a.messages.len(), 3);
        assert_eq!(b.messages.len(), 4);

        // Verify content integrity
        for (i, msg) in a.messages.iter().enumerate() {
            assert_eq!(msg.content, format!("Message {}", i), "conv-a message {} corrupted", i);
        }
        for (i, msg) in b.messages.iter().enumerate() {
            assert_eq!(msg.content, format!("Message {}", i), "conv-b message {} corrupted", i);
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_overwrites_messages_without_duplicating_index_entry() {
        let dir = tmp();

        save_to_dir(&dir, "c1", "Title", &msgs(1), None).unwrap();
        save_to_dir(&dir, "c1", "Title", &msgs(3), None).unwrap(); // update same conversation

        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 1, "index must have exactly one entry after two saves to same id");

        let conv = load_from_dir(&dir, "c1").unwrap();
        assert_eq!(conv.messages.len(), 3, "should have 3 messages after update");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_file_and_index_entry() {
        let dir = tmp();

        save_to_dir(&dir, "c1", "One", &msgs(2), None).unwrap();
        save_to_dir(&dir, "c2", "Two", &msgs(2), None).unwrap();

        delete_from_dir(&dir, "c1").unwrap();

        assert!(!dir.join("c1.json").exists(), "c1.json should be gone after delete");

        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].id, "c2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn full_roundtrip_simulating_app_restart() {
        // Closest to the integration requirement:
        // 1. Write 2 conversations (3+ messages each)
        // 2. Read everything from disk as if the app was restarted
        // 3. Verify all conversations and all messages are intact
        let dir = tmp();

        let conv1_msgs = vec![
            PersistedMessage { role: "user".into(),      content: "Hello world".into(),               thinking: None, voice: None, scratch: None, created_at: None },
            PersistedMessage { role: "assistant".into(), content: "Hi there!".into(),                 thinking: None, voice: None, scratch: None, created_at: None },
            PersistedMessage { role: "user".into(),      content: "What is Rust?".into(),             thinking: None, voice: None, scratch: None, created_at: None },
        ];
        let conv2_msgs = vec![
            PersistedMessage { role: "user".into(),      content: "Tell me a joke".into(),            thinking: None, voice: None, scratch: None, created_at: None },
            PersistedMessage { role: "assistant".into(), content: "Why did the crab...".into(),       thinking: None, voice: None, scratch: None, created_at: None },
            PersistedMessage { role: "user".into(),      content: "Ha! Another one".into(),           thinking: None, voice: None, scratch: None, created_at: None },
            PersistedMessage { role: "assistant".into(), content: "Sure! What do you call...".into(), thinking: None, voice: None, scratch: None, created_at: None },
        ];

        save_to_dir(&dir, "session-1", "Hello world", &conv1_msgs, None).unwrap();
        save_to_dir(&dir, "session-2", "Tell me a joke", &conv2_msgs, None).unwrap();

        // ── Simulate app restart: no in-memory state, read only from disk ──
        let index = load_index_from_dir(&dir).unwrap();
        assert_eq!(index.len(), 2, "should have 2 conversations after restart");

        let s1 = load_from_dir(&dir, "session-1").unwrap();
        let s2 = load_from_dir(&dir, "session-2").unwrap();

        assert_eq!(s1.messages.len(), 3);
        assert_eq!(s1.messages[0].role, "user");
        assert_eq!(s1.messages[0].content, "Hello world");
        assert_eq!(s1.messages[1].content, "Hi there!");
        assert_eq!(s1.messages[2].content, "What is Rust?");

        assert_eq!(s2.messages.len(), 4);
        assert_eq!(s2.messages[0].content, "Tell me a joke");
        assert_eq!(s2.messages[3].content, "Sure! What do you call...");

        std::fs::remove_dir_all(&dir).ok();
    }
}
