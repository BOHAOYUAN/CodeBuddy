import { describe, it, expect } from 'vitest';
import { aggregate, isUnrun } from './run';
import type { TaskResult } from './run';

function result(overrides: Partial<TaskResult>): TaskResult {
  return {
    taskId: 'x',
    title: 'x',
    bugClass: 'x',
    difficulty: 'medium',
    success: false,
    stopReason: '',
    iterations: 0,
    toolCalls: 0,
    toolFailures: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 100,
    costUsd: 0,
    llmLatencyMs: 0,
    pacedMs: 0,
    wallClockMs: 1000,
    tokenReductionPct: 0,
    ...overrides,
  };
}

const solved = (iterations: number) =>
  result({ success: true, stopReason: 'verified: tests passing', iterations });
const crashed = (iterations: number) =>
  result({ stopReason: 'fatal error', iterations, totalTokens: iterations === 0 ? 0 : 100 });

describe('isUnrun', () => {
  it('flags explicit fatal errors', () => {
    expect(isUnrun(result({ stopReason: 'fatal error', iterations: 11 }))).toBe(true);
  });

  it('flags harness errors', () => {
    expect(isUnrun(result({ stopReason: 'harness error', iterations: 0 }))).toBe(true);
  });

  it('flags zero-token zero-iteration failures', () => {
    expect(isUnrun(result({ stopReason: 'model stopped without tool call', iterations: 0, totalTokens: 0 }))).toBe(true);
  });

  it('does NOT flag a run that genuinely tried and failed', () => {
    expect(isUnrun(result({ stopReason: 'max iterations reached', iterations: 11, totalTokens: 35673 }))).toBe(false);
  });
});

describe('aggregate', () => {
  it('excludes crashed runs from the success-rate denominator', () => {
    // Mirrors the real Pass 2: one solved, three crashed. Naive math says 25%,
    // the honest number over valid runs is 100%.
    const a = aggregate([solved(10), crashed(11), crashed(1), crashed(0)]);
    expect(a.tasks).toBe(4);
    expect(a.errored).toBe(3);
    expect(a.validRuns).toBe(1);
    expect(a.solved).toBe(1);
    expect(a.successRatePctValid).toBe(100);
    expect(a.successRatePct).toBe(25); // legacy field kept, now clearly misleading
  });

  it('does not let zero-iteration crashes deflate the iteration average', () => {
    const a = aggregate([solved(10), crashed(0)]);
    expect(a.avgIterations).toBe(10); // not 5
  });

  it('reports zero valid runs when everything crashed', () => {
    const a = aggregate([crashed(0), crashed(1)]);
    expect(a.validRuns).toBe(0);
    expect(a.successRatePctValid).toBe(0);
    expect(a.errored).toBe(2);
  });

  it('counts a genuine attempt-and-fail as a valid run', () => {
    const a = aggregate([solved(8), result({ stopReason: 'max iterations reached', iterations: 11, totalTokens: 35673 })]);
    expect(a.errored).toBe(0);
    expect(a.validRuns).toBe(2);
    expect(a.successRatePctValid).toBe(50);
  });
});
