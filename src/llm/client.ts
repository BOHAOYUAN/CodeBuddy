import { AgentConfig } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResult {
  message: ChatMessage;
  usage: Usage;
  latencyMs: number;
  model: string;
  finishReason: string | null;
}

export interface CallOptions {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  /** Label used in error messages and logs, e.g. 'plan' | 'act' | 'validate'. */
  phase?: string;
}

export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'LlmRequestError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Providers report rate-limit recovery in free-form prose
 * ("Please try again in 1.4925s", "try again in 250ms"). Parsing it is far more
 * effective than blind exponential backoff, which either gives up too early or
 * wastes minutes.
 */
export function parseSuggestedDelayMs(message: string): number | undefined {
  const match = /try again in ([\d.]+)\s*(ms|s|m)\b/i.exec(message);
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;

  const unit = match[2].toLowerCase();
  const ms = unit === 'ms' ? value : unit === 's' ? value * 1000 : value * 60_000;
  return Math.min(Math.max(Math.ceil(ms), 500), 60_000);
}

/**
 * A per-day quota is not a rate limit.
 *
 * The per-minute ceiling recovers in seconds, so waiting helps. A daily
 * allowance does not recover until the provider's day rolls over, so retrying is
 * pure waste — the run must stop and say so instead of burning the retry budget
 * on every remaining task.
 */
