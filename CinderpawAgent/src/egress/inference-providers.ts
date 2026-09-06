/**
 * Inference providers — pluggable LLM backends for InferenceRouter.
 *
 * Each provider implements InferenceProvider, which has a single method:
 *   complete(target, req, isFallback) → InferenceResponse
 *
 * The router is the orchestrator (budget, audit, fallback, abort).
 * Providers are pure transport — they know nothing about budget or sessions.
 *
 * Adding a new provider:
 *   1. Implement InferenceProvider.
 *   2. Export the class from this file.
 *   3. Add a branch in InferenceRouter.#callTarget (or pass it via providerMap).
 */

import { countTokens } from "../core/tokenizer.ts";
import type {
  ChatMessage,
  InferenceRequest,
  InferenceResponse,
  ModelTarget,
  StreamProgressEvent,
} from "../types.ts";
import { resolvePerfPolicy, type PerfPolicy } from "./perf-policy.ts";
import { cfgInt, readEnv } from "../config.ts";
import { log } from "../runtime-meta.ts";

// Defined here (not imported from inference-router) to avoid a circular dep.
// inference-router re-exports its own InferenceError class; both throw the
// same shape but are separate class instances. Callers catch by name or message.
class InferenceError extends Error {
  /**
   * HTTP status when the failure came from the endpoint. The router reads this
   * to recognise a 429 and retry after the provider's Retry-After, rather than
   * scraping the status back out of the message string.
   */
  readonly status?: number;
  readonly retryAfter?: string | null;

  constructor(message: string, status?: number, retryAfter?: string | null) {
    super(message);
    this.name = "InferenceError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Idle-stream timeout for cloud (non-loopback) targets. Local engines can be
// slow on first-token (cold KV-cache load); cloud APIs should respond in seconds.
// ponytail: fixed env read at module load; set CINDERPAW_CLOUD_IDLE_TIMEOUT_MS to override.
// Kept for back-compat with the old idleAbortController — the new
// `deadlineController` honors it via the resolver's
// `CINDERPAW_CLOUD_IDLE_TIMEOUT_MS` env override (see perf-policy.ts).
const _cit = cfgInt("CINDERPAW_CLOUD_IDLE_TIMEOUT_MS");
const CLOUD_IDLE_MS: number = _cit > 0 ? _cit : 60_000;

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A single pluggable LLM backend. Receives a fully-resolved target and an
 * already-wired InferenceRequest (signal chained, budgets already checked).
 * Must never throw BudgetExhaustedError — that belongs in the router.
 */
export interface InferenceProvider {
  complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse>;
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

export class OllamaProvider implements InferenceProvider {
  async complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const url = `${trimSlash(target.baseUrl)}/api/chat`;
    return req.onToken
      ? this.#stream(url, target, req, isFallback)
      : this.#nonStream(url, target, req, isFallback);
  }

  async #nonStream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    // P5 fix: `num_ctx` is the model's context window (KV cache size), not
    // the per-completion output cap. Tying it to `req.maxTokens` silently
    // forced a 16,384-token context window on every Ollama call when the
    // main loop's maxTokensPerCall was raised. Read it from a dedicated
    // env var with a sensible default instead. Operators can override with
    // CINDERPAW_OLLAMA_NUM_CTX to match the model card.
    const numCtx = readOllamaNumCtx();
    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOllamaMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        num_ctx: numCtx,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
      ...(req.cachePrompt !== undefined ? { cache_prompt: req.cachePrompt } : {}),
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
    }

    const raw = await postJson(url, body, undefined, req.signal, resolvePerfPolicy({ isCloud: !isLoopbackTarget(target) }).totalDeadlineMs);
    let content: string =
      (raw as { message?: { content?: string } }).message?.content ?? "";

    // Reasoning models on local Ollama (qwen3, deepseek-r1, MiniMax-M3 thinking,
    // …) return chain-of-thought in a separate `thinking` field via Ollama's
    // `/api/chat` response when the model is in thinking mode. Without folding
    // it back in, a turn whose visible answer is empty (all budget spent
    // reasoning) looks like a fully empty response, and the TUI has no way to
    // separate reasoning from answer — there are no `<think` markers in the
    // visible content for the live thinking-splitter to find. Wrap in
    // `<think>...</think>` tags the same way the cloud path does (and local
    // thinking models emit), so stripThinking() and the live thinking-splitter
    // handle it unchanged.
    const reasoning =
      (raw as { message?: { thinking?: string } }).message?.thinking ?? "";
    if (reasoning) {
      content = `<think>${reasoning}</think>${content}`;
    }

    const toolCalls = (raw as { message?: { tool_calls?: any[] } }).message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      // Re-encode EVERY tool call (previously only [0], dropping parallel calls).
      content = trimDanglingToolCallTag(content);
      for (const call of toolCalls) {
        const fn = call?.function;
        if (!fn?.name) continue;
        content += encodeToolCall(fn.name, fn.arguments);
      }
    }

