export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Computes the delay before the given attempt (1-based) is made.
 *
 * Contract:
 *  - delay = min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
 *  - the value above is then multiplied by a jitter factor in [0.75, 1.25]
 *  - attempt < 1 returns 0
 *
 * @param jitter Injectable randomness in [0, 1); defaults to Math.random so the
 *               behaviour is testable without patching global state.
 */
export function nextDelay(
  policy: RetryPolicy,
  attempt: number,
  jitter: () => number = Math.random
): number {
  if (attempt < 1) return 0;

  const raw = policy.baseDelayMs * attempt;
  const fixedJitter = Math.round(policy.baseDelayMs * 0.25);

  return raw + fixedJitter;
}

/** Returns true when another attempt should be made after `attemptsMade` failures. */
export function shouldRetry(policy: RetryPolicy, attemptsMade: number): boolean {
  return attemptsMade < policy.maxAttempts;
}
