/**
 * A refused microphone has to be reported by the press that was refused.
 *
 * `start()` used to set React state and return nothing, and the caller read
 * `rec.error` on the line after `await rec.start()`. That is the value captured
 * by the render the click happened in, which the just-scheduled `setError` has
 * not touched — so the FIRST denial reported nothing at all: the button went
 * back to idle and the person was told nothing. A second press then reported
 * the first press's outcome.
 *
 * These tests assert on the returned value, which is what the caller now acts
 * on, and on the state, which is what renders.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';

const originalMediaDevices = navigator.mediaDevices;
const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true });
}

/** A MediaRecorder that constructs and does nothing, i.e. a working machine. */
class WorkingRecorder {
  mimeType = 'audio/webm';
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

beforeEach(() => {
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = WorkingRecorder;
});

afterEach(() => {
  setMediaDevices(originalMediaDevices);
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = originalMediaRecorder;
  vi.restoreAllMocks();
});

describe('useVoiceRecorder reports the failure to the press that caused it', () => {
  it('returns "denied" from the very first refused press', async () => {
    setMediaDevices({
      getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    const { result } = renderHook(() => useVoiceRecorder());

    let outcome: string | null = 'not-set';
    await act(async () => {
      outcome = await result.current.start();
    });

    // The whole bug: this used to be unobservable on the first attempt.
    expect(outcome).toBe('denied');
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('denied');
  });

  it('calls "unsupported" the failure that happens AFTER the microphone opened', async () => {
    // getUserMedia succeeds and the recorder cannot be constructed — WebView2
    // is picky about MIME types. Sending this person to their permission
    // settings would waste their time on something that is not wrong.
    const stop = vi.fn();
    setMediaDevices({
      getUserMedia: () =>
        Promise.resolve({ getAudioTracks: () => [], getTracks: () => [{ stop }] }),
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {
      constructor() {
        throw new Error('mime not supported');
      }
    };
    const { result } = renderHook(() => useVoiceRecorder());

    let outcome: string | null = 'not-set';
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome).toBe('unsupported');
    // And the microphone it opened is released, so the OS indicator goes out.
    expect(stop).toHaveBeenCalled();
  });

  it('returns "unsupported" when the browser has no recorder at all', async () => {
    setMediaDevices(undefined);
    const { result } = renderHook(() => useVoiceRecorder());

    let outcome: string | null = 'not-set';
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome).toBe('unsupported');
  });

  it('returns null when recording actually starts', async () => {
    setMediaDevices({
      getUserMedia: () =>
        Promise.resolve({ getAudioTracks: () => [], getTracks: () => [{ stop: vi.fn() }] }),
    });
    const { result } = renderHook(() => useVoiceRecorder());

    let outcome: string | null = 'not-set';
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(outcome).toBeNull();
    expect(result.current.state).toBe('recording');
  });
});
