import { describe, it, expect } from 'vitest';
import { checkCommandEnvironment, executeTestSuite } from './codeTools';

/**
 * The preflight exists so a broken environment costs one spawn instead of the
 * whole iteration budget. On a machine that cannot start a shell, every command
 * used to look like a failing test; the agent then probed command spellings for
 * a dozen iterations and the run was reported as a model failure.
 */
describe('checkCommandEnvironment', () => {
  it('reports failure, with the reason, when no shell can be started', () => {
    const result = checkCommandEnvironment(process.cwd(), { shell: 'definitely-not-a-real-shell-xyz' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/DID NOT RUN/);
      expect(result.error).toMatch(/environment failure/i);
    }
  });

  it('does not treat a command that ran and failed as a broken environment', () => {
    // Only a spawn failure counts. A non-zero exit proves the environment works.
    const probe = executeTestSuite('exit 3', process.cwd());
    if (/DID NOT RUN/.test(probe.error || '')) {
      // This machine cannot spawn a shell at all, so the positive path is not
      // reachable here. The negative path is covered above.
      return;
    }
    expect(checkCommandEnvironment(process.cwd(), { command: 'exit 3' }).ok).toBe(true);
  });

  it('succeeds on a trivial command in a working environment', () => {
    const probe = executeTestSuite('echo ok', process.cwd());
    if (/DID NOT RUN/.test(probe.error || '')) return;
    expect(checkCommandEnvironment(process.cwd()).ok).toBe(true);
  });
});
