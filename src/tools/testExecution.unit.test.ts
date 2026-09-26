import { describe, it, expect } from 'vitest';
import { executeTestSuite } from './codeTools';

/**
 * The distinction these tests pin down: a command that never started is not a
 * failing test. Conflating the two made the agent probe command spellings for
 * a dozen iterations while the loop guard reported "loop detected" - the run
 * looked like a model failure when the environment was simply refusing to
 * spawn a shell.
 */
describe('executeTestSuite failure classification', () => {
  it('reports a real failing command as a test failure, keeping its output', () => {
    const result = executeTestSuite('exit 3', process.cwd());
    if (result.error && /could not be started/i.test(result.error)) {
      // Environment cannot spawn a shell at all (locked-down sandbox). The
      // spawn-classification path is covered by the dedicated case below.
      expect(result.error).toMatch(/EBUSY|ENOENT|EACCES|EPERM/);
      return;
    }
    expect(result.success).toBe(false);
    expect(result.error).not.toMatch(/DID NOT RUN/);
  });

  it('labels an unstartable command as an environment failure, not a test failure', () => {
    // A non-existent shell is the portable way to force a spawn error.
    const result = executeTestSuite('echo hi', process.cwd(), { shell: 'definitely-not-a-real-shell-xyz' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/DID NOT RUN/);
    expect(result.error).toMatch(/environment failure/i);
    expect(result.error).toMatch(/will not help/i);
  });

  it('never invites the caller to retry a spawn failure', () => {
    const result = executeTestSuite('echo hi', process.cwd(), { shell: 'definitely-not-a-real-shell-xyz' });
    expect(result.error).toContain('stop probing');
  });
});
