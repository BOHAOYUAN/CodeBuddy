import { defineConfig } from 'vitest/config';

/**
 * Benchmark suite: the repair targets.
 *
 * These harnesses are the ground truth the agent is measured against, so this
 * suite is expected to be RED before a run — the bugs are the point. Run
 * `npm run eval` (or `npm start -- --task=<id>`) to have the agent fix them,
 * then re-run this config to confirm.
 */
export default defineConfig({
  test: {
    include: ['src/benchmark/targets/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
