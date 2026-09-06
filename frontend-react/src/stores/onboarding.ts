/**
 * useOnboarding — first-run wizard state.
 *
 * The wizard is intentionally short: the user picks a name for themselves
 * and a name for their agent. Everything else (workspace, model choice,
 * tool permissions) is the agent's job to figure out — exposing it in
 * onboarding would overwhelm a first-time user.
 *
 * Persistence: on `finish()` or `skip()`, the state is written to
 * `~/.cinderpaw/onboarding.json` via the Tauri fs API. On next launch the
 * file is read and the wizard is hidden when `completed === true`.
 *
 * The user/agent names are also written there and consumed by the
 * agent-side system prompt (USER block — see CinderpawAgent/system-prompt
 * integration). The user can re-open the wizard from Settings to
 * rename themselves or the agent.
 *
 * Step model (audit M-R1 fix, 2026-07-07):
 *   The wizard's steps live in `STEP_IDS` below. `totalSteps` is
 *   derived from its length, so adding/removing/reordering a step
 *   updates the progress bar, the nav buttons, and the gate logic
 *   in one place. The previous design used a hand-managed
 *   `totalSteps: 5` constant which broke silently when a step was
 *   added or removed (`Math.min(s.step + 1, s.totalSteps - 1)`).
 *
 * Defer-vs-finish split (audit M-R2 fix, 2026-07-07):
 *   Footer links in the Provider step ("Browse other models",
 *   "More providers in Settings") used to call `finish()`, which
 *   persisted a `completed: true` record and closed the wizard
 *   forever. Any in-flight download or key test was silently
 *   abandoned. They now call `defer()`: the wizard hides, nothing
 *   is written to disk, and the wizard can re-open on next app
 *   launch (`loadPersisted()` finds no record and starts fresh).
 *   `finish()` remains the only path that writes `completed:true`.
 */

import { create } from 'zustand';

/**
 * Wizard steps in render order. The provider step currently branches
 * internally on `local` vs `cloud`; if we ever split that into two
 * distinct wizard steps, add them here — `totalSteps`, the progress
 * dots, and the next/prev bounds all derive from this list.
 */
const STEP_IDS = ['welcome', 'personalize', 'provider', 'showcase', 'done'] as const;
const TOTAL_STEPS: number = STEP_IDS.length;
const FIRST_STEP: number = 0;
const LAST_STEP: number = STEP_IDS.length - 1;

export interface OnboardingState {
  active: boolean;
  step: number;
  /** The user's chosen display name. Used by the agent to address them. */
  userName: string;
  /** The user's chosen name for the agent. Used by the agent for self-reference. */
  agentName: string;
  /** True if the user explicitly dismissed the wizard without completing. */
  skipped: boolean;
  /** Epoch ms when the wizard finished or was skipped. Null = still pending. */
  completedAt: number | null;
  /** True when the persisted record says "this user has already onboarded". */
  hasOnboardedBefore: boolean;
  /**
   * Set when neither storage layer accepted the completion record. The wizard
   * shows it rather than closing on a lie: without it the person's chosen name
   * vanishes and the wizard reopens on every launch with nothing explaining
   * why. Cleared whenever a write succeeds.
   */
  persistFailed: boolean;
  /** Total number of steps in the wizard (used by progress bar + next/prev).
   *  Derived from STEP_IDS.length — see audit M-R1 fix. */
  totalSteps: number;

  start: () => void;
  next: () => void;
  prev: () => void;
  setUserName: (name: string) => void;
  setAgentName: (name: string) => void;
  skip: () => void;
  finish: () => Promise<void>;
  /** Close the wizard without persisting a completion record (audit M-R2
   *  fix). Footer links in the Provider step use this so an in-flight
   *  download or key test is preserved across the navigation — the user
   *  can come back to it on next launch (no `completed: true` on disk
   *  means the wizard re-opens on its own). For the user to make the
   *  "done" state permanent, they must still hit "Open chat" on the
   *  Done step (which calls `finish()`). */
  defer: () => void;
  /** Programmatically re-open the wizard (e.g. from Settings → "Show welcome"). */
  reopen: () => void;
  /** Load the persisted record from disk and decide whether to show the wizard. */
  loadPersisted: () => Promise<boolean>;
}

const DEFAULTS = {
  userName: '',
  agentName: 'Cinderpaw',
  hasOnboardedBefore: false,
  persistFailed: false,
  skipped: false,
  completedAt: null,
  active: false,
  step: FIRST_STEP,
  totalSteps: TOTAL_STEPS,
} as const;

