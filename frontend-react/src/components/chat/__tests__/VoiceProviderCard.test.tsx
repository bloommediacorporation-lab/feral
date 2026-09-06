/**
 * The transcription picker must never confirm an option it did not show.
 *
 * The on-device row is hidden when the binary cannot transcribe — which is
 * every build we ship, because `whisper-rs` and `llama-cpp-sys` each vendor
 * their own ggml and cannot be linked together. Hiding the row was half a fix:
 * the selection underneath stayed `'local'`, the Confirm button's only guard
 * asked about the Groq key, and pressing it persisted a transcriber that cannot
 * run. The person saw one option, pressed the one button, and got the option
 * they were never shown.
 */

import { describe, expect, it } from 'vitest';
import { selectableSttProvider } from '../VoiceProviderCard';

describe('selectableSttProvider', () => {
  it('moves off on-device when this build cannot transcribe', () => {
    // The shipped case. Nothing stored yet, so the old code defaulted to
    // 'local' and hid the row that would have shown it.
    expect(selectableSttProvider(null, false)).toBe('groq');
  });

  it('moves a STORED on-device choice too, not just the default', () => {
    // A machine that used a build which had Whisper, updated to one that does
    // not. The stored value is now unrunnable and must not survive the open.
    expect(selectableSttProvider('local', false)).toBe('groq');
  });

  it('keeps on-device when the build has it', () => {
    expect(selectableSttProvider(null, true)).toBe('local');
    expect(selectableSttProvider('local', true)).toBe('local');
  });

  it('keeps on-device while the probe has not answered', () => {
    // `null` is "not known yet", and a slow probe must not push somebody off
    // the option where audio never leaves the machine.
    expect(selectableSttProvider(null, null)).toBe('local');
    expect(selectableSttProvider('local', null)).toBe('local');
  });

  it('never overrides an explicit cloud choice', () => {
    expect(selectableSttProvider('groq', true)).toBe('groq');
    expect(selectableSttProvider('groq', false)).toBe('groq');
    expect(selectableSttProvider('groq', null)).toBe('groq');
  });
});
