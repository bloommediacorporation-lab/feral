import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useOnboarding } from '@/stores/onboarding';
import { persistAsync } from '@/stores/onboardingPersistence';

const reset = () =>
  useOnboarding.setState({
    active: false,
    step: 0,
    userName: '',
    agentName: 'Cinderpaw',
    skipped: false,
    completedAt: null,
    hasOnboardedBefore: false,
    persistFailed: false,
  });

describe('useOnboarding', () => {
  beforeEach(reset);

  it('starts inactive with empty user / default agent name', () => {
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    expect(s.step).toBe(0);
    expect(s.userName).toBe('');
    expect(s.agentName).toBe('Cinderpaw');
  });

  it('start() activates the wizard at step 0', () => {
    useOnboarding.getState().start();
    expect(useOnboarding.getState().active).toBe(true);
    expect(useOnboarding.getState().step).toBe(0);
  });

  it('next() / prev() walk through the steps', () => {
    useOnboarding.getState().start();
    useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(1);
    useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(2);
    useOnboarding.getState().prev();
    expect(useOnboarding.getState().step).toBe(1);
  });

  it('next() clamps to totalSteps - 1', () => {
    useOnboarding.getState().start();
    for (let i = 0; i < 99; i++) useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(useOnboarding.getState().totalSteps - 1);
  });

  it('totalSteps is derived from the wizard step list (M-R1 fix)', () => {
    // Audit M-R1 fix (2026-07-07): `totalSteps` was a hand-managed
    // constant (`5`) that broke silently when a step was added. It's
    // now derived from STEP_IDS.length — pin the contract that adding
    // a step means inserting one entry in the list.
    expect(useOnboarding.getState().totalSteps).toBe(5);
    expect(useOnboarding.getState().totalSteps).toBeGreaterThan(0);
    // The last reachable step index is totalSteps - 1 — pins the
    // boundary any `next()` caller can reach.
    useOnboarding.getState().start();
    for (let i = 0; i < 99; i++) useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(4);
    expect(useOnboarding.getState().step).toBe(useOnboarding.getState().totalSteps - 1);
  });

  it('prev() clamps to 0', () => {
    useOnboarding.getState().start();
    useOnboarding.getState().prev();
    expect(useOnboarding.getState().step).toBe(0);
  });

  it('setUserName trims whitespace', () => {
    useOnboarding.getState().setUserName('  Darius  ');
    expect(useOnboarding.getState().userName).toBe('Darius');
  });

  it('setAgentName trims whitespace and allows empty input', () => {
    useOnboarding.getState().setAgentName('  Bob  ');
    expect(useOnboarding.getState().agentName).toBe('Bob');
    // Empty input is allowed — the user must be able to fully clear the
    // field to retype. The "Cinderpaw" default is applied at use sites, not here.
    useOnboarding.getState().setAgentName('');
    expect(useOnboarding.getState().agentName).toBe('');
    useOnboarding.getState().setAgentName('   ');
    expect(useOnboarding.getState().agentName).toBe('');
  });

  it('setAgentName does not snap partial input back to "Cinderpaw"', () => {
    // Regression: a half-typed name like "F" used to be replaced by
    // "Cinderpaw" because the old implementation fell back on falsy.
    useOnboarding.getState().setAgentName('F');
    expect(useOnboarding.getState().agentName).toBe('F');
  });

  it('skip() deactivates and records the dismissal', () => {
    useOnboarding.getState().start();
    useOnboarding.getState().skip();
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    expect(s.skipped).toBe(true);
    expect(s.hasOnboardedBefore).toBe(true);
    expect(s.completedAt).toBeGreaterThan(0);
  });

  it('finish() deactivates and records completion (without persisting on test env)', async () => {
    useOnboarding.getState().setUserName('Darius');
    useOnboarding.getState().setAgentName('Bob');
    useOnboarding.getState().start();
    await useOnboarding.getState().finish();
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    expect(s.skipped).toBe(false);
    expect(s.hasOnboardedBefore).toBe(true);
    expect(s.userName).toBe('Darius');
    expect(s.agentName).toBe('Bob');
  });

  it('reopen() reactivates the wizard from step 0', () => {
    useOnboarding.getState().setUserName('X');
    useOnboarding.getState().reopen();
    expect(useOnboarding.getState().active).toBe(true);
    expect(useOnboarding.getState().step).toBe(0);
    // userName is preserved across reopen
    expect(useOnboarding.getState().userName).toBe('X');
  });

  it('defer() hides the wizard without marking it completed (M-R2 fix)', () => {
    // Audit M-R2 fix (2026-07-07): the Provider step's footer links
    // ("Browse other models", "More providers in Settings") used to
    // call `finish()`, which persisted `completed: true` and closed the
    // wizard forever — abandoning any in-flight download / key test.
    // They now call `defer()`, which hides the overlay with NO side
    // effects on persistence or `hasOnboardedBefore`, so the wizard
    // can re-open on next launch (and the user can pick up where they
    // left off).
    useOnboarding.getState().start();
    useOnboarding.getState().setUserName('Halfway');
    useOnboarding.getState().defer();
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    // M-R2 contract: the defer path must NOT look like "the user
    // finished onboarding" to loadPersisted(). Otherwise the wizard
    // would never re-open after a defer.
    expect(s.hasOnboardedBefore).toBe(false);
    expect(s.completedAt).toBeNull();
    expect(s.skipped).toBe(false);
    // Names typed so far are preserved — the next launch starts the
    // wizard fresh from step 0 but the typed name doesn't vanish.
    expect(s.userName).toBe('Halfway');
  });

  it('defer() does not advance `step` — closing the overlay is not progress', () => {
    // Catches a regression where defer ended up calling `next()` as a
    // side effect. The wizard should stay at whatever step the user
    // had reached so a future `start()` (or auto re-mount) reopens
    // them at the same place.
    useOnboarding.getState().start();
    useOnboarding.getState().next(); // step 1
    useOnboarding.getState().next(); // step 2
    const before = useOnboarding.getState().step;
    useOnboarding.getState().defer();
    expect(useOnboarding.getState().step).toBe(before);
  });

  it('start() after defer() keeps the user-typed name', () => {
    // The defer path is followed by the user navigating to /models
    // or /settings. When they come back to the wizard later (either
    // manually via Settings, or automatically because no completion
    // record exists on disk), the half-typed name must not vanish.
    useOnboarding.getState().start();
    useOnboarding.getState().setUserName('Darius');
    useOnboarding.getState().defer();
    // Simulate next session: start() again resets step/active but
    // names are app-wide (kept on the store, reloaded via loadPersisted
    // on real boot).
    useOnboarding.getState().start();
    expect(useOnboarding.getState().active).toBe(true);
    expect(useOnboarding.getState().step).toBe(0);
    expect(useOnboarding.getState().userName).toBe('Darius');
  });
});

