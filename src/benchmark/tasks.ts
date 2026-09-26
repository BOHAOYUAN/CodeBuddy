import * as fs from 'fs';
import * as path from 'path';

export interface RepairTask {
  id: string;
  title: string;
  /** Category of defect — used to report which bug classes the agent handles. */
  bugClass: string;
  difficulty: 'easy' | 'medium' | 'hard';
  goal: string;
  /** Path relative to the workspace root. */
  targetFile: string;
  testCommand: string;
}

/**
 * Locates the benchmark directory across the three ways this code is executed:
 * `tsx src/...` (source tree), an esbuild bundle in `dist/`, and a compiled
 * `dist/` tree.
 */
function benchmarkRoot(): string {
  const candidates = [
    __dirname,
    path.resolve(__dirname, '..', 'src', 'benchmark'),
    path.resolve(__dirname, '..', '..', 'src', 'benchmark'),
    path.resolve(process.cwd(), 'src', 'benchmark'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'fixtures'))) return candidate;
  }
  return path.resolve(process.cwd(), 'src', 'benchmark');
}

const BENCHMARK_ROOT = benchmarkRoot();
const TARGETS_DIR = path.join(BENCHMARK_ROOT, 'targets');

export { BENCHMARK_ROOT, TARGETS_DIR };

/** The buggy baseline for each task lives in fixtures/ and is the single source of truth. */
export function fixturePath(taskId: string): string {
  return path.join(BENCHMARK_ROOT, 'fixtures', `${taskId}.buggy.txt`);
}

export function targetPath(taskId: string): string {
  return path.join(TARGETS_DIR, `${taskId}.ts`);
}

function relTarget(taskId: string): string {
  return `src/benchmark/targets/${taskId}.ts`;
}

/**
 * The benchmark harness must run under its own vitest config.
 *
 * The default config (`npm test`) deliberately covers only the framework unit
 * tests, so running the targets without `--config` would report "no test files
 * found" — and the agent's independent verification step would then always see a
 * non-zero exit and never mark a task solved.
 */
const BENCHMARK_VITEST_CONFIG = 'vitest.benchmark.config.mts';

function testCommandFor(taskId: string): string {
  return `npx vitest run --config ${BENCHMARK_VITEST_CONFIG} ${relTarget(taskId).replace(/\.ts$/, '.test.ts')}`;
}

export const TASKS: RepairTask[] = [
  {
    id: 'tieredDiscount',
    title: 'Tiered discount returns the wrong price',
    bugClass: 'boundary condition + floating point precision',
    difficulty: 'easy',
    goal:
      'The unit tests in src/benchmark/targets/tieredDiscount.test.ts fail. ' +
      'Make all of them pass without changing the tests.',
    targetFile: relTarget('tieredDiscount'),
    testCommand: testCommandFor('tieredDiscount'),
  },
  {
    id: 'pagination',
    title: 'Pagination returns overlapping pages',
    bugClass: 'off-by-one slice bounds + integer rounding',
    difficulty: 'medium',
    goal:
      'The unit tests in src/benchmark/targets/pagination.test.ts fail. ' +
      'Make all of them pass without changing the tests.',
    targetFile: relTarget('pagination'),
    testCommand: testCommandFor('pagination'),
  },
  {
    id: 'dedupe',
    title: 'Deduplication keeps the wrong entry and mutates its input',
    bugClass: 'wrong-wins on duplicate + caller-visible mutation',
    difficulty: 'medium',
    goal:
      'The unit tests in src/benchmark/targets/dedupe.test.ts fail. ' +
      'Make all of them pass without changing the tests.',
    targetFile: relTarget('dedupe'),
    testCommand: testCommandFor('dedupe'),
  },
  {
    id: 'retry',
    title: 'Retry backoff grows linearly instead of exponentially',
    bugClass: 'algorithmic: missing exponential growth + incorrect jitter model',
    difficulty: 'medium',
    goal:
      'The unit tests in src/benchmark/targets/retry.test.ts fail. ' +
      'Make all of them pass without changing the tests.',
    targetFile: relTarget('retry'),
    testCommand: testCommandFor('retry'),
  },
];

export function getTask(id: string): RepairTask {
  const task = TASKS.find((t) => t.id === id);
  if (!task) {
    throw new Error(`Unknown task "${id}". Available: ${TASKS.map((t) => t.id).join(', ')}`);
  }
  return task;
}

/**
 * Restores a target file to its buggy baseline so a run always starts from the
 * same state. This is what makes the benchmark repeatable rather than a one-shot demo.
 */
export function resetTask(taskId: string): void {
  const fixture = fixturePath(taskId);
  if (!fs.existsSync(fixture)) {
    throw new Error(`Missing buggy baseline for "${taskId}": ${fixture}`);
  }
  fs.mkdirSync(TARGETS_DIR, { recursive: true });
  fs.copyFileSync(fixture, targetPath(taskId));
}

export function resetAllTasks(): void {
  for (const task of TASKS) resetTask(task.id);
}
