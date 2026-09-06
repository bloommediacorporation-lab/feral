import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { AgentOfflineBanner } from '../AgentOfflineBanner';

beforeEach(() => {
  vi.useFakeTimers();
  useCinderpawStore.setState({ isReady: false, offline: false, restarting: false, offlineReason: null });
});

afterEach(() => vi.useRealTimers());

describe('AgentOfflineBanner startup grace', () => {
  it('stays quiet during normal startup and warns only after the grace period', () => {
    render(<AgentOfflineBanner />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(14_999));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    // "Cinderpaw is waking up", not "Cinderpaw Agent": the UX contract bans `agent` from
    // the primary interface, and the person waiting does not have two things.
    expect(screen.getByRole('status')).toHaveTextContent('Cinderpaw is waking up');
  });

  it('never flashes the startup warning when ready arrives inside the grace period', () => {
    render(<AgentOfflineBanner />);

    act(() => useCinderpawStore.getState().setReady(true));
    act(() => vi.advanceTimersByTime(15_000));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('AgentOfflineBanner gave-up state', () => {
  it('shows the reason Rust sent instead of guessing the cause', () => {
    render(<AgentOfflineBanner />);
    act(() =>
      useCinderpawStore
        .getState()
        .setOffline(true, false, 'Antivirus quarantined the program. Reinstall Cinderpaw.'),
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Antivirus quarantined the program.');
    // The old hardcoded cause said this for every failure, including the one
    // where the process never started at all.
    expect(alert).not.toHaveTextContent('repeated crashes');
  });

  it('falls back to the generic sentence when an older host sends no reason', () => {
    render(<AgentOfflineBanner />);
    act(() => useCinderpawStore.getState().setOffline(true, false));

    expect(screen.getByRole('alert')).toHaveTextContent('automatic restarts were suspended');
  });

  it('coming back online clears the reason with the banner', () => {
    render(<AgentOfflineBanner />);
    act(() => useCinderpawStore.getState().setOffline(true, false, 'something specific'));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => useCinderpawStore.getState().setReady(true));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useCinderpawStore.getState().offlineReason).toBeNull();
  });
});
