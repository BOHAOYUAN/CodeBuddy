import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { isDailyQuotaExhausted } from '../llm/client';
import { TASKS, RepairTask, resetTask } from '../benchmark/tasks';
import { createAgent } from '../agent/reactAgent';
import { RunSummary } from '../agent/trace';

export interface TaskResult {
  taskId: string;
  title: string;
  bugClass: string;
  difficulty: string;
  success: boolean;
  stopReason: string;
  iterations: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  llmLatencyMs: number;
  pacedMs: number;
  wallClockMs: number;
  tokenReductionPct: number;
  error?: string;
  abortedReason?: string;
  /** True when the provider's daily allowance ran out — the pass cannot continue. */
  quotaExhausted?: boolean;
}

export interface Aggregate {
  tasks: number;
  solved: number;
  successRatePct: number;
  /** Tasks that never really ran (crashed before/at the first LLM call). */
  errored: number;
  /** tasks - errored: the only runs a success rate may legitimately be computed over. */
  validRuns: number;
  /** Success rate over validRuns. This is the number to quote. */
  successRatePctValid: number;
  avgIterations: number;
  avgToolCalls: number;
  avgToolFailures: number;
  totalTokens: number;
  totalCostUsd: number;
  avgWallClockMs: number;
  avgLlmLatencyMs: number;
  tokenReductionPct: number;
}

export interface PassResult {
  passIndex: number;
  label: string;
  results: TaskResult[];
  aggregate: Aggregate;
}

export interface FilterOptions {
  taskIds?: string[];
  model?: string;
  maxIterations?: number;
  crossValidation?: boolean;
}

function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) options[match[1]] = match[2] ?? 'true';
  }
  return options;
}

/**
 * A run that crashed before doing any work is NOT a failure to solve the task -
 * it is a missing measurement. Counting it as "not solved" silently deflates the
 * success rate, and counting its 0 iterations inflates the efficiency averages.
 * Both effects made a broken pass look like a fast one.
 */
export function isUnrun(r: TaskResult): boolean {
  return (
    r.stopReason === 'environment unavailable' ||
    r.stopReason === 'fatal error' ||
    r.stopReason === 'harness error' ||
    (r.iterations === 0 && !r.success && r.totalTokens === 0)
  );
}

export function aggregate(results: TaskResult[]): Aggregate {
  const valid = results.filter((r) => !isUnrun(r));
  const errored = results.length - valid.length;
  const solved = valid.filter((r) => r.success).length;
  const safeAvg = (values: number[]) =>
    values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0;

  return {
    tasks: results.length,
    solved,
    // Raw rate kept for backwards compatibility; it is misleading when errored > 0.
    successRatePct: results.length ? Number(((solved / results.length) * 100).toFixed(1)) : 0,
    errored,
    validRuns: valid.length,
    successRatePctValid: valid.length ? Number(((solved / valid.length) * 100).toFixed(1)) : 0,
    // Efficiency is averaged over runs that actually ran.
    avgIterations: safeAvg(valid.map((r) => r.iterations)),
    avgToolCalls: safeAvg(valid.map((r) => r.toolCalls)),
    avgToolFailures: safeAvg(valid.map((r) => r.toolFailures)),
    totalTokens: valid.reduce((a, r) => a + r.totalTokens, 0),
    totalCostUsd: Number(valid.reduce((a, r) => a + r.costUsd, 0).toFixed(6)),
    avgWallClockMs: safeAvg(valid.map((r) => r.wallClockMs)),
    avgLlmLatencyMs: safeAvg(valid.map((r) => r.llmLatencyMs)),
    tokenReductionPct: safeAvg(valid.map((r) => r.tokenReductionPct)),
  };
}

export async function runTask(task: RepairTask, options: FilterOptions): Promise<TaskResult> {
  const config = loadConfig({
    model: options.model,
    maxIterations: options.maxIterations,
  });
  if (options.crossValidation !== undefined) {
    config.enableCrossValidation = options.crossValidation;
  }

  resetTask(task.id);

  const agent = createAgent({
    goal: task.goal,
    targetFile: task.targetFile,
    testCommand: task.testCommand,
    config,
  });

  const base = {
    taskId: task.id,
    title: task.title,
    bugClass: task.bugClass,
    difficulty: task.difficulty as string,
  };

  try {
    const { summary } = await agent.run();
    const quotaExhausted =
      summary.abortedReason !== undefined && isDailyQuotaExhausted(summary.abortedReason);

    return {
      ...base,
      ...pickSummary(summary),
      abortedReason: summary.abortedReason,
      quotaExhausted,
    };
  } catch (err) {
    return {
      ...base,
      ...emptySummary(),
      stopReason: 'harness error',
      error: (err as Error).message,
    };
  }
}

