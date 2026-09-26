export type TraceCategory = 'plan' | 'thought' | 'action' | 'observation' | 'reflection' | 'memory' | 'error' | 'complete';

export interface TraceEvent {
  /** 1-based step index within the ReAct loop. 0 for pre-loop phases (plan). */
  step: number;
  iteration: number;
  category: TraceCategory;
  title: string;
  content: string;
  timestamp: string;
  elapsedMs: number;
  /** Present on 'action' events. */
  toolName?: string;
  toolArgs?: string;
  /** Present on 'action' events that hit an error path. */
  ok?: boolean;
  tokens?: { prompt: number; completion: number; total: number };
  latencyMs?: number;
}

export interface RunSummary {
  goal: string;
  targetFile: string;
  success: boolean;
  stopReason: StopReason;
  iterations: number;
  toolCalls: number;
  toolFailures: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  llmLatencyMs: number;
  /** Time spent deliberately waiting to stay under the provider's token-per-minute ceiling. */
  pacedMs: number;
  wallClockMs: number;
  contextCharsSent: number;
  contextCharsIfNaiveRead: number;
  tokenReductionPct: number;
  startedAt: string;
  finishedAt: string;
  /** Populated when the run ended with 'fatal error', so callers can react to the cause. */
  abortedReason?: string;
}

export type StopReason =
  | 'verified: tests passing'
  | 'max iterations reached'
  | 'loop detected'
  | 'model stopped without tool call'
  | 'fatal error';

export interface TraceSink {
  (event: TraceEvent): void;
}

/**
 * Collects the full execution trace. The trace is both the UI feed and the
 * audit artifact written to disk, so a run can be replayed and diffed after
 * the fact instead of being lost in stdout.
 */
export class Tracer {
  private readonly events: TraceEvent[] = [];
  private readonly startTime = Date.now();

  constructor(private readonly sink?: TraceSink) {}

  get all(): readonly TraceEvent[] {
    return this.events;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  emit(event: Omit<TraceEvent, 'timestamp' | 'elapsedMs'>): TraceEvent {
    const full: TraceEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      elapsedMs: this.elapsedMs,
    };
    this.events.push(full);
    this.sink?.(full);
    return full;
  }

  /** Collapses repeated consecutive identical tool calls — useful summary metric. */
  toolCallSequence(): string[] {
    return this.events
      .filter((e) => e.category === 'action' && e.toolName)
      .map((e) => e.toolName as string);
  }
}
