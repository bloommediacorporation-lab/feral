/**
 * OnboardingWizard — first-run experience.
 *
 * 5 steps, each with a single clear purpose:
 *   1. Welcome          — greet the user, set expectations
 *   2. Personalize      — ask for the user's name + a name for the agent
 *   3. Provider         — "Choose your brain": local one-click model or BYOK
 *   4. Showcase         — 3 example capabilities (read-only cards)
 *   5. Done             — final CTA: open the chat
 *
 * Why so short: the user just opened the app. They don't want to fill in
 * 5 forms about workspace, model, permissions, etc. — that's the agent's
 * job to figure out. The only thing a first-time user can meaningfully
 * decide is: "what should I call this thing, and what should it call me?"
 *
 * Why these specific inputs:
 *   - userName: lets the agent address the user by name (personal touch)
 *   - agentName: lets the user feel ownership ("my assistant Bob")
 *   Both names are also injected into the agent's system prompt as a
 *   USER block so the model can use them naturally.
 *
 * Skippable. If the user dismisses, defaults are used and they can
 * re-open the wizard from Settings later.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowLeft, Sparkles, X, FileText, Search, Terminal, Cloud, HardDrive, Download, Check, ExternalLink, Loader2, ChevronRight, ShieldCheck, ShieldAlert, Shield, Eye, EyeOff } from 'lucide-react';
import { useOnboarding } from '@/stores/onboarding';
import { useSystemInfo } from '@/stores/systemInfo';
import { useDownload } from '@/stores/download';
import { useSettings } from '@/stores/settings';
import { useCatalog } from '@/stores/catalog';
import { useNotifications } from '@/stores/notifications';
import { recommendModel } from '@/lib/hardwareRecommendation';
import { tauri, type DiskEncryptionStatus, type SetupCandidate, type SetupVerifyOutcome } from '@/lib/tauri';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import { cn, SECONDARY_BUTTON } from '@/lib/utils';

const stepVariants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
};

export function OnboardingWizard() {
  const active = useOnboarding((s) => s.active);
  const step = useOnboarding((s) => s.step);
  const totalSteps = useOnboarding((s) => s.totalSteps);
  const prev = useOnboarding((s) => s.prev);
  const skip = useOnboarding((s) => s.skip);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-2xl mx-4 bg-bg-elevated border border-border-default rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Top bar: progress + skip */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <ProgressDots step={step} total={totalSteps} />
          <button
            type="button"
            onClick={skip}
            className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded transition-colors"
            aria-label="Skip onboarding"
          >
            <X size={14} className="inline -mt-0.5 mr-1" /> Skip
          </button>
        </header>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {step === 0 && <WelcomeStep />}
              {step === 1 && <PersonalizeStep />}
              {step === 2 && <ProviderStep />}
              {step === 3 && <ShowcaseStep />}
              {step === 4 && <DoneStep />}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Bottom bar: back / next */}
        <footer className="flex items-center justify-between px-6 py-4 border-t border-border-subtle">
          <button
            type="button"
            onClick={prev}
            disabled={step === 0}
            className="text-sm text-text-muted hover:text-text-primary px-3 py-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ArrowLeft size={14} className="inline -mt-0.5 mr-1" /> Back
          </button>
          <StepNavigation step={step} totalSteps={totalSteps} />
        </footer>
      </div>
    </div>
  );
}

function ProgressDots({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            i === step ? 'w-8 bg-brand' : i < step ? 'w-1.5 bg-brand/50' : 'w-1.5 bg-border-default',
          )}
        />
      ))}
    </div>
  );
}