    const reportedPrompt = (raw as { prompt_eval_count?: number }).prompt_eval_count;
    const reportedCompletion = (raw as { eval_count?: number }).eval_count;
    const promptTokens = reportedPrompt ?? estimateTokens(req.messages);
    const completionTokens = reportedCompletion ?? estimateText(content);
    const doneReason = (raw as { done_reason?: string }).done_reason;

    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: target.model,
      usedFallback: isFallback,
      // The receipt for the pin. A fallback inside the declared order is fine
      // and expected; a run that cannot say which endpoint served it cannot
      // say what it measured.
      ...(typeof (raw as { provider?: unknown }).provider === "string"
        ? { servedBy: (raw as { provider: string }).provider }
        : {}),
      // Ours, not theirs — see InferenceResponse.tokensEstimated. EITHER half
      // being locally derived taints the row: a provider that reports its
      // prompt but not its output still leaves a number here that it never
      // said, and an unflagged estimate is exactly what this is for.
      ...(reportedPrompt === undefined || reportedCompletion === undefined
        ? { tokensEstimated: true }
        : {}),
      ...(doneReason ? { finishReason: doneReason } : {}),
    };
  }

  async #stream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    // P5 fix: see #nonStream — `num_ctx` must come from its own setting,
    // never from the per-completion output cap.
    const numCtx = readOllamaNumCtx();
    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOllamaMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      stream: true,
      options: {
        temperature: req.temperature ?? 0.7,
        num_ctx: numCtx,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
      ...(req.cachePrompt !== undefined ? { cache_prompt: req.cachePrompt } : {}),
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
    }

    const isCloud = !isLoopbackTarget(target);
    // TTFT scaling needs the prompt size, and this call used to omit it — so
    // `resolvePerfPolicy` fell back to the unscaled base on EVERY streamed
    // request and the whole scaling mechanism was dead code. The old comment
    // here said the count "isn't known until the first NDJSON chunk arrives",
    // so scaling "kicks in on the second chunk onward" — but TTFT is the
    // deadline for the FIRST token. A budget that only widens after the token
    // it was guarding for has already arrived never guards anything: a big
    // agent prompt got the flat 30 s cloud floor, which is what killed long
    // completions with "Inference unavailable" and no explanation on screen.
    //
    // The provider's own count is authoritative but arrives too late to be
    // useful here, so estimate from the messages we are about to send — the
    // same `estimateTokens` this file already falls back to when a provider
    // reports no usage. An estimate that is roughly right before the request
    // beats an exact number that arrives after the timer has fired.
    const policy = resolvePerfPolicy({ isCloud, promptTokens: estimateTokens(req.messages) });
    const dc = deadlineController({
      policy,
      externalSignal: req.signal,
      onProgress: req.onProgress,
      sessionId: req.sessionId,
    });
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    // Explicit presence, not truthiness: a provider that legitimately reports 0
    // completion tokens (an empty answer) must not be recorded as one that
    // reported nothing.
    let reportedPrompt: number | undefined;
    let reportedCompletion: number | undefined;

    const ollamaToolCallsAccumulator: {
      name?: string;
      argumentsString: string;
      argumentsObject?: Record<string, any>;
    }[] = [];
    let ollamaFinishReason: string | undefined;

    // Reasoning models on local Ollama (qwen3, deepseek-r1, MiniMax-M3
    // thinking, …) stream chain-of-thought as `message.thinking`, separate
    // from `message.content`. Mirror the cloud path: track whether a
    // <think> tag is open, emit the opener on first thinking chunk, the
    // closer when content arrives (or at stream end for all-reasoning
    // turns). Without this, the TUI has no `<think>` markers to split on
    // and shows raw reasoning as answer text.
    //
    // The opener/closer are the literal six/nine-character tokens used
    // throughout the codebase (`stripThinking`, `agent-loop.ts`,
    // `frontend-react/src/components/chat/splitter`) for reasoning
    // blocks. local Ollama reasoning-capable models (qwen3, deepseek-r1,
    // MiniMax-M3 thinking, …) all stream the model that hides CoT in a
    // separate `thinking` field. When the model doesn't run in
    // thinking mode for a given prompt, `message.thinking` is absent
    // and these helpers no-op — non-thinking prompts stream
    // unchanged.
    let inReasoning = false;
    const emitPiece = (piece: string): void => {
      content += piece;
      req.onToken!(piece);
    };
    const closeReasoning = (): void => {
      if (inReasoning) {
        inReasoning = false;
        emitPiece("</think>");
      }
    };

    try {
      const res = await fetchStream(url, body, {}, dc.signal);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let chunk: unknown;
        try { chunk = JSON.parse(trimmed); } catch { return; }

        const thinkingTok =
          (chunk as { message?: { thinking?: string } }).message?.thinking ?? "";
        if (thinkingTok) {
          if (!inReasoning) {
            inReasoning = true;
            emitPiece("<think>");
          }
          emitPiece(thinkingTok);
        }

        const token = (chunk as { message?: { content?: string } }).message?.content ?? "";
        if (token) {
          closeReasoning();
          emitPiece(token);
        }

        const toolCalls = (chunk as { message?: { tool_calls?: any[] } }).message?.tool_calls;
        if (toolCalls) {
          for (let idx = 0; idx < toolCalls.length; idx++) {
            const tc = toolCalls[idx];
            const acc = (ollamaToolCallsAccumulator[idx] ??= { argumentsString: "" });
            if (tc.function?.name) {
              acc.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              if (typeof tc.function.arguments === "string") {
                acc.argumentsString += tc.function.arguments;
              } else if (typeof tc.function.arguments === "object") {
                acc.argumentsObject = {
                  ...acc.argumentsObject,
                  ...tc.function.arguments
                };
              }
            }
          }
        }

        if ((chunk as { done?: boolean }).done === true) {
          reportedPrompt = (chunk as { prompt_eval_count?: number }).prompt_eval_count;
          reportedCompletion = (chunk as { eval_count?: number }).eval_count;
          promptTokens = reportedPrompt ?? estimateTokens(req.messages);
          completionTokens = reportedCompletion ?? estimateText(content);
          const doneReason = (chunk as { done_reason?: string }).done_reason;
          if (doneReason) ollamaFinishReason = doneReason;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        dc.resetIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);

      // A turn can end while still inside reasoning (all-reasoning turn, or
      // reasoning followed directly by a tool call) — close the tag so the
      // <think> block is well-formed for stripThinking()/the frontend's live
      // thinking-splitter.
      closeReasoning();

      // Re-encode EVERY accumulated tool call (previously only [0], dropping
      // parallel calls). Appended to `content` only, NOT emitted via onToken —
      // chunk events reach the chat UI verbatim and the raw tag leaked into
      // the visible answer after prose. parseResponse reads it from content.
      const completedCalls = ollamaToolCallsAccumulator.filter((tc) => tc?.name);
      if (completedCalls.length > 0) {
        content = trimDanglingToolCallTag(content);
        for (const tc of completedCalls) {
          content += encodeToolCall(
            tc.name!,
            tc.argumentsObject ?? tc.argumentsString,
          );
        }
      }
    } finally {
      dc.cleanup();
    }

    if (reportedPrompt === undefined) promptTokens = estimateTokens(req.messages);
    if (reportedCompletion === undefined) completionTokens = estimateText(content);
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: target.model,
      usedFallback: isFallback,
      // Ours, not theirs — see InferenceResponse.tokensEstimated. EITHER half
      // being locally derived taints the row: a provider that reports its
      // prompt but not its output still leaves a number here that it never
      // said, and an unflagged estimate is exactly what this is for.
      ...(reportedPrompt === undefined || reportedCompletion === undefined
        ? { tokensEstimated: true }
        : {}),
      ...(ollamaFinishReason ? { finishReason: ollamaFinishReason } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements InferenceProvider {
  async complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const url = `${trimSlash(target.baseUrl)}/v1/chat/completions`;
    return req.onToken
      ? this.#stream(url, target, req, isFallback)
      : this.#nonStream(url, target, req, isFallback);
  }

  async #nonStream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const authHeaders: Record<string, string> = target.apiKey
      ? { Authorization: `Bearer ${target.apiKey}` }
      : {};

    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOpenAIMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      temperature: cloudTemperature(target, req),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      // See `InferenceRequest.reasoningMaxTokens`: on a reasoning model the
      // thinking is spent out of `max_tokens` BEFORE the answer, so bounding
      // the reply alone yields a long monologue and an empty `content`.
      // `effort` wins when both are given: it survives OpenRouter's per-request
      // routing, where a token cap is honoured by some upstreams and ignored by
      // others.
      // Pin the upstream where the gateway routes per request — see
      // `InferenceRequest.providerOnly` for the measurements that make this
      // mandatory rather than tidy. `allow_fallbacks: false` is the point: a
      // fallback is exactly the unpinned behaviour we are removing.
      ...(req.providerOnly && req.providerOnly.length > 0
        ? { provider: { only: req.providerOnly, allow_fallbacks: false } }
        : {}),
      ...(req.reasoningEffort
        ? { reasoning: { effort: req.reasoningEffort } }
        : req.reasoningMaxTokens
          ? { reasoning: { max_tokens: req.reasoningMaxTokens } }
          : {}),
      ...cinderpawExtensionBody(target, req),
      stream: false,
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
      body.tool_choice = "auto";
    }

    // Loopback deadline comes from the perf policy (CINDERPAW_TOTAL_DEADLINE_MS
    // tunable) — a hardcoded value here silently bypassed the knob and killed
    // slow-hardware prefills (RSI evals on CPU rigs died at exactly 300s).
    const raw = (await postJson(
      url,
      body,
      authHeaders,
      req.signal,
      isLoopbackTarget(target)
        ? resolvePerfPolicy({ isCloud: false }).totalDeadlineMs
        : CLOUD_IDLE_MS,
    )) as {
      choices?: {
        message?: {
          content?: string;
          reasoning_content?: string;
          /** OpenRouter's normalised spelling of the same field. */
          reasoning?: string;
          tool_calls?: any[];
        };
        finish_reason?: string;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      /** OpenRouter names the endpoint that actually served the call. */
      provider?: string;
    };
    let content = raw.choices?.[0]?.message?.content ?? "";
    // Reasoning models on OpenAI-compatible servers (NVIDIA NIM, DeepSeek,
    // stepfun, QwQ, …) return chain-of-thought in a separate
    // `reasoning_content` field. Without folding it back in, a turn whose
    // visible answer is empty (e.g. all budget spent reasoning) looks like
    // a fully empty response to the agent loop. Wrap it in <think> tags —
    // the exact format local thinking models emit — so stripThinking()
    // and the frontend's live thinking-splitter handle it unchanged.
    // Two spellings for one thing: DeepSeek/NIM/QwQ say `reasoning_content`,
    // OpenRouter normalises it to `reasoning`. Reading only the first meant
    // every reasoning model routed through OpenRouter had its chain-of-thought
    // silently dropped on the floor.
    const reasoning =
      raw.choices?.[0]?.message?.reasoning_content ??
      raw.choices?.[0]?.message?.reasoning ??
      "";
    if (reasoning) {
      content = `<think>${reasoning}</think>${content}`;
    }
    const toolCalls = raw.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      // Re-encode EVERY tool call (previously only [0], dropping parallel calls).
      content = trimDanglingToolCallTag(content);
      for (const call of toolCalls) {
        const fn = call?.function;
        if (!fn?.name) continue;
        content += encodeToolCall(fn.name, fn.arguments);
      }
    }
    const reportedPrompt = raw.usage?.prompt_tokens;
    const reportedCompletion = raw.usage?.completion_tokens;
    const promptTokens = reportedPrompt ?? estimateTokens(req.messages);
    const completionTokens = reportedCompletion ?? estimateText(content);
    // Cache accounting was wired into the streaming branch only, so every
    // non-streamed completion — the summarizer, the memory extractor, any
    // caller without an `onToken` — reported nothing about caching and was
    // indistinguishable from a provider that does not cache at all. Same
    // dialect as `#stream`: `prompt_tokens` INCLUDES the cached ones.
    const cachedTokens = raw.usage?.prompt_tokens_details?.cached_tokens;
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: target.model,
      usedFallback: isFallback,
      // Ours, not theirs — see InferenceResponse.tokensEstimated. EITHER half
      // being locally derived taints the row: a provider that reports its
      // prompt but not its output still leaves a number here that it never
      // said, and an unflagged estimate is exactly what this is for.
      ...(reportedPrompt === undefined || reportedCompletion === undefined
        ? { tokensEstimated: true }
        : {}),
      ...(raw.choices?.[0]?.finish_reason
        ? { finishReason: raw.choices[0].finish_reason }
        : {}),
      ...(cachedTokens !== undefined
        ? {
            cacheReadTokens: cachedTokens,
            freshPromptTokens: Math.max(0, promptTokens - cachedTokens),
          }
        : {}),
    };
  }

  async #stream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOpenAIMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      temperature: cloudTemperature(target, req),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...cinderpawExtensionBody(target, req),
      stream: true,
      // Without this, an OpenAI-compatible server sends NO usage block in a
      // stream — that is what the field is for. Every streamed completion then
      // fell through to `estimateTokens(req.messages)` below, and the number we
      // recorded as "what the provider charged" was our own count of our own
      // messages. It matched our breakdown to the exact token, which is the
      // giveaway: no provider's tokenizer agrees with ours that precisely.
      //
      // It also silently made prompt caching unobservable. `cached_tokens`
      // rides in the same usage block, so a provider that caches perfectly
      // looked identical to one that does not cache at all.
      stream_options: { include_usage: true },
      ...openRouterProviderPin(target),
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
      body.tool_choice = "auto";
    }

    const authHeaders: Record<string, string> = target.apiKey
      ? { Authorization: `Bearer ${target.apiKey}` }
      : {};
    // deadlineController (not the older idleAbortController) so cloud BYOK
    // targets (MiniMax, NVIDIA NIM, etc.) get the same TTFT timeout +
    // heartbeat progress events Ollama already has — without a heartbeat,
    // a slow-to-first-token cloud request looked identical to a hang for
    // up to CLOUD_IDLE_MS (60s) with zero UI feedback.
    const isCloud = !isLoopbackTarget(target);
    const policy = resolvePerfPolicy({ isCloud });
    const dc = deadlineController({
      policy,
      externalSignal: req.signal,
      onProgress: req.onProgress,
      sessionId: req.sessionId,
    });
    let content = "";
    let cacheReadTokens: number | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    // Explicit presence, not truthiness: a provider that legitimately reports 0
    // completion tokens (an empty answer) must not be recorded as one that
    // reported nothing.
    let reportedPrompt: number | undefined;
    let reportedCompletion: number | undefined;

    const toolCallsAccumulator: {
      id?: string;
      name?: string;
      arguments: string;
    }[] = [];
    let finishReason: string | undefined;

    // Reasoning models on OpenAI-compatible servers (NVIDIA NIM, DeepSeek,
    // stepfun, QwQ, …) stream chain-of-thought as `delta.reasoning_content`,
    // separate from `delta.content`. We fold it into the text stream wrapped
    // in <think> tags — the exact format local thinking models emit — so the
    // frontend's live thinking-splitter shows it as reasoning and
    // stripThinking() removes it from the final answer. Without this, a turn
    // that reasons before answering streams NOTHING and an all-reasoning
    // turn surfaces as "(The model returned an empty response.)".
    let inReasoning = false;
    let sawReasoningField = false;
    const emitPiece = (piece: string): void => {
      content += piece;
      req.onToken!(piece);
    };
    // Some providers (MiniMax-M2) split a word across the reasoning_content /
    // content boundary: the answer's first fragment ("Re" of "Rejection")
    // arrives as the tail of reasoning_content, so it lands in the <think>
    // block and the visible answer starts mid-word ("jection"). We hold back
    // the trailing non-whitespace run of reasoning until we see what follows:
    // more reasoning → it was reasoning, flush it; a lowercase word-char in
    // content with no space → it continues the word, move it into the answer.
    // Unicode, not ASCII. These two tests used to be /\w$/ and /^[a-z0-9]/,
    // which are ASCII-only in JavaScript — so a Romanian word split across the
    // seam never healed: "stăte" + "ăm" failed the second test on the "ă",
    // and the answer began mid-word with the rest stranded inside <think>.
    // Every language whose letters live outside A-Z had the same problem, on
    // every provider that streams reasoning separately.
    // Unicode, not ASCII. These two tests were /w$/ and /^[a-z0-9]/, which
    // are ASCII-only in JavaScript — so a Romanian word split across the seam
    // never healed: "stăte" + "ăm" fails the second test on the "ă", and the
    // answer begins mid-word with the rest stranded inside <think>. Every
    // language whose letters live outside A-Z had the same problem, on every
    // provider that streams reasoning separately from content.
    const SEAM_TAIL_END = /[\p{L}\p{N}]$/u;
    const SEAM_HEAD_CONT = /^[\p{Ll}\p{N}]/u;
    let reasoningTail = "";
    const flushReasoningTail = (): void => {
      if (reasoningTail) { emitPiece(reasoningTail); reasoningTail = ""; }
    };
    const emitReasoning = (tok: string): void => {
      const combined = reasoningTail + tok;
      const lastWs = Math.max(
        combined.lastIndexOf(" "),
        combined.lastIndexOf("\n"),
        combined.lastIndexOf("\t"),
      );
      if (lastWs === -1) {
        reasoningTail = combined; // no whitespace yet — keep growing the tail
      } else {
        emitPiece(combined.slice(0, lastWs + 1));
        reasoningTail = combined.slice(lastWs + 1);
      }
    };
    const closeReasoning = (): void => {
      if (inReasoning) {
        inReasoning = false;
        emitPiece("</think>");
      }
    };

    try {
      const res = await fetchStream(url, body, authHeaders, dc.signal);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: unknown;
        try { chunk = JSON.parse(data); } catch { return; }

        const delta = (chunk as {
          choices?: {
            delta?: {
              content?: string;
              reasoning_content?: string;
              // OpenRouter's normalized field: it maps every provider's
              // reasoning channel (DeepSeek's reasoning_content, Solar,
              // Anthropic thinking, …) onto `delta.reasoning`. Ignoring it
              // meant reasoning models reached through OpenRouter either
              // showed no thinking at all or leaked raw chain-of-thought
              // into the answer as apparent gibberish (Darius, 2026-08-24).
              reasoning?: string;
            };
          }[];
        }).choices?.[0]?.delta;

        const reasoningTok = delta?.reasoning_content ?? delta?.reasoning ?? "";
        if (reasoningTok && !sawReasoningField) {
          sawReasoningField = true;
          // Named once per stream, because "which field did this provider
          // actually use" is otherwise unanswerable without a packet capture,
          // and it is the first question when reasoning goes missing.
          log(
            `reasoning stream: provider uses '${delta?.reasoning_content ? "reasoning_content" : "reasoning"}'`,
          );
        }
        if (reasoningTok) {
          if (!inReasoning) {
            inReasoning = true;
            emitPiece("<think>");
          }
          emitReasoning(reasoningTok);
        }

        const token = delta?.content ?? "";
        if (token) {
          if (inReasoning) {
            // ponytail: heuristic seam heal. A held tail ending in a word char
            // followed by a lowercase word-char with no space is a split word
            // → move the tail into the answer. Otherwise it was real reasoning.
            if (reasoningTail && SEAM_TAIL_END.test(reasoningTail) && SEAM_HEAD_CONT.test(token)) {
              closeReasoning();
              emitPiece(reasoningTail);
              reasoningTail = "";
            } else {
              flushReasoningTail();
              closeReasoning();
            }
          }
          emitPiece(token);
        }

        const chunkFinish = (chunk as { choices?: { finish_reason?: string | null }[] })
          .choices?.[0]?.finish_reason;
        if (chunkFinish) finishReason = chunkFinish;

        const toolCalls = (chunk as { choices?: { delta?: { tool_calls?: any[] } }[] }).choices?.[0]?.delta?.tool_calls;
        if (toolCalls) {
          for (const tc of toolCalls) {
            // `index` is how the OpenAI wire format keeps parallel calls apart.
            // Providers that omit it used to collapse EVERY call in a batch into
            // slot 0: the later ones overwrote the earlier name and their
            // argument fragments concatenated into garbage, so a batch of three
            // executed as one. Confirmed on the walk-away bench across two
            // tasks — three lead POSTs became one, "pause + raise budget"
            // executed only the pause, and a "GET then POST" dropped the GET so
            // the agent wrote a record it had never checked for. Every symptom
            // is one call surviving a batch.
            //
            // Without an index, use the delta's own shape: a fragment carrying
            // a name or an id STARTS a call, one carrying only arguments
            // CONTINUES the call it follows.
            const idx =
              tc.index ??
              (tc.function?.name || tc.id
                ? toolCallsAccumulator.length
                : Math.max(0, toolCallsAccumulator.length - 1));
            if (!toolCallsAccumulator[idx]) {
              toolCallsAccumulator[idx] = { arguments: "" };
            }
            if (tc.id) toolCallsAccumulator[idx].id = tc.id;
            if (tc.function?.name) toolCallsAccumulator[idx].name = tc.function.name;
            if (tc.function?.arguments) {
              toolCallsAccumulator[idx].arguments += tc.function.arguments;
            }
          }
        }

        // `prompt_tokens_details.cached_tokens` is the OpenAI-compatible spelling
        // of "this much of the prefix was served from cache". These endpoints
        // cache a stable prefix on their own with no request field to set, so
        // there is nothing to send here — only something to read, and reading it
        // is the whole point: it is the difference between believing caching
        // works and knowing it does.
        const usage = (chunk as {
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        }).usage;
        if (usage) {
          if (usage.prompt_tokens !== undefined) {
            reportedPrompt = usage.prompt_tokens;
            promptTokens = usage.prompt_tokens;
          }
          if (usage.completion_tokens !== undefined) {
            reportedCompletion = usage.completion_tokens;
            completionTokens = usage.completion_tokens;
          }
          const cached = usage.prompt_tokens_details?.cached_tokens;
          if (cached !== undefined) cacheReadTokens = cached;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        dc.resetIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);
      // A turn can end while still inside reasoning (all-reasoning turn, or
      // reasoning followed directly by a tool call) — close the tag so the
      // <think> block is well-formed for stripThinking()/the frontend.
      // An all-reasoning turn ended without content, so the held tail was
      // genuinely reasoning — flush it inside the block before closing.
      flushReasoningTail();
      closeReasoning();

      // Re-encode EVERY accumulated tool call (previously only [0], which
      // silently dropped parallel calls — the model then waited on results
      // that never came and the turn stalled). The tag is appended to
      // `content` only, NOT emitted via onToken: chunk events reach the chat
      // UI verbatim, and a raw `<tool_call>{json}` after prose leaked into
      // the visible answer. Pass 0 of parseResponse reads it from content.
      const completedCalls = toolCallsAccumulator.filter((tc) => tc?.name);
      if (completedCalls.length > 0) {
        content = trimDanglingToolCallTag(content);
        for (const tc of completedCalls) {
          content += encodeToolCall(tc.name!, tc.arguments);
        }
      }
    } finally {
      dc.cleanup();
    }

    if (reportedPrompt === undefined) promptTokens = estimateTokens(req.messages);
    if (reportedCompletion === undefined) completionTokens = estimateText(content);
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: target.model,
      usedFallback: isFallback,
      // Ours, not theirs — see InferenceResponse.tokensEstimated. EITHER half
      // being locally derived taints the row: a provider that reports its
      // prompt but not its output still leaves a number here that it never
      // said, and an unflagged estimate is exactly what this is for.
      ...(reportedPrompt === undefined || reportedCompletion === undefined
        ? { tokensEstimated: true }
        : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      // OpenAI dialect: `prompt_tokens` already counts the cached ones, so the
      // fresh half is the difference. Clamped at 0 — a provider reporting more
      // cached than prompt is lying, and a negative cost is worse than a zero.
      ...(cacheReadTokens !== undefined
        ? { freshPromptTokens: Math.max(0, promptTokens - cacheReadTokens) }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements InferenceProvider {
  async complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const url = `${trimSlash(target.baseUrl)}/v1/messages`;
    return req.onToken
      ? this.#stream(url, target, req, isFallback)
      : this.#nonStream(url, target, req, isFallback);
  }

  async #nonStream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const { systemText, userMessages } = splitAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: target.model,
      // Anthropic requires max_tokens — the API returns 400 without it.
      // We send 128K as a generous upper bound: Claude Opus 4.7/4.8 support
      // 128K output, Sonnet 4.6 supports 8K. The model stops naturally
      // when it's done — max_tokens is just the ceiling, not a target.
      // The user's explicit override always wins.
      max_tokens: req.maxTokens ?? 128_000,
      messages: userMessages,
      temperature: cloudTemperature(target, req),
    };
    if (systemText) body.system = systemText;
    // A3: use native function calling when tool definitions are provided.
    if (req.nativeTools && req.nativeTools.length > 0) body.tools = req.nativeTools;
    Object.assign(body, anthropicCacheControl(req));

    const authHeaders: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (target.apiKey) authHeaders["x-api-key"] = target.apiKey;

    const raw = (await postJson(url, body, authHeaders, req.signal, CLOUD_IDLE_MS)) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      stop_reason?: string;
    };

    // A3: collect both text and tool_use blocks.
    let content = raw.content?.find((b) => b.type === "text")?.text ?? "";
    for (const block of raw.content ?? []) {
      if (block.type === "tool_use" && block.name) {
        // Serialise as <tool_call> XML so Pass 0 of parseResponse picks it up.
        content += encodeToolCall(block.name, block.input ?? {});
      }
    }
    const reportedPrompt = raw.usage?.input_tokens;
    const reportedCompletion = raw.usage?.output_tokens;
    const promptTokens = reportedPrompt ?? estimateTokens(req.messages);
    const completionTokens = reportedCompletion ?? estimateText(content);
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: target.model,
      usedFallback: isFallback,
      // Ours, not theirs — see InferenceResponse.tokensEstimated. EITHER half
      // being locally derived taints the row: a provider that reports its
      // prompt but not its output still leaves a number here that it never
      // said, and an unflagged estimate is exactly what this is for.
      ...(reportedPrompt === undefined || reportedCompletion === undefined
        ? { tokensEstimated: true }
        : {}),
      ...(raw.stop_reason
        ? { finishReason: mapAnthropicStopReason(raw.stop_reason) }
        : {}),
      ...(raw.usage?.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: raw.usage.cache_read_input_tokens }
        : {}),
      ...(raw.usage?.cache_creation_input_tokens !== undefined
        ? { cacheWriteTokens: raw.usage.cache_creation_input_tokens }
        : {}),
      // Anthropic dialect: `input_tokens` already EXCLUDES the cached ones, so
      // the fresh half is exactly it — no subtraction. Reported only when the
      // provider said something about cache at all, so "unknown" stays
      // distinguishable from "nothing was cached".
      ...(raw.usage?.cache_read_input_tokens !== undefined ||
      raw.usage?.cache_creation_input_tokens !== undefined
        ? { freshPromptTokens: promptTokens }
        : {}),
    };
  }

  async #stream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const { systemText, userMessages } = splitAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: target.model,
      max_tokens: req.maxTokens ?? 128_000,
      messages: userMessages,
      temperature: cloudTemperature(target, req),
      stream: true,
    };
    if (systemText) body.system = systemText;
    // A3: use native function calling when tool definitions are provided.
    if (req.nativeTools && req.nativeTools.length > 0) body.tools = req.nativeTools;
    Object.assign(body, anthropicCacheControl(req));

    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      ...(target.apiKey ? { "x-api-key": target.apiKey } : {}),
    };

    // deadlineController, not idleAbortController — see the same swap in
    // OpenAICompatibleProvider#stream above: this is the streaming path for
    // Anthropic-shaped BYOK cloud targets, and it needs the TTFT timeout +
    // heartbeat too, not just a bare idle-since-last-chunk timer.
    const policy = resolvePerfPolicy({ isCloud: true });
    const dc = deadlineController({
      policy,
      externalSignal: req.signal,
      onProgress: req.onProgress,
      sessionId: req.sessionId,
    });
    let content = "";
    // Explicit presence, not truthiness — see the note in the OpenAI stream.
    let reportedPrompt: number | undefined;
    let reportedCompletion: number | undefined;
    // Reported on message_start alongside input_tokens. Left undefined when the
    // provider says nothing, so "no caching here" and "cache read nothing" stay
    // distinguishable — the second is a bug, the first is not.
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let anthropicStopReason: string | undefined;

    // A3: per-block accumulator for tool_use streaming.
    // Anthropic streams tool_use blocks as:
    //   content_block_start  {type:"tool_use", id, name}
    //   content_block_delta  {delta:{type:"input_json_delta", partial_json:"..."}}
    //   content_block_stop
    // We accumulate partial_json per block index, then emit a <tool_call>
    // at content_block_stop.
    type ToolBlock = { name: string; json: string };
    const toolBlocks = new Map<number, ToolBlock>();
    let activeBlockIndex = -1;
    let activeBlockType = "";

    try {
      const res = await fetchStream(url, body, headers, dc.signal);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        let chunk: unknown;
        try { chunk = JSON.parse(data); } catch { return; }

        const type = (chunk as { type?: string }).type;
        if (type === "content_block_start") {
          const idx = (chunk as { index?: number }).index ?? -1;
          const cb = (chunk as { content_block?: { type?: string; name?: string } }).content_block;
          activeBlockIndex = idx;
          activeBlockType = cb?.type ?? "";
          if (cb?.type === "tool_use" && cb.name) {
            toolBlocks.set(idx, { name: cb.name, json: "" });
          }
        } else if (type === "content_block_delta") {
          const delta = (chunk as { delta?: { type?: string; text?: string; partial_json?: string } }).delta;
          if (!delta) return;
          if (delta.type === "text_delta") {
            const token = delta.text ?? "";
            if (token) { content += token; req.onToken!(token); }
          } else if (delta.type === "input_json_delta") {
            // Accumulate partial JSON for the current tool_use block.
            const block = toolBlocks.get(activeBlockIndex);
            if (block) block.json += delta.partial_json ?? "";
          }
        } else if (type === "content_block_stop") {
          if (activeBlockType === "tool_use") {
            const block = toolBlocks.get(activeBlockIndex);
            if (block) {
              // Appended to `content` only, NOT emitted via onToken — chunk
              // events reach the chat UI verbatim and the raw tag leaked into
              // the visible answer after prose. parseResponse reads content.
              // A `max_tokens` cutoff mid-`input_json_delta` leaves `json`
              // truncated; encodeToolCall turns that into a malformed call the
              // loop retries, instead of a silent empty-args execution.
              content += encodeToolCall(block.name, block.json);
            }
          }
          activeBlockIndex = -1;
          activeBlockType = "";
        } else if (type === "message_start") {
          const startUsage = (chunk as {
            message?: {
              usage?: {
                input_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
          }).message?.usage;
          reportedPrompt = startUsage?.input_tokens;
          if (startUsage?.cache_read_input_tokens !== undefined) {
            cacheReadTokens = startUsage.cache_read_input_tokens;
          }
          if (startUsage?.cache_creation_input_tokens !== undefined) {
            cacheWriteTokens = startUsage.cache_creation_input_tokens;
          }
        } else if (type === "message_delta") {
          reportedCompletion = (chunk as { usage?: { output_tokens?: number } }).usage?.output_tokens;
          const stopReason = (chunk as { delta?: { stop_reason?: string } }).delta?.stop_reason;
          if (stopReason) anthropicStopReason = stopReason;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        dc.resetIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);
    } finally {
      dc.cleanup();
    }

    const promptTokens = reportedPrompt ?? estimateTokens(req.messages);
    const completionTokens = reportedCompletion ?? estimateText(content);
    return {
      content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: target.model,
      usedFallback: isFallback,
      // Ours, not theirs — see InferenceResponse.tokensEstimated. EITHER half
      // being locally derived taints the row: a provider that reports its
      // prompt but not its output still leaves a number here that it never
      // said, and an unflagged estimate is exactly what this is for.
      ...(reportedPrompt === undefined || reportedCompletion === undefined
        ? { tokensEstimated: true }
        : {}),
      ...(anthropicStopReason
        ? { finishReason: mapAnthropicStopReason(anthropicStopReason) }
        : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      // Same Anthropic dialect as the non-streaming path above: `input_tokens`
      // is already the uncached half.
      ...(cacheReadTokens !== undefined || cacheWriteTokens !== undefined
        ? { freshPromptTokens: promptTokens }
        : {}),
    };
  }
}

/**
 * Normalize Anthropic stop_reason values to the cross-provider finishReason
 * vocabulary the agent loop understands ("stop" | "length" | "tool_calls").
 */
function mapAnthropicStopReason(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return stopReason;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (moved here from inference-router.ts)
// ---------------------------------------------------------------------------

/**
 * A3 regression fix: Remove text-based tool definitions and instructions from
 * the system prompt when native function calling is used. This prevents the
 * model from getting confused or attempting to emit legacy XML blocks.
 */
export function stripToolsFromSystemPrompt(systemPrompt: string): string {
  const lines = systemPrompt.split("\n");
  const resultLines: string[] = [];
  let inStrippedSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## Available tools") || line.startsWith("## How to call a tool")) {
      inStrippedSection = true;
      continue;
    }
    if (inStrippedSection && line.startsWith("## ") && !line.startsWith("## Available tools") && !line.startsWith("## How to call a tool")) {
      inStrippedSection = false;
    }
    if (line === "No tools are available.") {
      continue;
    }
    if (!inStrippedSection) {
      resultLines.push(line);
    }
  }
  return resultLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


/**
 * Resolve the Ollama `num_ctx` value (context-window size in tokens).
 *
 * P5 fix: this used to be `req.maxTokens`, which silently conflated the
 * per-completion output cap with the model's KV-cache size and forced a
 * 16,384-token context window for every Ollama call. The two parameters
 * are now sourced independently:
 *
 *   - num_predict  = req.maxTokens            (per-completion output cap)
 *   - num_ctx      = CINDERPAW_OLLAMA_NUM_CTX     (context window, default 8192)
 *
 * Operators targeting a specific model card should set CINDERPAW_OLLAMA_NUM_CTX
 * to match (e.g. 32768 for a Qwen2.5-32B context, 131072 for a long-context
 * model). The default 8192 is a safe middle ground for the 7B-class
 * models the bundled llama.cpp engine targets.
 */
function readOllamaNumCtx(): number {
  const raw = readEnv("CINDERPAW_OLLAMA_NUM_CTX");
  if (raw === undefined || raw === "") return 8192;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 8192;
  return n;
}

/**
 * `deadlineController` generalizes the old idle-only abort controller with
 * three timers:
 *
 *   1. **TTFT** — armed at construction. Cleared the first time `resetIdle()`
 *      is called (i.e. the first SSE chunk / NDJSON line arrives). If it
 *      fires, the controller aborts with `TtftTimeoutError`.
 *   2. **Total** — armed at construction, never cleared. Fires
 *      `totalDeadlineMs` regardless of activity. Aborts with
 *      `TotalTimeoutError`.
 *   3. **Stall** — armed on the first `resetIdle()` call, re-armed on each
 *      subsequent call. Fires `stallMs` of silence between chunks. Aborts
 *      with `IdleTimeoutError` (the existing typed error, kept stable so
 *      the router's pre-existing mapping still works).
 *
 * Plus a heartbeat timer (every `heartbeatMs`) that calls `onProgress` so
 * the UI sees live progress even during prefill silence — without this, a
 * 60-second prefill on a big prompt would look identical to a hang.
 *
 * The caller MUST call `cleanup()` in a finally block to avoid leaking the
 * heartbeat timer (TTFT/total/stall auto-clear on abort).
 *
 * The external signal (if provided) is honored: when it aborts, the
 * controller mirrors its reason — typically a user-initiated stop, where the
 * cause is `externalSignal.reason` and the UI is responsible for showing it.
 */
export interface DeadlineController {
  readonly signal: AbortSignal;
  /**
   * Call on every chunk arrival (BEFORE processing it). The first call
   * clears the TTFT timer + marks first-token timestamp; subsequent calls
   * re-arm the stall timer. Cheap; idempotent.
   */
  resetIdle(): void;
  /**
   * Cleanup all timers + external-signal listener. MUST be called in a
   * finally block. Idempotent.
   */
  cleanup(): void;
}

export interface DeadlineControllerOptions {
  policy: PerfPolicy;
  externalSignal?: AbortSignal;
  /** Fires on every heartbeat tick. Required for the UI to see progress. */
  onProgress?: (event: StreamProgressEvent) => void;
  /**
   * Session id for the heartbeat payload. Required when `onProgress`
   * is set (otherwise the UI can't route the event to its store).
   */
  sessionId?: string;
  /**
   * Known prompt token count, when available. Used to scale TTFT so a
   * legitimately long prefill on a big prompt isn't killed (4 ms/token
   * on top of the base, capped at totalDeadlineMs).
   */
  promptTokens?: number;
}

export function deadlineController(
  opts: DeadlineControllerOptions,
): DeadlineController {
  const { policy, externalSignal, onProgress, sessionId, promptTokens } = opts;
  const ac = new AbortController();
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let tokensGenerated = 0;
  let ttftTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanedUp = false;

  const effectiveTtft = promptTokens !== undefined && promptTokens > 0
    ? Math.min(
        policy.ttftDeadlineMs + promptTokens * 4,
        policy.totalDeadlineMs,
      )
    : policy.ttftDeadlineMs;

  const trip = (name: string, message: string): void => {
    if (cleanedUp || ac.signal.aborted) return;
    const err = new Error(message);
    err.name = name;
    ac.abort(err);
  };

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => trip(
        "IdleTimeoutError",
        `inference stream stalled: no data received for ${Math.round(policy.stallMs / 1000)}s`,
      ),
      policy.stallMs,
    );
  };

  // ── TTFT: armed at construction, cleared on first token ────────────
  ttftTimer = setTimeout(
    () => trip(
      "TtftTimeoutError",
      `[ttft_timeout] The model didn't start responding within ${Math.round(effectiveTtft / 1000)}s. The prompt may be too long or the model too large for this hardware — try a shorter prompt, a smaller model, or a cloud key.`,
    ),
    effectiveTtft,
  );

  // ── Total: armed at construction, never cleared ────────────────────
  totalTimer = setTimeout(
    () => trip(
      "TotalTimeoutError",
      `[total_timeout] Generation ran past the ${Math.round(policy.totalDeadlineMs / 1000)}s limit and was stopped. Try a smaller model or shorter output.`,
    ),
    policy.totalDeadlineMs,
  );

  // ── Heartbeat: armed at construction, fires every heartbeatMs ─────
  // Fire an initial one immediately so the UI sees "prefill" right away
  // rather than waiting heartbeatMs for the first paint.
  const fireHeartbeat = (): void => {
    if (cleanedUp || ac.signal.aborted) return;
    if (!onProgress) return;
    const now = Date.now();
    const elapsedMs = now - startedAt;
    const phase = firstTokenAt === null ? "prefill" : "generating";
    const tokensPerSec = firstTokenAt !== null && tokensGenerated > 0
      ? (tokensGenerated / Math.max(1, now - firstTokenAt)) * 1000
      : 0;
    onProgress({
      type: "stream_progress",
      sessionId: sessionId ?? "",
      phase,
      elapsedMs,
      promptTokens: promptTokens ?? 0,
      tokensGenerated,
      tokensPerSec,
    });
  };
  fireHeartbeat();
  heartbeatTimer = setInterval(fireHeartbeat, policy.heartbeatMs);

  // ── External signal: mirror on abort ──────────────────────────────
  let onExt: (() => void) | null = null;
  if (externalSignal) {
    onExt = () => {
      if (cleanedUp) return;
      ac.abort(externalSignal.reason);
    };
    if (externalSignal.aborted) {
      onExt();
    } else {
      externalSignal.addEventListener("abort", onExt, { once: true });
    }
  }

  return {
    signal: ac.signal,
    resetIdle() {
      if (cleanedUp) return;
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        if (ttftTimer) { clearTimeout(ttftTimer); ttftTimer = null; }
      }
      tokensGenerated++;
      armStall();
    },
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      if (ttftTimer) { clearTimeout(ttftTimer); ttftTimer = null; }
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (externalSignal && onExt) externalSignal.removeEventListener("abort", onExt);
    },
  };
}

