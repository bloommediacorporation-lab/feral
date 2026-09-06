import { create } from 'zustand';
import type { CinderpawModelConfigView, CinderpawModelSelection } from '@/lib/tauri';
import { tauri } from '@/lib/tauri';

interface CinderpawStore {
  /** Active model in the sidecar. Null until cinderpaw_get_model_config resolves. */
  modelConfig: CinderpawModelConfigView | null;
  /** True once cinderpaw://agent-ready fires. */
  isReady: boolean;
  /** Last set_model error, if any. Cleared on next setModel call. */
  modelError: string | null;
  /** Whether a setModel call is in flight. */
  switching: boolean;
  /**
   * #11: true after `cinderpaw://agent-exit` (sidecar crashed), false again when
   * `cinderpaw://agent-ready` fires post-restart. Drives the offline banner.
   */
  offline: boolean;
  /** True while the Rust supervisor is attempting an automatic restart. */
  restarting: boolean;
  /**
   * Why Agent mode stopped, in the words Rust used. Only set when the
   * supervisor gave up (`restarting: false`), because that is the only case
   * where the person has to do something. Null the rest of the time.
   */
  offlineReason: string | null;

  setModelConfig(cfg: CinderpawModelConfigView): void;
  setReady(v: boolean): void;
  setModelError(err: string | null): void;
  setOffline(offline: boolean, restarting: boolean, reason?: string | null): void;

  /** Fetch and cache the current sidecar model config (display-safe, no key). */
  fetchModelConfig(): Promise<void>;

  /**
   * Hot-swap the Cinderpaw Agent model. Rust injects the API key from BYOK store —
   * the key never touches React. Throws on error so callers can surface it.
   */
  setModel(selection: CinderpawModelSelection): Promise<void>;
}

export const useCinderpawStore = create<CinderpawStore>((set) => ({
  modelConfig: null,
  isReady: false,
  modelError: null,
  switching: false,
  offline: false,
  restarting: false,
  offlineReason: null,

  setModelConfig(cfg) {
    set({ modelConfig: cfg, modelError: null });
  },

  setReady(v) {
    // Coming (back) online clears the offline banner.
    set(v ? { isReady: true, offline: false, restarting: false, offlineReason: null } : { isReady: false });
  },

  setOffline(offline, restarting, reason = null) {
    set({ offline, restarting, offlineReason: reason, ...(offline ? { isReady: false } : {}) });
  },

  setModelError(err) {
    set({ modelError: err });
  },

  async fetchModelConfig() {
    try {
      const cfg = await tauri.raw.cinderpawGetModelConfig();
      if (cfg) set({ modelConfig: cfg });
    } catch {
      // Sidecar not yet ready — will retry when agent-ready fires.
    }
  },

  async setModel(selection) {
    set({ modelError: null, switching: true });
    try {
      if (selection.source === 'ollama') {
        await tauri.raw.cinderpawSetModel('ollama', selection.model, null, selection.baseUrl);
      } else if (selection.source === 'byok') {
        await tauri.raw.cinderpawSetModel('byok', selection.model, selection.providerId, null);
      } else {
        await tauri.raw.cinderpawSetModel(
          'openai_compatible',
          selection.model,
          selection.providerId,
          selection.baseUrl,
        );
      }
      // Store is updated optimistically by Rust; model_set event from sidecar confirms.
      const cfg = await tauri.raw.cinderpawGetModelConfig();
      if (cfg) set({ modelConfig: cfg });
    } catch (err) {
      set({ modelError: String(err) });
      throw err;
    } finally {
      set({ switching: false });
    }
  },
}));
