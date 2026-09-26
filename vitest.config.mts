import { defineConfig } from 'vitest/config';

/**
 * Default suite: the agent framework's own unit tests.
 * These are deterministic and never touch the network, so `npm test` is always green.
 *
 * The benchmark (which intentionally starts from failing code) lives in
 * vitest.benchmark.config.mts and runs via `npm run test:benchmark`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