/**
 * Refuse to carry the API key across a redirect to a different origin.
 *
 * The inference path calls the global `fetch`, whose default `redirect:
 * "follow"` chases a 3xx for us. That is fine for a browser and wrong here for
 * two reasons:
 *
 *  1. The platform strips `Authorization` on a cross-origin redirect. It does
 *     not strip `x-api-key`, because no specification knows that header is a
 *     credential. Anthropic authenticates with `x-api-key`, so an inference
 *     endpoint answering `302 Location: http://someone-else/` was handed the
 *     user's Anthropic key and nothing in the platform objected.
 *  2. The audit log records the URL we asked for, never the one that answered,
 *     so the hop left no trace anywhere.
 *
 * `redirect: "manual"` gives us the decision. A same-origin redirect is
 * ordinary path normalisation and is followed with the headers intact. A
 * cross-origin one is refused, loudly, naming both origins: an inference
 * endpoint that wants to move a key to another host is not a case worth
 * guessing about.
 */
const MAX_INFERENCE_REDIRECTS = 3;

async function fetchFollowingSameOriginOnly(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;

    if (hop >= MAX_INFERENCE_REDIRECTS) {
      throw new InferenceError(
        `inference endpoint ${url} redirected more than ${MAX_INFERENCE_REDIRECTS} times`,
      );
    }
    const next = new URL(location, current);
    const from = new URL(current);
    if (next.origin.toLowerCase() !== from.origin.toLowerCase()) {
      throw new InferenceError(
        `inference endpoint ${from.origin} redirected to ${next.origin}. ` +
          `Refusing to follow: that would send your API key to a different server. ` +
          `If this is expected, set the provider's base URL to ${next.origin} yourself.`,
      );
    }
    current = next.toString();
  }
}