function emptySummary() {
  return {
    success: false,
    stopReason: '',
    iterations: 0,
    toolCalls: 0,
    toolFailures: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    llmLatencyMs: 0,
    pacedMs: 0,
    wallClockMs: 0,
    tokenReductionPct: 0,
  };
}

function pickSummary(summary: RunSummary) {
  return {
    success: summary.success,
    stopReason: summary.stopReason,
    iterations: summary.iterations,
    toolCalls: summary.toolCalls,
    toolFailures: summary.toolFailures,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    costUsd: summary.costUsd,
    llmLatencyMs: summary.llmLatencyMs,
    pacedMs: summary.pacedMs,
    wallClockMs: summary.wallClockMs,
    tokenReductionPct: summary.tokenReductionPct,
  };
}

export async function runPass(
  passIndex: number,
  label: string,
  results: TaskResult[]
): Promise<PassResult> {
  return { passIndex, label, results, aggregate: aggregate(results) };
}

function renderMarkdown(passes: PassResult[], model: string): string {
  const lines: string[] = [];
  const stamp = new Date().toISOString();

  lines.push('# CodeBuddy Agent — evaluation report');
  lines.push('');
  lines.push(`Generated: ${stamp}`);
  lines.push(`Model: \`${model}\``);
  lines.push('');

  for (const pass of passes) {
    lines.push(`## ${pass.label}`);
    lines.push('');
    lines.push('| Task | Bug class | Solved | Iterations | Tool calls | Tool errors | Tokens | Wall clock | Note |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of pass.results) {
      const note = r.quotaExhausted
        ? 'quota exhausted'
        : r.success
          ? ''
          : isUnrun(r)
            ? `DID NOT RUN — ${(r.abortedReason || r.error || r.stopReason).slice(0, 70)}`
            : r.stopReason;
      lines.push(
        `| ${r.taskId} | ${r.bugClass} | ${r.success ? 'yes' : 'no'} | ${r.iterations} | ` +
          `${r.toolCalls} | ${r.toolFailures} | ${r.totalTokens} | ${(r.wallClockMs / 1000).toFixed(1)}s | ${note} |`
      );
    }
    lines.push('');
    const a = pass.aggregate;
    const notRun = TASKS.length - pass.results.length;
    lines.push(
      `**Aggregate** — solved ${a.solved}/${a.validRuns} valid run(s)` +
        (a.errored > 0 ? `; **${a.errored} task(s) crashed and are excluded**` : '') +
        ` (${a.successRatePctValid}%), avg ${a.avgIterations} iterations, avg ${a.avgToolCalls} tool calls, ` +
        `${a.totalTokens} tokens total, $${a.totalCostUsd} total cost, ` +
        `avg ${(a.avgWallClockMs / 1000).toFixed(1)}s wall clock, ` +
        `${a.tokenReductionPct}% prompt-context reduction from AST pruning.`
    );
    if (a.errored > 0) {
      lines.push('');
      lines.push(
        `> **${a.errored} task(s) did not run.** They crashed before completing a first iteration, ` +
          `so they are excluded from the success rate and from every average above. Do not compare ` +
          `this pass against another pass unless both have the same number of valid runs.`
      );
    }
    if (pass.results.some((r) => r.quotaExhausted)) {
      lines.push('');
      lines.push(
        '> **Pass incomplete.** The provider\'s daily token allowance ran out mid-pass. ' +
          'These figures cover only the tasks that completed; they are not a valid measure of the ' +
          'agent on the unrun tasks.'
      );
    }
    lines.push('');
  }

  if (passes.length >= 2) {
    const first = passes[0].aggregate;
    const last = passes[passes.length - 1].aggregate;
    lines.push('## Effect of long-term memory');
    lines.push('');
    lines.push(
      `| Metric | ${passes[0].label} | ${passes[passes.length - 1].label} | Delta |`
    );
    lines.push('|---|---|---|---|');
    const row = (name: string, a: number, b: number) =>
      lines.push(`| ${name} | ${a} | ${b} | ${b - a > 0 ? '+' : ''}${Number((b - a).toFixed(2))} |`);
    row('avg iterations', first.avgIterations, last.avgIterations);
    row('avg tool calls', first.avgToolCalls, last.avgToolCalls);
    row('total tokens', first.totalTokens, last.totalTokens);
    row('avg wall clock (ms)', first.avgWallClockMs, last.avgWallClockMs);
    row('valid runs (n)', first.validRuns, last.validRuns);
    row('success rate over valid runs (%)', first.successRatePctValid, last.successRatePctValid);
    if (first.validRuns !== last.validRuns) {
      lines.push('');
      lines.push(
        `> **Not comparable.** The two passes have a different number of valid runs ` +
          `(${first.validRuns} vs ${last.validRuns}). Efficiency deltas above are computed over ` +
          `different sample sets and the success-rate delta is not a measurement of memory. ` +
          `Re-run until both passes have ${first.tasks} valid runs before drawing any conclusion.`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({});
  const model = args.model || config.model;

  const taskIds = args.tasks ? args.tasks.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const selected = taskIds ? TASKS.filter((t) => taskIds.includes(t.id)) : TASKS;
  const passes = Number(args.passes || 1);
  const maxIterations = args['max-iterations'] ? Number(args['max-iterations']) : undefined;
  const crossValidation = args['cross-validation'] === 'true' ? true : undefined;

  if (selected.length === 0) {
    console.error(`No tasks matched. Available: ${TASKS.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  if (args['reset-memory'] === 'true' && fs.existsSync(config.memoryFile)) {
    // Never destroy the store: keep a backup next to it.
    fs.copyFileSync(config.memoryFile, `${config.memoryFile}.bak`);
    fs.rmSync(config.memoryFile);
    console.log(`[eval] long-term memory reset (backup at ${config.memoryFile}.bak)`);
  }

  console.log(
    `[eval] model=${model} tasks=${selected.map((t) => t.id).join(',')} passes=${passes} ` +
      `maxIterations=${maxIterations ?? config.maxIterations} crossValidation=${crossValidation ?? config.enableCrossValidation}`
  );
  console.log('');

  const passResults: PassResult[] = [];
  let aborted = false;

  for (let pass = 1; pass <= passes && !aborted; pass++) {
    const label = passes === 1 ? 'Single pass' : `Pass ${pass}${pass === 1 ? ' (cold memory)' : ' (warm memory)'}`;
    console.log(`===== ${label} =====`);
    const results: TaskResult[] = [];

    for (const task of selected) {
      console.log(`--> ${task.id}: ${task.title}`);
      const result = await runTask(task, { model, maxIterations, crossValidation });
      results.push(result);
      console.log(
        `    ${result.success ? 'SOLVED ' : 'FAILED '} ` +
          `iterations=${result.iterations} tools=${result.toolCalls} ` +
          `tokens=${result.totalTokens} wall=${(result.wallClockMs / 1000).toFixed(1)}s ` +
          `stop="${result.stopReason}"${result.error ? ` error=${result.error}` : ''}`
      );

      if (result.quotaExhausted) {
        const remaining = selected.length - results.length;
        console.error(
          `    !! provider daily token quota exhausted. Aborting this pass: the remaining ` +
            `${remaining} task(s) cannot run on this account until the allowance resets.\n` +
            `       ${(result.abortedReason || '').split('\n')[0].slice(0, 220)}`
        );
        aborted = true;
        break;
      }
    }

    const passResult = await runPass(pass, label, results);
    passResults.push(passResult);
    console.log(
      `    aggregate: ${passResult.aggregate.solved}/${passResult.aggregate.tasks} solved, ` +
        `avg ${passResult.aggregate.avgIterations} iterations, ${passResult.aggregate.totalTokens} tokens`
    );
    console.log('');
  }

  const outDir = path.dirname(config.traceDir);
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'eval-report.json');

  // Archive the previous report before overwriting it. Evaluation runs are
  // expensive (minutes of LLM time each) and the old behaviour silently
  // destroyed every prior result on the next run.
  const historyDir = path.join(outDir, 'history');
  try {
    if (fs.existsSync(jsonPath)) {
      fs.mkdirSync(historyDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(jsonPath, path.join(historyDir, `eval-report-${stamp}.json`));
      const prevMd = path.join(outDir, 'eval-report.md');
      if (fs.existsSync(prevMd)) {
        fs.copyFileSync(prevMd, path.join(historyDir, `eval-report-${stamp}.md`));
      }
      console.log(`[eval] archived previous report to ${path.join(historyDir, `eval-report-${stamp}.json`)}`);
    }
  } catch (err) {
    console.warn(`[eval] could not archive previous report: ${(err as Error).message}`);
  }

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), model, passes: passResults }, null, 2),
    'utf-8'
  );

  const mdPath = path.join(outDir, 'eval-report.md');
  fs.writeFileSync(mdPath, renderMarkdown(passResults, model), 'utf-8');

  console.log(`[eval] wrote ${jsonPath}`);
  console.log(`[eval] wrote ${mdPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[eval] fatal:', err);
    process.exit(1);
  });
}
