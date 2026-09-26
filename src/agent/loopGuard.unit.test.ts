import { describe, it, expect } from 'vitest';
import { LoopGuard } from './loopGuard';

describe('LoopGuard', () => {
  it('stays quiet while the agent makes distinct calls', () => {
    const guard = new LoopGuard(3, 6);
    guard.record('ast_analyze_file', '{"filePath":"a.ts"}', 1);
    guard.record('execute_test_suite', '{"command":"npx vitest run a"}', 2);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"x"}', 3);

    expect(guard.inspect().looping).toBe(false);
  });

  it('detects an identical call repeated back to back', () => {
    const guard = new LoopGuard(3, 6);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"x"}', 1);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"x"}', 2);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"x"}', 3);

    const verdict = guard.inspect();
    expect(verdict.looping).toBe(true);
    if (verdict.looping) {
      expect(verdict.reason).toContain('same call');
      expect(verdict.repeatedSignature).toContain('apply_code_patch');
    }
  });

  it('treats whitespace-only differences inside arguments as the same call', () => {
    const guard = new LoopGuard(2, 6);
    guard.record('apply_code_patch', '{"targetContent":"if (a > b) {\\n  return 1;\\n}"}', 1);
    guard.record('apply_code_patch', '{"targetContent":"if (a >  b) {\\n\\treturn 1;\\n}"}', 2);

    expect(guard.inspect().looping).toBe(true);
  });

  it('treats reordered arguments as the same call', () => {
    const guard = new LoopGuard(2, 6);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"x"}', 1);
    guard.record('apply_code_patch', '{"targetContent":"x","filePath":"a.ts"}', 2);

    expect(guard.inspect().looping).toBe(true);
  });

  it('does not flag two genuinely different patches', () => {
    const guard = new LoopGuard(3, 6);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"x"}', 1);
    guard.record('apply_code_patch', '{"filePath":"a.ts","targetContent":"y"}', 2);

    expect(guard.inspect().looping).toBe(false);
  });

  it('detects a two-call cycle that makes no progress', () => {
    const guard = new LoopGuard(3, 6);
    for (let iteration = 1; iteration <= 6; iteration++) {
      guard.record(
        iteration % 2 === 1 ? 'read_file_slice' : 'execute_test_suite',
        `{"seq":${iteration % 2}}`,
        iteration
      );
    }

    const verdict = guard.inspect();
    expect(verdict.looping).toBe(true);
    if (verdict.looping) expect(verdict.reason).toContain('cycle');
  });

  it('does not flag a cycle once progress was recorded', () => {
    const guard = new LoopGuard(3, 6);
    for (let iteration = 1; iteration <= 6; iteration++) {
      guard.record(
        iteration % 2 === 1 ? 'read_file_slice' : 'execute_test_suite',
        `{"seq":${iteration % 2}}`,
        iteration
      );
    }
    guard.markProgress(6);

    expect(guard.iterationsWithoutProgress).toBe(0);
    expect(guard.inspect().looping).toBe(false);
  });
});