async function fetchStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const res = await fetchFollowingSameOriginOnly(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new InferenceError(
      `inference endpoint ${url} returned ${res.status}: ${detail.slice(0, 200)}`,
      res.status,
      res.headers.get("retry-after"),
    );
  }
  if (!res.body) throw new InferenceError("no response body for streaming");
  return res;
}

export async function postJson(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
  externalSignal?: AbortSignal,
  timeoutMs: number = 300_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onExt: (() => void) | null = null;
  if (externalSignal) {
    onExt = () => { clearTimeout(timer); controller.abort(externalSignal.reason); };
    if (externalSignal.aborted) onExt();
    else externalSignal.addEventListener("abort", onExt, { once: true });
  }
  try {
    const res = await fetchFollowingSameOriginOnly(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new InferenceError(
        `inference endpoint ${url} returned ${res.status}: ${detail.slice(0, 200)}`,
        res.status,
        res.headers.get("retry-after"),
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExt) externalSignal.removeEventListener("abort", onExt);
  }
}

export function toProviderMessage(m: ChatMessage): { role: string; content: string } {
  const role = m.role === "tool" ? "user" : m.role;
  const content = m.role === "tool" ? `[tool:${m.name ?? "unknown"}] ${m.content}` : m.content;
  return { role, content };
}

/** Split a `data:<mime>;base64,<data>` URL into its parts, or null if malformed. */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { mediaType: match[1]!, base64: match[2]! };
}

