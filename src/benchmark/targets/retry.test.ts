import { describe, it, expect } from 'vitest';
import { nextDelay, shouldRetry, RetryPolicy } from './retry';

const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };

// jitter() === 0.5 maps to a factor of exactly 1, so the expected delay is exact.
const noJitter = () => 0.5;

describe('nextDelay', () => {
  it('grows exponentially with each attempt', () => {
    expect(nextDelay(policy, 1, noJitter)).toBe(100);
    expect(nextDelay(policy, 2, noJitter)).toBe(200);
    expect(nextDelay(policy, 3, noJitter)).toBe(400);
    expect(nextDelay(policy, 4, noJitter)).toBe(800);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(nextDelay(policy, 5, noJitter)).toBe(1000);
    expect(nextDelay(policy, 9, noJitter)).toBe(1000);
  });

  it('applies jitter within the documented [0.75, 1.25] band', () => {
    expect(nextDelay(policy, 1, () => 0)).toBe(75);
    expect(nextDelay(policy, 1, () => 1)).toBe(125);
  });

  it('returns 0 for non-positive attempts', () => {
    expect(nextDelay(policy, 0, noJitter)).toBe(0);
    expect(nextDelay(policy, -3, noJitter)).toBe(0);
  });
});

describe('shouldRetry', () => {
  it('retries while attempts remain', () => {
    expect(shouldRetry(policy, 0)).toBe(true);
    expect(shouldRetry(policy, 4)).toBe(true);
  });

  it('stops once maxAttempts is reached', () => {
    expect(shouldRetry(policy, 5)).toBe(false);
  });
});
