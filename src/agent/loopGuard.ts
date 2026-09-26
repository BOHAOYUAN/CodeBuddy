export interface ActionSignature {
  toolName: string;
  argsHash: string;
  iteration: number;
}

export type LoopVerdict =
  | { looping: false }
  | { looping: true; reason: string; repeatedSignature: string };

function hash(input: string): string {
  // FNV-1a, 32-bit. Deterministic and dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function normalizeArgs(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs || '{}');
    // Whitespace inside string values varies between model calls; normalize it so
    // "the same patch, re-sent" is detected as a repeat.
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, walk(v)])
        );
      }
      return value;
    };
    return JSON.stringify(walk(parsed));
  } catch {
    return rawArgs.trim();
  }
}

/**
 * Detects the two failure modes that actually burn budget in production agents:
 *
 *  1. Identical retry — the model re-emits a byte-identical tool call, which will
 *     fail the same way it failed last time.
 *  2. Thrashing — the model alternates between the same two calls, making no
 *     forward progress even though no single call repeats back-to-back.
 *
 * Both are reported as explicit stops rather than being silently retried until
 * the iteration cap.
 */
export class LoopGuard {
  private readonly history: ActionSignature[] = [];
  /** Signature of the last tool call that actually changed workspace state. */
  private lastProgressIteration = 0;

  constructor(
    private readonly repeatThreshold = 3,
    private readonly thrashWindow = 6
  ) {}

  record(toolName: string, rawArgs: string, iteration: number): void {
    this.history.push({ toolName, argsHash: hash(normalizeArgs(rawArgs)), iteration });
  }

  /** Call when a tool produced a state change worth keeping (successful patch / passing tests). */
  markProgress(iteration: number): void {
    this.lastProgressIteration = iteration;
  }

  get iterationsWithoutProgress(): number {
    return this.history.length === 0 ? 0 : this.history[this.history.length - 1].iteration - this.lastProgressIteration;
  }

  inspect(): LoopVerdict {
    const tail = this.history.slice(-this.thrashWindow);
    if (tail.length < 2) return { looping: false };

    // 1. Identical call repeated N times in a row.
    const last = tail[tail.length - 1];
    let consecutive = 1;
    for (let i = tail.length - 2; i >= 0; i--) {
      if (tail[i].toolName === last.toolName && tail[i].argsHash === last.argsHash) {
        consecutive++;
      } else {
        break;
      }
    }
    if (consecutive >= this.repeatThreshold) {
      return {
        looping: true,
        reason:
          `The exact same call was issued ${consecutive} times in a row ` +
          `(${last.toolName}, args hash ${last.argsHash}). Repeating it will produce the same failure.`,
        repeatedSignature: `${last.toolName}:${last.argsHash}`,
      };
    }

    // 2. Two-call cycle with no intervening progress.
    if (tail.length >= 4 && this.iterationsWithoutProgress >= this.thrashWindow) {
      const a = tail[tail.length - 2];
      const b = tail[tail.length - 1];
      const beforeA = tail[tail.length - 4];
      const beforeB = tail[tail.length - 3];
      const isCycle =
        a.toolName === beforeA.toolName &&
        a.argsHash === beforeA.argsHash &&
        b.toolName === beforeB.toolName &&
        b.argsHash === beforeB.argsHash;
      if (isCycle) {
        return {
          looping: true,
          reason:
            `Detected a ${this.thrashWindow}-call cycle with no state change: ` +
            `${a.toolName} <-> ${b.toolName} repeated without any successful patch or passing test.`,
          repeatedSignature: `${a.toolName}<>${b.toolName}`,
        };
      }
    }

    return { looping: false };
  }
}