/**
 * OpenAI-compatible message with optional vision parts. Messages without
 * images keep the plain-string content shape (required for byte-stable
 * prompts / KV-cache reuse and maximum server compatibility); messages WITH
 * images use the standard `image_url` content-parts array that OpenAI,
 * OpenRouter, Google's OpenAI endpoint, and vision-enabled llama.cpp accept.
 */
export function toOpenAIMessage(m: ChatMessage): { role: string; content: unknown } {
  const base = toProviderMessage(m);
  if (!m.images || m.images.length === 0) return base;
  return {
    role: base.role,
    content: [
      ...(base.content ? [{ type: "text", text: base.content }] : []),
      ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

/**
 * Ollama message with optional vision support: `/api/chat` takes raw base64
 * strings (no data-URL prefix) in an `images` array next to `content`.
 */
export function toOllamaMessage(m: ChatMessage): { role: string; content: string; images?: string[] } {
  const base = toProviderMessage(m);
  if (!m.images || m.images.length === 0) return base;
  const raw = m.images
    .map((url) => parseDataUrl(url)?.base64)
    .filter((b): b is string => !!b);
  return raw.length > 0 ? { ...base, images: raw } : base;
}

export function splitAnthropicMessages(messages: ChatMessage[]): {
  systemText: string | undefined;
  userMessages: { role: string; content: unknown }[];
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const userMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const base = toProviderMessage(m);
      if (!m.images || m.images.length === 0) return base;
      const imageBlocks = m.images
        .map(parseDataUrl)
        .filter((p): p is { mediaType: string; base64: string } => !!p)
        .map((p) => ({
          type: "image",
          source: { type: "base64", media_type: p.mediaType, data: p.base64 },
        }));
      if (imageBlocks.length === 0) return base;
      return {
        role: base.role,
        content: [
          ...imageBlocks,
          ...(base.content ? [{ type: "text", text: base.content }] : []),
        ],
      };
    });
  return { systemText: systemMsg?.content, userMessages };
}

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += countTokens(m.content);
  return total;
}

