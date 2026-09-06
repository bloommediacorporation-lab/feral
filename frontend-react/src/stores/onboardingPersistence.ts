/**
 * Onboarding persistence — localStorage + Tauri commands.
 *
 * The wizard needs to know "has this user already onboarded?" in <1s
 * after app start. Three storage layers, in priority order:
 *
 *   1. localStorage (synchronous, always works)
 *      - Survives: Ctrl+R, F5, Vite HMR
 *      - Dies on: uninstall, Tauri auto-update (WebView data dir wiped)
 *
 *   2. ~/.cinderpaw/onboarding.json via Tauri command (Rust std::fs)
 *      - Survives: everything localStorage does PLUS uninstall + reinstall
 *        and Tauri auto-updates (lives in the user's home dir, outside
 *        the app data dir)
 *      - Requires: the Tauri Rust shell running (not pure browser dev)
 *
 *   3. (deprecated) @tauri-apps/plugin-fs — kept as a no-op fallback so
 *      the function signature is stable. Not used because the plugin
 *      needs capability registration we don't want to maintain.
 *
 * The order on `loadPersisted` is: localStorage first (sync, always
 * works). If empty, try the Tauri command and backfill localStorage.
 * On `finish`, we write BOTH: localStorage is the source of truth for
 * the next launch, the Tauri command makes the record survive
 * uninstall + auto-update.
 */

import { invoke } from '@tauri-apps/api/core';
import type { PersistedOnboarding } from '@/stores/onboarding';

const STORAGE_KEY = 'cinderpaw.onboarding';

// Detect Tauri at runtime. In pure browser dev (Vite without Tauri shell)
// the __TAURI_INTERNALS__ object is absent — we skip the command calls
// and rely on localStorage only.
function isTauriAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window
  );
}

export function readLocal(): PersistedOnboarding | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedOnboarding;
    if (parsed?.completed === true) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeLocal(record: PersistedOnboarding): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    // localStorage may be full or disabled (private mode). Not fatal on its
    // own — the Tauri command may still succeed — but the caller has to be
    // told, because if BOTH layers fail the wizard has just closed on a
    // record that does not exist anywhere.
    return false;
  }
}

async function readTauriCommand(): Promise<PersistedOnboarding | null> {
  if (!isTauriAvailable()) return null;
  try {
    const record = await invoke<{
      completed: boolean;
      completedAt: number;
      userName: string;
      agentName: string;
    } | null>('get_onboarding_record');
    if (record && record.completed) return record as PersistedOnboarding;
    return null;
  } catch (err) {
    // Tauri command failed (older app version, missing permission).
    // localStorage is the fallback.
    console.warn('[onboarding] tauri read failed:', err);
    return null;
  }
}

async function writeTauriCommand(record: PersistedOnboarding): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    await invoke('set_onboarding_record', {
      record: {
        completed: record.completed,
        completedAt: record.completedAt,
        userName: record.userName,
        agentName: record.agentName,
      },
    });
    return true;
  } catch (err) {
    console.warn('[onboarding] tauri write failed (localStorage still has it):', err);
    return false;
  }
}

export async function loadPersistedAsync(): Promise<PersistedOnboarding | null> {
  // 1. localStorage (sync, no I/O, always available in WebView).
  const local = readLocal();
  if (local) return local;

  // 2. Tauri command (async, survives uninstall + auto-updates).
  const tauri = await readTauriCommand();
  if (tauri) {
    // Backfill localStorage so the next launch is faster.
    writeLocal(tauri);
    return tauri;
  }
  return null;
}

/**
 * Write the record to both layers, and say whether ANY of them took it.
 *
 * This used to return `Promise<void>` and swallow both failures into
 * `console.warn`. The store called it as `void persistAsync(record)` after
 * having already set `hasOnboardedBefore: true`, so on a machine where neither
 * layer can write — a home the process cannot create in, a full disk, a webview
 * with storage disabled — the wizard closed as if it had worked, the name the
 * person chose was gone, and it reopened on the next launch. And the launch
 * after that. Forever, with no message on any of them, because the only trace
 * was a console line in devtools nobody has open.
 *
 * `false` means the record reached no durable storage at all. The caller is
 * expected to put that on screen rather than log it.
 */
export async function persistAsync(record: PersistedOnboarding): Promise<boolean> {
  // localStorage is the source of truth for the current session. Write
  // it synchronously so even a sync error can't lose the record.
  const local = writeLocal(record);
  // Tauri command is best-effort but critical for uninstall survival.
  const durable = await writeTauriCommand(record);
  return local || durable;
}
