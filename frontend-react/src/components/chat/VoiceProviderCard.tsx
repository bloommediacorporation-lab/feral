import { useEffect, useState } from 'react';
import { Mic, Cloud, Loader2, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ExternalLink } from './ExternalLink';
import { useUI, type SttProvider } from '@/stores/ui';
import { tauri } from '@/lib/tauri';
import { useNotifications } from '@/stores/notifications';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * First-mic-tap (and long-press) chooser for the speech-to-text backend:
 * local whisper (private, on-device) vs cloud Groq whisper-large-v3 (more
 * accurate, needs an API key, audio leaves the device). The Groq key reuses the
 * BYOK keychain, entered inline so non-technical users never leave the flow.
 */
/**
 * Which option is actually selectable, given what this build can do.
 *
 * The row for on-device transcription is hidden when the binary does not have
 * it — and on every build we ship it does not, because `whisper-rs` and
 * `llama-cpp-sys` each vendor their own ggml and cannot be linked together.
 * Hiding the row was the whole fix, and it was half of one: `choice` stayed
 * `'local'` underneath, the Confirm button had nothing to object to (its only
 * guard asks for the Groq key), and pressing it persisted a transcriber that
 * cannot run. The person saw one option, pressed the one button, and got the
 * option they were never shown.
 *
 * `null` means the probe has not answered yet, and it must not push anyone off
 * the private option on a slow machine.
 */
export function selectableSttProvider(
  stored: SttProvider | null,
  localAvailable: boolean | null,
): SttProvider {
  const wanted = stored ?? 'local';
  return wanted === 'local' && localAvailable === false ? 'groq' : wanted;
}

export function VoiceProviderCard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const sttProvider = useUI((s) => s.sttProvider);
  const setSttProvider = useUI((s) => s.setSttProvider);

  const [choice, setChoice] = useState<SttProvider>(sttProvider ?? 'local');
  // Whether the binary can transcribe here at all. `null` while unknown, so the
  // row is not flickered away and back on every open.
  const [localAvailable, setLocalAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void tauri.raw.sttLocalAvailable()
      .then((v) => { if (alive) setLocalAvailable(v); })
      // Unknown means show it: hiding the private option because a probe failed
      // would quietly push somebody to the cloud one.
      .catch(() => { if (alive) setLocalAvailable(true); });
    return () => { alive = false; };
  }, []);
  // The probe is async and the card can already be open when it answers, so the
  // selection has to move then too — otherwise the first open of a fresh
  // install keeps the hidden `local` choice that this whole function exists to
  // prevent.
  useEffect(() => {
    setChoice((c) => selectableSttProvider(c, localAvailable));
  }, [localAvailable]);
  const [groqKey, setGroqKey] = useState('');
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync the selected option + Groq key status each time the card opens.
  useEffect(() => {
    if (!open) return;
    setChoice(selectableSttProvider(sttProvider, localAvailable));
    setGroqKey('');
    tauri.raw
      .getByokSettings()
      .then((providers) => setHasGroqKey(providers.some((p) => p.id === 'groq' && p.has_api_key)))
      .catch(() => setHasGroqKey(false));
  }, [open, sttProvider, localAvailable]);

  // Cloud needs a key: either one already stored, or one typed in now.
  const needsKey = choice === 'groq' && !hasGroqKey && groqKey.trim().length === 0;
  // ...and an option this build cannot run is never confirmable, whatever the
  // key situation. Belt and braces with `selectableSttProvider`: that keeps the
  // selection honest, this keeps the BUTTON honest, and the two failed
  // independently before.
  const unavailable = choice === 'local' && localAvailable === false;

  const confirm = async () => {
    if (needsKey || unavailable) return;
    setSaving(true);
    try {
      if (choice === 'groq' && groqKey.trim()) {
        await tauri.raw.saveByokProvider('groq', true, groqKey.trim());
      }
      setSttProvider(choice);
      onOpenChange(false);
    } catch {
      useNotifications.getState().push('error', t('voice.keySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Default z-index: the call overlay sits at z-40, below this layer, so a
          dialog opened from inside a call is above it without a special case. */}
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto bg-bg-surface border-border-default">
        <DialogHeader>
          <DialogTitle>{t('voice.provider.title')}</DialogTitle>
          <DialogDescription>{t('voice.provider.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {/* Only when the binary actually has it. `whisper-rs` and
              `llama-cpp-sys` each vendor their own ggml and cannot be linked
              together, so every build we ship answers `voice-unavailable` here
              — and this row offered it anyway, which is a choice that can only
              fail. See the note on `default` in src-tauri/Cargo.toml. */}
          {localAvailable !== false && (
            <OptionRow
              active={choice === 'local'}
              onClick={() => setChoice('local')}
              icon={<Mic size={18} />}
              title={t('voice.provider.local.title')}
              desc={t('voice.provider.local.desc')}
            />
          )}
          <OptionRow
            active={choice === 'groq'}
            onClick={() => setChoice('groq')}
            icon={<Cloud size={18} />}
            title={t('voice.provider.cloud.title')}
            desc={t('voice.provider.cloud.desc')}
          />
        </div>

        {choice === 'groq' &&
          (hasGroqKey ? (
            <p className="text-xs text-text-muted px-1">{t('voice.provider.cloud.keySet')}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Input
                type="password"
                autoComplete="off"
                value={groqKey}
                onChange={(e) => setGroqKey(e.target.value)}
                placeholder={t('voice.provider.cloud.keyPlaceholder')}
              />
              <ExternalLink href="https://console.groq.com/keys" className="text-xs self-start">
                {t('voice.provider.cloud.getKey')}
              </ExternalLink>
            </div>
          ))}

        {/* No "language you speak" picker. Detection is the transcriber's job
            and it does it per request; a setting here only gave someone a way to
            be wrong about themselves, and a wrong value is an ORDER to Whisper,
            not a hint — it transcribes Romanian through English phonetics and
            never recovers. */}

        <DialogFooter>
          <Button onClick={() => void confirm()} disabled={needsKey || unavailable || saving}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : t('voice.provider.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionRow({
  active,
  onClick,
  icon,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-xl border p-3 text-left transition-colors',
        active ? 'border-brand bg-bg-hover' : 'border-border-default hover:bg-bg-hover',
      )}
    >
      <span className="mt-0.5 text-text-secondary">{icon}</span>
      <span className="flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
          {title}
          {active && <Check size={14} className="text-brand" />}
        </span>
        <span className="block text-xs text-text-muted mt-0.5">{desc}</span>
      </span>
    </button>
  );
}