export function estimateText(text: string): number {
  return countTokens(text);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Strip a dangling `<tool_call>` opener (no matching closer) from the END of
 * streamed/returned text. Some models narrate their native tool call as prose
 * ("… <tool_call>") right before the server switches to structured tool-call
 * deltas (observed with MiniMax M3); appending our canonical
 * `<tool_call>{json}</tool_call>` tag after that leftover produces a doubled
 * opener that breaks the agent loop's parser and leaks raw tags into chat.
 */
/**
 * Re-encode ONE native tool call into the canonical `<tool_call>` tag the agent
 * loop parses.
 *
 * The argument string is the part that breaks on long-horizon tasks: providers
 * stream `function.arguments` as a JSON fragment, and a turn that hits
 * `max_tokens` mid-`write_file` (or a connection that drops) delivers a
 * TRUNCATED fragment. Every call site used to do `try { JSON.parse(...) }
 * catch {}` over a `let args = {}`, so a truncated fragment silently became an
 * EMPTY argument object: `write_file` then ran with no path and no content, and
 * the loop saw a perfectly valid call, so no retry ever fired. That is the
 * "executes with wrong arguments / paths invented by the model" report.
 *
 * Now an unparseable non-empty fragment is emitted as an unmistakably malformed
 * call. `parseResponse` flags it (`malformedToolCall`), and the loop's existing
 * MAX_MALFORMED_RETRIES nudge asks the model to re-emit it — losing a turn
 * instead of writing a file to the wrong place.
 */
export function encodeToolCall(name: string, rawArgs: unknown): string {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return `\n<tool_call>\n${JSON.stringify({ name, args: rawArgs })}\n</tool_call>`;
  }
  const text = typeof rawArgs === "string" ? rawArgs.trim() : "";
  if (text === "") {
    // Genuinely no arguments — a zero-arg tool (time_date, self_health, …).
    return `\n<tool_call>\n${JSON.stringify({ name, args: {} })}\n</tool_call>`;
  }
  try {
    const parsed = JSON.parse(text);
    const args =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    return `\n<tool_call>\n${JSON.stringify({ name, args })}\n</tool_call>`;
  } catch {
    // Truncated / corrupted fragment. Emit the tag with the raw fragment so the
    // parser cannot mistake it for a complete call (its brace depth never
    // closes, so `findJsonEnd` returns -1 and `malformedToolCall` is set), and
    // cap + flatten it so a runaway fragment can't dominate the transcript.
    const fragment = text.slice(0, 2000).replace(/\s+/g, " ");
    return (
      `\n<tool_call>\n{"name": ${JSON.stringify(name)}, "args": ` +
      `${fragment}\n</tool_call>`
    );
  }
}