function StepNavigation({ step, totalSteps }: { step: number; totalSteps: number }) {
  const navigate = useNavigate();
  const next = useOnboarding((s) => s.next);
  const finish = useOnboarding((s) => s.finish);
  const userName = useOnboarding((s) => s.userName);
  const isLast = step === totalSteps - 1;
  const isPersonalize = step === 1;
  const canProceed = !isPersonalize || userName.trim().length > 0;

  if (isLast) {
    return (
      <button
        type="button"
        // Navigate to /chat explicitly rather than relying on it being the
        // route behind the overlay — the provider step can leave the router
        // elsewhere (e.g. a deep-link to /models). Finish closes the wizard.
        onClick={() => { navigate('/chat'); void finish(); }}
        className="text-sm font-medium px-4 py-2 rounded-lg bg-brand text-on-brand hover:bg-brand/90 transition-colors"
      >
        Open chat <ArrowRight size={14} className="inline -mt-0.5 ml-1" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={next}
      disabled={!canProceed}
      className="text-sm font-medium px-4 py-2 rounded-lg bg-brand text-on-brand hover:bg-brand/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      Continue <ArrowRight size={14} className="inline -mt-0.5 ml-1" />
    </button>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="text-center space-y-6">
      {/* #25: the mascot that lives on the chat input greets the user here
          first — same pixel-art component, brand continuity from minute one. */}
      <motion.div
        initial={{ scale: 0.8, rotate: -10 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', duration: 0.5 }}
        className="flex justify-center [&_canvas]:w-24 [&_canvas]:h-24 [&_canvas]:[image-rendering:pixelated]"
        aria-hidden
      >
        <CinderpawMascot state="wave" />
      </motion.div>
      <h1 id="onboarding-title" className="text-3xl font-semibold text-text-primary">
        Welcome to Cinderpaw
      </h1>
      <p className="text-base text-text-muted max-w-md mx-auto leading-relaxed">
        A local AI agent that helps you with your files, projects, and tasks,
        without sending your data to the cloud.
      </p>
    </div>
  );
}

// ── Step 2: Personalize ─────────────────────────────────────────────────────

function PersonalizeStep() {
  const userName = useOnboarding((s) => s.userName);
  const setUserName = useOnboarding((s) => s.setUserName);
  const agentName = useOnboarding((s) => s.agentName);
  const setAgentName = useOnboarding((s) => s.setAgentName);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold text-text-primary mb-2">
          Let's get to know each other
        </h2>
        <p className="text-sm text-text-muted">
          The names you pick here are the ones I'll use when we talk.
        </p>
      </div>

      <div className="space-y-5">
        <Field
          label="What should I call you?"
          hint="I'll use this to address you in our conversation."
        >
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="e.g. Darius"
            autoFocus
            maxLength={40}
            className="w-full text-base px-3 py-2.5 rounded-lg border border-border-default bg-bg-primary text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
            aria-label="Your name"
          />
        </Field>

        <Field
          label="What should you call me?"
          hint={'You can leave "Cinderpaw" or pick something else.'}
        >
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Cinderpaw"
            maxLength={40}
            className="w-full text-base px-3 py-2.5 rounded-lg border border-border-default bg-bg-primary text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
            aria-label="Agent name"
          />
        </Field>
      </div>

      <Preview userName={userName} agentName={agentName} />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-text-primary block">{label}</span>
      {hint && <span className="text-xs text-text-muted block">{hint}</span>}
      {children}
    </label>
  );
}

function Preview({ userName, agentName }: { userName: string; agentName: string }) {
  const safeName = userName.trim() || 'you';
  const safeAgent = agentName.trim() || 'Cinderpaw';
  return (
    <div className="rounded-lg bg-bg-primary/50 border border-border-subtle p-4 text-sm space-y-2">
      <p className="text-text-muted text-xs uppercase tracking-wider font-medium">
        Preview
      </p>
      <p className="text-text-primary">
        <span className="text-text-muted">{safeName}:</span>{' '}
        Hi, I have a question.
      </p>
      <p className="text-text-primary">
        <span className="text-brand">{safeAgent}:</span>{' '}
        Sure, {safeName}! What can I help you with?
      </p>
    </div>
  );
}

// ── Step 4: Showcase ────────────────────────────────────────────────────────

function ShowcaseStep() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-text-primary mb-2">
          What I can do for you
        </h2>
        <p className="text-sm text-text-muted">
          A few examples. You don't have to remember anything, just talk to me normally.
        </p>
      </div>

      <div className="grid gap-3">
        <ShowcaseCard
          icon={<FileText size={20} />}
          title="Read and write files"
          example={'“Summarize README.md” or “Create a notes.md file with today\'s ideas”'}
        />
        <ShowcaseCard
          icon={<Search size={20} />}
          title="Search the web"
          example={'“Look up the best practices for Rust error handling”'}
        />
        <ShowcaseCard
          icon={<Terminal size={20} />}
          title="Run commands, tests, builds"
          example={'“Run the tests and show me what failed”'}
        />
      </div>
    </div>
  );
}