export const useOnboarding = create<OnboardingState>((set, get) => ({
  ...DEFAULTS,

  start: () => set({ active: true, step: FIRST_STEP, completedAt: null, skipped: false }),

  reopen: () => set({ active: true, step: FIRST_STEP }),

  // Audit M-R1 fix: derive next/prev bounds from STEP_IDS instead of the
  // hand-managed `totalSteps` constant. Adding a step means inserting a
  // string in STEP_IDS — every consumer (progress dots, nav buttons,
  // bounds) follows automatically.
  next: () =>
    set((s) => ({
      step: s.step >= LAST_STEP ? LAST_STEP : s.step + 1,
    })),

  prev: () =>
    set((s) => ({
      step: s.step <= FIRST_STEP ? FIRST_STEP : s.step - 1,
    })),

  setUserName: (name) => set({ userName: name.trim() }),
  // Note: we do NOT fall back to "Cinderpaw" on empty input here — the user
  // must be able to fully clear the field to retype. The "Cinderpaw" default
  // is applied at the use sites (Preview, DoneStep, agent prompt) via
  // `agentName.trim() || "Cinderpaw"`. Storing the raw value also means a
  // half-typed name ("F") doesn't get clobbered to "Cinderpaw".
  setAgentName: (name) => set({ agentName: name.trim() }),

  skip: () => {
    const completedAt = Date.now();
    set({
      active: false,
      skipped: true,
      completedAt,
      hasOnboardedBefore: true,
    });
    const s = get();
    void persistAsync({
      completed: true,
      completedAt,
      userName: s.userName,
      agentName: s.agentName || 'Cinderpaw',
    }).then((stored) => set({ persistFailed: !stored }));
  },

  // Audit M-R2 fix. The Provider step's footer links ("Browse other
  // models", "More providers in Settings") used to call `finish()`,
  // which persisted a `completed: true` record. That closed the wizard
  // forever and abandoned any in-flight download / key test. `defer()`
  // closes the wizard without writing anything — the user can resume
  // by re-opening from Settings (or the wizard will auto-show again on
  // next launch since no completion record exists).
  //
  // We intentionally do NOT set `hasOnboardedBefore: true` here. The
  // orchestrator at OnboardingOrchestrator.tsx checks
  // `hasOnboardedBefore && !active` to hide on subsequent visits; if we
  // flipped that flag, a deferred user would never see the wizard again
  // — defeating the point of "I'll come back to this later." The
  // `loadPersisted()` path remains the only thing that flips
  // `hasOnboardedBefore` to true, and it only does so when a record
  // with `completed: true` is found.
  defer: () => set({ active: false }),

  // (no helper functions below — the persistence layer lives in
  // onboardingPersistence.ts and is invoked through the actions above.)

  finish: async () => {
    const s = get();
    const record: PersistedOnboarding = {
      completed: true,
      completedAt: Date.now(),
      userName: s.userName,
      agentName: s.agentName || 'Cinderpaw',
    };
    // Update in-memory state FIRST so the UI closes the wizard immediately,
    // regardless of how long the disk write takes (or whether it succeeds).
    set({
      active: false,
      skipped: false,
      completedAt: record.completedAt,
      hasOnboardedBefore: true,
      persistFailed: false,
    });
    // Persist to BOTH localStorage (sync) and the Tauri command
    // (async, survives uninstall + auto-updates). The function is
    // idempotent — calling it twice writes the same record.
    //
    // The result is no longer discarded. Closing the wizard first is still
    // right — the UI must not wait on disk — but if neither layer took the
    // record we have to say so, or the person's name is gone and the wizard
    // simply reappears next launch with no explanation.
    void persistAsync(record).then((stored) => set({ persistFailed: !stored }));
  },

  loadPersisted: async () => {
    // Try the layered persistence: localStorage first (sync, no I/O,
    // always available), then the Tauri command (async, survives
    // uninstall + auto-updates because the record lives in ~/).
    const record = await loadPersistedAsync();
    if (record?.completed) {
      set({
        hasOnboardedBefore: true,
        persistFailed: false,
        userName: record.userName ?? '',
        agentName: record.agentName ?? 'Cinderpaw',
        completedAt: record.completedAt ?? null,
      });
      return true;
    }
    set({ hasOnboardedBefore: false });
    return false;
  },
}));

// ---------------------------------------------------------------------------
// Persistence — localStorage + Tauri command (see onboardingPersistence.ts)
// ---------------------------------------------------------------------------

import { loadPersistedAsync, persistAsync } from './onboardingPersistence';

export interface PersistedOnboarding {
  completed: boolean;
  completedAt: number;
  userName: string;
  agentName: string;
}

// (All persistence I/O lives in ./onboardingPersistence.ts. This file
// only declares the store actions.)