function trimDanglingToolCallTag(content: string): string {
  return content.replace(/(?:\s*<tool_call>\s*)+$/, "");
}

/**
 * Effective sampling temperature for a target.
 *
 * Cloud reasoning models (NVIDIA NIM, DeepSeek, stepfun, QwQ, …) degrade
 * catastrophically above ~1.0: they emit unbounded incoherent
 * `reasoning_content`, fill the whole `max_tokens` budget with chain-of-thought,
 * and return an EMPTY visible answer — the turn looks like "no output" while
 * the rate limit is spent, and the loop's empty-response retries multiply it.
 * A stray slider value (the UI Controls panel allows up to 2.0, persisted) is
 * enough to trigger it. Clamp cloud targets to 1.0; the bundled local engine
 * (loopback) keeps the full range for RSI diversity exploration.
 */
function cloudTemperature(target: ModelTarget, req: InferenceRequest): number {
  const t = req.temperature ?? 0.7;
  return isLoopbackTarget(target) ? t : Math.min(t, 1.0);
}

/** True when the target is the bundled local engine (loopback address). */
function isLoopbackTarget(target: ModelTarget): boolean {
  try {
    const host = new URL(target.baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Cinderpaw extension fields (`grammar`, `grammar_triggers`, `cache_prompt`)
 * are honored only by the bundled llama.cpp engine. They are sent ONLY to
 * loopback targets: strict cloud OpenAI-compatible servers (OpenAI itself,
 * NVIDIA NIM, …) reject unknown body parameters with a 400, which would
 * fail every agent request against them.
 */
/**
 * `cachePrefix` in Anthropic's dialect.
 *
 * Top-level `cache_control` rather than a breakpoint placed by hand: the API
 * puts it on the last cacheable block itself, which is exactly what we want and
 * cannot get wrong. Render order is tools → system → messages, so one
 * breakpoint after the system block covers both halves of the fixed cost — the
 * tool schemas and the system prompt — in a single marker.
 *
 * The long window costs about twice as much to write, so it is not the default;
 * it earns that back only when turns are far enough apart that a short-lived
 * entry would have expired between them.
 */
function anthropicCacheControl(req: InferenceRequest): Record<string, unknown> {
  if (!req.cachePrefix || req.cachePrefix === "none") return {};
  return {
    cache_control:
      req.cachePrefix === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
  };
}

/**
 * Pin OpenRouter to one named provider, when `CINDERPAW_OPENROUTER_PROVIDER`
 * asks for it. Off unless set.
 *
 * OpenRouter picks an endpoint PER REQUEST from everyone serving a model, and
 * for `z-ai/glm-5.3-flash` that is 22 endpoints — six of them reporting
 * `quantization: unknown`, and `max_completion_tokens` ranging from 128k to
 * 1.18M. They are not interchangeable, and nothing in a response says which one
 * answered.
 *
 * Measured on 2026-09-02: the same 21 telecom tasks, same seed, same model,
 * unchanged agent code, scored 11/21 and then 20/21. Nine tasks flipped, all in
 * the same direction, and their conversations collapsed from 201 messages to
 * 34-72. Variance does not do that; a degraded endpoint does. On the bad run
 * the model returned empty completions, the loop reported `no_answer`, and the
 * turn went nowhere.
 *
 * Deliberately NOT the default. Fallbacks across many providers are what keeps
 * an ordinary user answered when one endpoint is down, and someone who never
 * opens settings should keep that. A benchmark wants the opposite — the same
 * silicon every run, and a provider name it can print next to the score — so
 * the benchmark opts in. `allow_fallbacks: false` is the point: a pin that
 * silently falls back to a different provider measures nothing.
 */
export function openRouterProviderPin(target: ModelTarget): Record<string, unknown> {
  const raw = readEnv("CINDERPAW_OPENROUTER_PROVIDER")?.trim();
  if (!raw) return {};
  if (!/openrouter\.ai/i.test(target.baseUrl ?? "")) return {};
  // A LIST, in preference order, not a single name.
  //
  // One name is a single point of failure, and the failure is not theoretical:
  // measured 2026-09-02, `open-inference/fp8` answered one probe in three, the
  // other two coming back empty in under a second — and separately a task died
  // sixty seconds in on a 429 from the same endpoint, scoring zero for reasons
  // that had nothing to do with the agent.
  //
  // `allow_fallbacks: false` still holds, and it is doing MORE work now, not
  // less: routing may move within this list and may never leave it. That keeps
  // the declarable claim ("served by one of these three, in this order")
  // instead of "whatever OpenRouter picked", which is what swung identical
  // tau2 runs by 40 points.
  //
  // Order matters for comparability as well as uptime: put the endpoint whose
  // numbers you intend to report first, and treat the rest as a net. Which one
  // actually served each call is recorded per response — see `servedBy` — so a
  // fallback is a declared, countable fact rather than a silent confound.
  const order = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (order.length === 0) return {};
  return { provider: { order, allow_fallbacks: false } };
}

function cinderpawExtensionBody(
  target: ModelTarget,
  req: InferenceRequest,
): Record<string, unknown> {
  if (!isLoopbackTarget(target)) return {};
  // A local llama.cpp engine spells the same idea `cache_prompt`, and takes no
  // retention argument — it holds one KV cache for as long as the context
  // lives, so "short" and "long" are the same thing here. `cachePrompt` is the
  // older boolean form of the field and still wins when a caller sets it, so
  // nothing that predates the contract changes behaviour.
  const prefix = req.cachePrompt ?? (req.cachePrefix ? req.cachePrefix !== "none" : undefined);
  return {
    ...(req.grammar
      ? {
          grammar: req.grammar,
          ...(req.grammarTriggers && req.grammarTriggers.length > 0
            ? { grammar_triggers: req.grammarTriggers }
            : {}),
        }
      : {}),
    ...(prefix !== undefined ? { cache_prompt: prefix } : {}),
  };
}