export function isDailyQuotaExhausted(message: string): boolean {
  return /tokens per day|\(TPD\)|daily (?:token )?(?:quota|limit)/i.test(message);
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * Thin OpenAI-compatible chat-completions client.
 *
 * Deliberately implemented on top of the wire protocol instead of a vendor SDK so
 * the same code path serves Groq, DeepSeek, Together, vLLM, or any other
 * OpenAI-compatible endpoint by changing GROQ_BASE_URL only.
 */
export class LlmClient {
  private totals: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private callCount = 0;
  private failureCount = 0;
  private readonly log: (msg: string) => void;

  /** Rolling log of tokens consumed, used to stay under a TPM ceiling. */
  private readonly tokenLog: { at: number; tokens: number }[] = [];
  private static readonly WINDOW_MS = 60_000;
  private pacedMs = 0;

  constructor(
    private readonly config: AgentConfig,
    logger?: (msg: string) => void
  ) {
    this.log = logger || (() => undefined);
  }

  get stats() {
    return {
      calls: this.callCount,
      failures: this.failureCount,
      usage: { ...this.totals },
      pacedMs: this.pacedMs,
      costUsd:
        (this.totals.promptTokens / 1_000_000) * this.config.pricePerMTokIn +
        (this.totals.completionTokens / 1_000_000) * this.config.pricePerMTokOut,
    };
  }

  resetStats(): void {
    this.totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.callCount = 0;
    this.failureCount = 0;
    this.tokenLog.length = 0;
    this.pacedMs = 0;
  }

  private tokensUsedInWindow(): number {
    const cutoff = Date.now() - LlmClient.WINDOW_MS;
    while (this.tokenLog.length > 0 && this.tokenLog[0].at < cutoff) {
      this.tokenLog.shift();
    }
    return this.tokenLog.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  private estimateTokens(options: CallOptions): number {
    const messageChars = options.messages.reduce(
      (sum, m) => sum + (m.content ? m.content.length : 0) + JSON.stringify(m.tool_calls || '').length,
      0
    );
    const toolChars = options.tools ? JSON.stringify(options.tools).length : 0;
    // ~3.5 characters per token, plus the worst-case completion budget.
    return Math.ceil((messageChars + toolChars) / 3.5) + (options.maxTokens ?? this.config.maxTokens);
  }

  /**
   * Client-side token-budget pacer.
   *
   * Free tiers enforce tokens-per-minute, not requests-per-minute, so a long
   * agent run will trip the ceiling even at a modest request rate. Waiting for
   * the window to drain before sending is dramatically cheaper than eating 429s
   * and retrying.
   */
  private async pace(options: CallOptions): Promise<void> {
    if (!this.config.tpmLimit) return;

    const estimate = this.estimateTokens(options);
    let waited = 0;

    while (this.tokensUsedInWindow() + estimate > this.config.tpmLimit) {
      if (waited >= 90_000) {
        this.log('[llm] token budget still exhausted after 90s; sending the request anyway');
        break;
      }
      await sleep(2000);
      waited += 2000;
    }

    if (waited > 0) {
      this.pacedMs += waited;
      this.log(
        `[llm] paced ${(waited / 1000).toFixed(1)}s to stay under the ${this.config.tpmLimit} TPM ceiling`
      );
    }
  }

  /**
   * Some OpenAI-compatible providers renamed `max_tokens` to `max_completion_tokens`.
   * Rather than hardcoding a per-provider quirk, the first 400 that complains about the
   * field flips this flag and the request is retried transparently.
   */
  private useMaxCompletionTokens = false;

  async complete(options: CallOptions): Promise<CompletionResult> {
    const buildBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: options.model || this.config.model,
        messages: options.messages,
        temperature: options.temperature ?? this.config.temperature,
      };
      body[this.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] =
        options.maxTokens ?? this.config.maxTokens;

      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools;
        body.tool_choice = 'auto';
      }
      if (options.responseFormat) {
        body.response_format = options.responseFormat;
      }
      return body;
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.pace(options);
        // Latency is measured from after pacing: waiting on the token budget is
        // not model latency and must not be reported as such.
        const startedAt = Date.now();
        const response = await this.request(buildBody(), options.phase);
        const latencyMs = Date.now() - startedAt;
        const result = this.parse(response, latencyMs);
        this.callCount++;
        this.accumulate(result.usage);
        this.tokenLog.push({ at: Date.now(), tokens: result.usage.totalTokens });
        return result;
      } catch (err) {
        lastError = err as Error;
        this.failureCount++;

        // A per-day allowance will not recover by waiting — stop immediately.
        if (err instanceof LlmRequestError && isDailyQuotaExhausted(err.message)) {
          throw new LlmRequestError(
            'Daily token quota exhausted for this provider account. Retrying cannot help: the allowance ' +
              'does not reset until the provider\'s day rolls over. ' +
              err.message.slice(0, 300),
            err.status,
            false
          );
        }

        // Provider-specific field-name quirk: flip once and retry immediately.
        if (
          !this.useMaxCompletionTokens &&
          err instanceof LlmRequestError &&
          err.status === 400 &&
          /max_completion_tokens/i.test(err.message)
        ) {
          this.useMaxCompletionTokens = true;
          this.log('[llm] provider expects max_completion_tokens; retrying with the renamed field');
          continue;
        }

        const retryable = err instanceof LlmRequestError ? err.retryable : true;
        if (!retryable || attempt === this.config.maxRetries) {
          throw err;
        }

        // Exponential backoff, but never shorter than the delay the provider asked for.
        const backoff = this.config.retryBaseDelayMs * 2 ** attempt;
        const suggested =
          err instanceof LlmRequestError ? parseSuggestedDelayMs(err.message) : undefined;
        const base = suggested ? Math.max(backoff, suggested) : backoff;
        const jittered = Math.round(base * (0.9 + Math.random() * 0.2));

        this.log(
          `[llm] ${options.phase || 'call'} failed (${(err as Error).message.slice(0, 120)}). ` +
            `Retry ${attempt + 1}/${this.config.maxRetries} in ${jittered}ms` +
            (suggested ? ` (provider asked for ${suggested}ms)` : '')
        );
        await sleep(jittered);
      }
    }

    throw lastError || new Error('LLM request failed with no recorded error');
  }

  private async request(body: Record<string, unknown>, phase?: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'codebuddy-agent/2.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new LlmRequestError(
          `HTTP ${response.status} during ${phase || 'call'}: ${text.slice(0, 400)}`,
          response.status,
          RETRYABLE_STATUS.has(response.status)
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new LlmRequestError(
          `Malformed JSON response during ${phase || 'call'}: ${text.slice(0, 200)}`,
          response.status,
          true
        );
      }
    } catch (err) {
      if (err instanceof LlmRequestError) throw err;
      const message = (err as Error).name === 'AbortError'
        ? `Request timed out after ${this.config.requestTimeoutMs}ms`
        : (err as Error).message;
      throw new LlmRequestError(message, 0, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(payload: any, latencyMs: number): CompletionResult {
    const choice = payload?.choices?.[0];
    if (!choice?.message) {
      throw new LlmRequestError(
        `Response contained no choices: ${JSON.stringify(payload).slice(0, 300)}`,
        200,
        true
      );
    }

    const raw = choice.message;
    const usage = payload.usage || {};

    return {
      message: {
        role: 'assistant',
        content: raw.content ?? null,
        tool_calls: raw.tool_calls,
      },
      usage: {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      },
      latencyMs,
      model: payload.model || this.config.model,
      finishReason: choice.finish_reason ?? null,
    };
  }

  private accumulate(usage: Usage): void {
    this.totals.promptTokens += usage.promptTokens;
    this.totals.completionTokens += usage.completionTokens;
    this.totals.totalTokens += usage.totalTokens;
  }
}