function ShowcaseCard({
  icon,
  title,
  example,
}: {
  icon: React.ReactNode;
  title: string;
  example: string;
}) {
  return (
    <div className="flex gap-3 p-3.5 rounded-lg border border-border-subtle bg-bg-primary/30 hover:bg-bg-primary/60 transition-colors">
      <div className="shrink-0 w-9 h-9 rounded-md bg-brand/10 text-brand flex items-center justify-center">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{example}</p>
      </div>
    </div>
  );
}

// ── Step 3: Provider — "Choose your brain" ──────────────────────────────────
// (render order: Welcome → Personalize → Provider → Showcase → Done)

// ponytail: pinned curated GGUFs per hardware tier (keys match
// recommendModel().sizeClass exactly — the key describes the hardware budget,
// the model it maps to can be any size). Calibration knob — re-verify these
// repos/files resolve on Hugging Face before each release; swap when a better
// small model ships. An unresolvable repo makes the one-click download fail.
// `approxSize` is the real Q4_K_M download size (shown on the button) — keep it
// in sync when swapping models. All 4 repos + exact Q4_K_M filenames verified
// live on HF 2026-07-10 (huggingface.co/api/models/<repo>/tree/main).
const TIER_MODELS: Record<string, { repoId: string; filename: string; label: string; approxSize: string }> = {
  '1–2B':   { repoId: 'bartowski/Qwen_Qwen3.5-2B-GGUF',  filename: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',  label: 'Qwen3.5 2B',  approxSize: '~1.5 GB' },
  '3–4B':   { repoId: 'bartowski/Qwen_Qwen3.5-4B-GGUF',  filename: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',  label: 'Qwen3.5 4B',  approxSize: '~2.5 GB' },
  '7–8B':   { repoId: 'bartowski/Qwen_Qwen3.5-9B-GGUF',  filename: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf',  label: 'Qwen3.5 9B',  approxSize: '~5.5 GB' },
  '13–14B': { repoId: 'bartowski/Qwen_Qwen3.5-27B-GGUF', filename: 'Qwen_Qwen3.5-27B-Q4_K_M.gguf', label: 'Qwen3.5 27B', approxSize: '~16.5 GB' },
};

// A short, friendly subset of ByokTab's PROVIDER_DEFS — the rest stay in
// Settings → Cloud Keys. `id` MUST match a PROVIDER_DEFS id so the saved key
// lines up. Gemini + OpenRouter have free tiers (zero-budget friendly).
const CURATED_PROVIDERS: {
  id: string;
  name: string;
  console: string;
  keyPlaceholder: string;
  free?: boolean;
  /** Cost/availability caveat shown under the steps — saves the user from a
   *  confusing "quota exceeded" on the paid providers. */
  note: string;
  steps: string[];
}[] = [
  {
    id: 'openai', name: 'OpenAI', console: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    note: 'New accounts get ~$5 free credit (no card, 3-month expiry); after that, add a prepaid balance under Billing. A ChatGPT Plus/Pro subscription does not cover API keys.',
    steps: [
      'Sign in at platform.openai.com',
      'Settings → API keys → "Create new secret key"',
      'Copy the key now (it\'s shown only once) and paste it below',
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', console: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
    note: 'Paid. Add ~$5 credit under Billing before the key will work.',
    steps: [
      'Sign in at console.anthropic.com',
      'Settings → API keys → "Create Key"',
      'Copy the key now (it\'s shown only once) and paste it below',
    ],
  },
  {
    id: 'google', name: 'Google Gemini', console: 'https://aistudio.google.com/apikey', free: true,
    keyPlaceholder: 'AIza...',
    note: 'Free tier, no credit card needed.',
    steps: [
      'Sign in at aistudio.google.com with any Google account',
      'Click "Get API key" → "Create API key"',
      'Copy the key and paste it below',
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter', console: 'https://openrouter.ai/keys', free: true,
    keyPlaceholder: 'sk-or-...',
    note: 'Free models available (look for ":free"), no credit card needed.',
    steps: [
      'Sign in at openrouter.ai (Google or email)',
      'Profile menu → Keys → "Create Key"',
      'Copy the key now (it\'s shown only once) and paste it below',
    ],
  },
];

export function ProviderStep() {
  const [choice, setChoice] = useState<'local' | 'cloud' | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-text-primary mb-2">Choose your brain</h2>
        <p className="text-sm text-text-muted">
          I need a model to think with. Run one privately on your machine, or plug in a cloud key.
          You can skip this and set it up later in Settings.
        </p>
      </div>

      <DetectedSection />

      <div className="grid grid-cols-2 gap-3">
        <ForkCard
          icon={<HardDrive size={18} />}
          title="Run locally"
          subtitle="Private · free · on your machine"
          selected={choice === 'local'}
          onClick={() => setChoice('local')}
        />
        <ForkCard
          icon={<Cloud size={18} />}
          title="Use a cloud key"
          subtitle="Instant · stronger · some free tiers"
          selected={choice === 'cloud'}
          onClick={() => setChoice('cloud')}
        />
      </div>

      {choice === 'local' && <LocalBranch />}
      {choice === 'cloud' && <CloudBranch />}
    </div>
  );
}

/**
 * Guided-setup rung (OpenClaw parity, 2026-07-10): before asking the user
 * to choose, show what the machine already has — an enabled provider, a
 * GGUF on disk, an env API key, a running Ollama, or an OpenClaw config —
 * and verify the pick with a REAL completion before calling it ready.
 * The detection + persistence logic lives in cinderpaw-core (`setup_detect` /
 * `setup_verify`), the same ladder `cinderpaw setup` uses.
 */
function DetectedSection() {
  const [candidates, setCandidates] = useState<SetupCandidate[] | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SetupVerifyOutcome>>({});

  useEffect(() => {
    tauri.raw
      .setupDetect()
      // The download rung is already the LocalBranch's one-click button —
      // listing it twice would duplicate the CTA.
      .then((c) => setCandidates(c.filter((x) => x.kind !== 'hardware_download')))
      .catch(() => setCandidates([]));
  }, []);

  if (!candidates?.length) return null;

  const useThis = async (c: SetupCandidate) => {
    setTestingId(c.id);
    try {
      const outcome = await tauri.raw.setupVerify(c, undefined, true);
      setResults((r) => ({ ...r, [c.id]: outcome }));
    } catch (e) {
      setResults((r) => ({
        ...r,
        [c.id]: { ok: false, status: 'unknown', message: String(e), persisted: false },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="rounded-lg border border-brand/30 bg-brand/5 p-4 space-y-2.5">
      <p className="text-xs font-medium text-brand flex items-center gap-1.5">
        <Sparkles size={13} /> Found on your machine
      </p>
      {candidates.map((c) => {
        const outcome = results[c.id];
        const isTesting = testingId === c.id;
        return (
          <div key={c.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-text-primary truncate">{c.label}</p>
              <p className="text-xs text-text-muted truncate">
                {outcome && !outcome.ok ? (
                  <span className="text-error">{outcome.message}</span>
                ) : (
                  c.detail
                )}
              </p>
            </div>
            {outcome?.ok ? (
              <span className="flex items-center gap-1.5 text-xs text-success shrink-0">
                <Check size={13} /> ready, I'll use it ({outcome.message})
              </span>
            ) : isTesting ? (
              <span className="flex items-center gap-1.5 text-xs text-text-muted shrink-0">
                <Loader2 size={12} className="animate-spin" /> Testing a real completion…
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void useThis(c)}
                disabled={testingId !== null}
                className="shrink-0 px-3 py-1.5 rounded-md bg-brand/15 text-brand text-xs font-medium hover:bg-brand/25 transition-colors disabled:opacity-50"
              >
                {outcome ? 'Retry' : 'Use this'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ForkCard({
  icon, title, subtitle, selected, onClick,
}: {
  icon: React.ReactNode; title: string; subtitle: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'text-left p-4 rounded-xl border transition-colors',
        selected
          ? 'border-brand bg-brand/10'
          : 'border-border-subtle bg-bg-primary/30 hover:bg-bg-primary/60',
      )}
    >
      <div className={cn('w-9 h-9 rounded-md flex items-center justify-center mb-2', selected ? 'bg-brand/20 text-brand' : 'bg-bg-hover text-text-secondary')}>
        {icon}
      </div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
    </button>
  );
}

function LocalBranch() {
  const navigate = useNavigate();
  const defer = useOnboarding((s) => s.defer);
  const sysInfo = useSystemInfo((s) => s.info);
  const fetchSysInfo = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetchSysInfo(); }, [fetchSysInfo]);

  const rec = recommendModel(sysInfo);
  // recommendModel().sizeClass keys map 1:1 to TIER_MODELS. Fall back to the
  // mid tier when detection isn't ready yet so the button is never dead.
  const model = (rec && TIER_MODELS[rec.sizeClass]) ?? TIER_MODELS['3–4B'];

  const active = useDownload((s) => s.active);
  const done = useDownload((s) => s.done);
  const error = useDownload((s) => s.error);
  const start = useDownload((s) => s.start);
  const isThisDownloading = active?.repoId === model.repoId;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary/40 p-4 space-y-3">
      {rec && <p className="text-sm text-text-secondary leading-relaxed">{rec.rationale}</p>}

      {done ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check size={16} /> {model.label} is ready, I'll use it automatically.
        </p>
      ) : isThisDownloading ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Downloading {model.label}…</span>
            <span>{Math.round((active?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
            <div className="h-full bg-brand transition-all" style={{ width: `${Math.round((active?.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void start(model.repoId, model.filename)}
          disabled={!!active}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          <Download size={15} /> Download {model.label} ({model.approxSize})
        </button>
      )}

      {error && <p className="text-xs text-error">Download failed: {error}</p>}

      {/*
        Audit M-R2 fix (2026-07-07): was `finish()` then `navigate()`, which
        persisted `completed: true` and closed the wizard forever. Calling
        `defer()` instead hides the wizard without persisting a completion
        record — the in-flight download keeps progressing under
        `useDownload` (a global store), and the wizard re-opens on next
        app launch since no completion record exists on disk.
      */}
      <button
        type="button"
        onClick={() => { defer(); navigate('/models'); }}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
      >
        Browse other models <ChevronRight size={12} />
      </button>
    </div>
  );
}

function CloudBranch() {
  const navigate = useNavigate();
  const defer = useOnboarding((s) => s.defer);
  const [selected, setSelected] = useState<string | null>(null);
  // Provider catalog comes from the shared useCatalog store (Phase 1
  // DoD). One fetch per app lifetime; other tabs (Phase 2 Connectors,
  // Settings → Cloud Keys) consume the same store without re-hitting
  // the gateway. The store carries `loaded=true, list=[]` on offline,
  // which is the same as the previous local useState behaviour so the
  // wizard degrades to its bundled CURATED_PROVIDERS gracefully.
  const catalogEntries = useCatalog((s) => s.providerCatalog);
  const catalogLoaded = useCatalog((s) => s.providerLoaded);
  const loadProvider = useCatalog((s) => s.loadProvider);

  useEffect(() => {
    void loadProvider();
  }, [loadProvider]);

  // Decision C: catalog overrides CURATED_PROVIDERS. Curated providers
  // whose id appears in the catalog keep their rich UX (steps, keyPlaceholder,
  // free tier badge). Catalog-only entries get a generic card with console_url.
  const curatedIds = new Set(CURATED_PROVIDERS.map((p) => p.id));
  const visibleCurated = catalogLoaded
    ? CURATED_PROVIDERS.filter((p) => catalogEntries.some((c) => c.id === p.id))
    : CURATED_PROVIDERS; // offline fallback: show all curated
  const genericOnly = catalogLoaded
    ? catalogEntries.filter((c) => !curatedIds.has(c.id))
    : [];

  const def = visibleCurated.find((p) => p.id === selected) ?? null;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary/40 p-4 space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {visibleCurated.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p.id)}
            className={cn(
              'flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors',
              selected === p.id ? 'border-brand bg-brand/10 text-text-primary' : 'border-border-subtle text-text-secondary hover:bg-bg-hover',
            )}
          >
            <span>{p.name}</span>
            {p.free && <span className="text-micro px-1.5 py-0.5 rounded-full bg-success/15 text-success shrink-0">free tier</span>}
          </button>
        ))}
        {genericOnly.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelected(c.id)}
            className={cn(
              'flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors',
              selected === c.id ? 'border-brand bg-brand/10 text-text-primary' : 'border-border-subtle text-text-secondary hover:bg-bg-hover',
            )}
          >
            <span>{c.name}</span>
            {c.free_tier_note && <span className="text-micro px-1.5 py-0.5 rounded-full bg-success/15 text-success shrink-0">free tier</span>}
          </button>
        ))}
      </div>

      {def && <CloudProviderForm def={def} />}

      {!def && selected && (() => {
        const generic = genericOnly.find((c) => c.id === selected);
        if (!generic) return null;
        return (
          <div className="space-y-2 pt-1">
            {generic.free_tier_note && <p className="text-xs text-success">{generic.free_tier_note}</p>}
            {generic.console_url && (
              <a
                href={generic.console_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
              >
                <ExternalLink size={12} /> Open {generic.name} console
              </a>
            )}
            <p className="text-xs text-text-muted">Add your API key in Settings → Cloud Keys after the wizard.</p>
          </div>
        );
      })()}

      <button
        type="button"
        onClick={() => { defer(); navigate('/settings'); }}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
      >
        More providers in Settings → Cloud Keys <ChevronRight size={12} />
      </button>
    </div>
  );
}

function CloudProviderForm({ def }: { def: typeof CURATED_PROVIDERS[number] }) {
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const testByokProvider = useSettings((s) => s.testByokProvider);
  const [apiKey, setApiKey] = useState('');
  // A pasted key is unreadable behind dots, so the one mistake this screen
  // cannot recover from — pasting the wrong thing, or half of it — is also
  // the one the user cannot see. Off by default; the reveal is theirs to ask
  // for.
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Trimmed at both call sites. Copying a key out of a browser or a password
  // manager routinely picks up trailing whitespace, and a key stored with a
  // newline in it goes onto the wire inside the Authorization header — which
  // the provider answers with a 401. The user then re-pastes the same correct
  // key, gets the same error, and nothing suggests whitespace is the problem.
  const handleTest = async () => {
    const key = apiKey.trim();
    if (!key) { setMsg({ ok: false, text: 'Paste the key first' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await testByokProvider({ providerId: def.id, apiKey: key, baseUrl: null });
      setMsg(r.ok ? { ok: true, text: '✓ Connected' } : { ok: false, text: r.error ?? 'Connection failed' });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally { setBusy(false); }
  };

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) { setMsg({ ok: false, text: 'Paste the key first' }); return; }
    setBusy(true); setMsg(null);
    try {
      await saveByokProvider({ providerId: def.id, enabled: true, apiKey: key, baseUrl: null, defaultModel: null });
      setMsg({ ok: true, text: `✓ ${def.name} saved` });
    } catch (e) {
      // Surface the Rust error verbatim — bare `catch {}` swallowed the real
      // reason (keychain locked, disk full, permission denied on
      // ~/.cinderpaw/byok.json). The wizard is often a user's first save attempt,
      // so a helpful reason here saves the whole session.
      const reason = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setMsg({ ok: false, text: `Save failed: ${reason}` });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 pt-1">
      <ol className="space-y-1.5 text-xs text-text-muted list-decimal list-inside">
        {def.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <p className={cn('text-xs', def.free ? 'text-success' : 'text-warning')}>{def.note}</p>
      <a
        href={def.console}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
      >
        <ExternalLink size={12} /> Open {def.name} console
      </a>

      <div className="relative">
        <input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={def.keyPlaceholder}
          className="w-full pl-3 pr-10 py-2 rounded-lg border border-border-default bg-bg-primary text-sm text-text-primary font-mono placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/50"
          aria-label={`${def.name} API key`}
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
          aria-label={showKey ? 'Hide the key' : 'Show the key'}
          aria-pressed={showKey}
        >
          {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={busy || !apiKey}
          className={SECONDARY_BUTTON}
        >
          Test
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !apiKey}
          className="px-3 py-1.5 rounded-md bg-brand text-on-brand text-sm font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          Save
        </button>
        {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-error')}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── Step 4: Done ────────────────────────────────────────────────────────────

function DoneStep() {
  const userName = useOnboarding((s) => s.userName);
  const agentName = useOnboarding((s) => s.agentName);
  const safeName = userName.trim() || 'you';
  const safeAgent = agentName.trim() || 'Cinderpaw';

  return (
    <div className="text-center space-y-6">
      <motion.div
        initial={{ scale: 0, rotate: -90 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', duration: 0.6, delay: 0.1 }}
        className="text-6xl"
        aria-hidden
      >
        🎉
      </motion.div>
      <h2 className="text-2xl font-semibold text-text-primary">
        You're all set, {safeName}!
      </h2>
      <p className="text-base text-text-muted max-w-md mx-auto leading-relaxed">
        I'm <span className="text-brand font-medium">{safeAgent}</span>, ready to go.
        Ask me anything and we'll see what I can do.
      </p>
      <DiskEncryptionNotice />

      <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
        <Sparkles size={12} />
        <span>You can change names anytime in Settings</span>
      </div>
    </div>
  );
}

/**
 * At-rest data protection notice (H-1). Cinderpaw keeps everything local, so the
 * confidentiality of conversations and memory on disk depends on the OS's
 * full-disk encryption. We surface the host's status here — reassurance when
 * it's on, a clear nudge when it isn't. Silent on any error (e.g. running
 * outside the desktop shell) so it never blocks finishing onboarding.
 */
function DiskEncryptionNotice() {
  const [status, setStatus] = useState<DiskEncryptionStatus | null>(null);
  useEffect(() => {
    void tauri.system
      .diskEncryption()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  if (!status) return null;

  const variant = {
    on: {
      Icon: ShieldCheck,
      accent: 'text-success',
      ring: 'border-success/30 bg-success/5',
      title: 'Your data is protected at rest',
      body: 'Disk encryption is on, so your conversations and memory are safe even if this device is lost.',
    },
    off: {
      Icon: ShieldAlert,
      accent: 'text-warning',
      ring: 'border-warning/30 bg-warning/5',
      title: 'Turn on disk encryption',
      body: 'Your data lives only on this device. Enable BitLocker (Windows) or FileVault (macOS) so it stays private if the device is lost or stolen.',
    },
    unknown: {
      Icon: Shield,
      accent: 'text-text-muted',
      ring: 'border-border-subtle bg-bg-primary/50',
      title: 'Check your disk encryption',
      body: 'We could not verify it automatically. Make sure BitLocker (Windows) or FileVault (macOS) is on to protect your data at rest.',
    },
  }[status.state];

  return (
    <div
      className={cn(
        'mx-auto max-w-md text-left rounded-lg border p-4 flex gap-3',
        variant.ring,
      )}
    >
      <variant.Icon size={18} className={cn('shrink-0 mt-0.5', variant.accent)} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">{variant.title}</p>
        <p className="text-xs text-text-muted leading-relaxed">{variant.body}</p>
      </div>
    </div>
  );
}

// ── Onboarding orchestrator (mounts the wizard) ─────────────────────────────

/**
 * Mount this once in the app shell. On mount it loads the persisted
 * record; if none exists (or `completed === false`), it shows the
 * wizard. The user can dismiss it with Skip or finish it to write
 * the record to disk.
 */
export function OnboardingOrchestrator() {
  const loadPersisted = useOnboarding((s) => s.loadPersisted);
  const start = useOnboarding((s) => s.start);
  const hasOnboardedBefore = useOnboarding((s) => s.hasOnboardedBefore);
  const active = useOnboarding((s) => s.active);
  const persistFailed = useOnboarding((s) => s.persistFailed);
  const [checked, setChecked] = useState(false);

  /*
    Neither storage layer took the record. Before this, that was two
    `console.warn` lines in devtools nobody has open: the wizard closed as if it
    had worked, the name the person chose was gone, and it reopened on the next
    launch, and the one after that, with nothing anywhere saying why. The
    condition is rare and the consequence is a loop the person cannot get out
    of, which is exactly the kind of thing that has to be on their screen.
  */
  useEffect(() => {
    if (!persistFailed) return;
    useNotifications.getState().push(
      'error',
      'Your setup could not be saved',
      'Cinderpaw could not write to its folder in your home directory, so it ' +
        'will ask you these questions again next time it starts. Check that ' +
        'the disk is not full and that Cinderpaw is allowed to write there.',
    );
  }, [persistFailed]);

  useEffect(() => {
    void (async () => {
      const alreadyDone = await loadPersisted();
      if (!alreadyDone) {
        // First run — show the wizard after a brief tick so the app shell
        // has time to paint underneath (avoids a white flash).
        setTimeout(() => start(), 300);
      }
      setChecked(true);
    })();
  }, [loadPersisted, start]);

  // Don't render the wizard until the persisted check is done — otherwise
  // a returning user briefly sees the wizard while loadPersisted is in flight.
  if (!checked) return null;
  // Hide for returning users UNLESS the wizard was explicitly reopened (e.g.
  // "Re-run welcome" button in Settings → General calls reopen()).
  if (hasOnboardedBefore && !active) return null;

  return <OnboardingWizard />;
}