describe('a completion that reached no storage is not treated as saved', () => {
  /** A webview with storage disabled or full: `setItem` throws. */
  function withBrokenLocalStorage<T>(fn: () => T): T {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      value: {
        setItem: () => {
          throw new Error('storage disabled');
        },
        getItem: () => null,
      },
      configurable: true,
    });
    try {
      return fn();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  }

  it('reports failure when neither layer accepts the record', async () => {
    // No Tauri shell in this environment, so the command layer refuses too:
    // both layers down is exactly the case that used to close the wizard on a
    // record that did not exist anywhere.
    const ok = await withBrokenLocalStorage(() =>
      persistAsync({ completed: true, completedAt: 1, userName: 'd', agentName: 'Cinderpaw' }),
    );
    expect(ok).toBe(false);
  });

  it('reports success when localStorage takes it, even with no Tauri shell', async () => {
    const ok = await persistAsync({
      completed: true,
      completedAt: 1,
      userName: 'd',
      agentName: 'Cinderpaw',
    });
    expect(ok).toBe(true);
  });

  it('finish() closes the wizard immediately and still flags the failure', async () => {
    await withBrokenLocalStorage(async () => {
      useOnboarding.setState({ userName: 'Darius', agentName: 'Cinderpaw', persistFailed: false });
      await useOnboarding.getState().finish();
      // The wizard must not wait on disk, so it closes either way.
      expect(useOnboarding.getState().active).toBe(false);
      // ...but the failure is recorded instead of swallowed into console.warn,
      // which is what let the person's name vanish and the wizard reappear on
      // every launch with nothing explaining why.
      await vi.waitFor(() => expect(useOnboarding.getState().persistFailed).toBe(true));
    });
  });

  it('a successful finish leaves the flag clear', async () => {
    useOnboarding.setState({ userName: 'Darius', persistFailed: true });
    await useOnboarding.getState().finish();
    await vi.waitFor(() => expect(useOnboarding.getState().persistFailed).toBe(false));
  });
});
