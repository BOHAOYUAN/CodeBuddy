import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { RunSummary } from '../agent/trace';
import { isDailyQuotaExhausted } from '../llm/client';
import { TASKS } from '../benchmark/tasks';

/**
 * Rebuilds the run history from the trace files on disk.
 *
 * Every run writes `{ summary, events }` to `.codebuddy/traces/`, so the history
 * can be re-derived at any time without re-spending tokens. That matters because
 * the alternative — re-running the benchmark — costs a large slice of a free
 * tier's daily allowance.
 *
 * Usage: npm run eval:history
 */

interface TraceFile {
  summary: RunSummary;
  events: Array<{ category: string; content: string }>;
}

interface RunRecord {
  file: string;
  startedAt: string;
  taskId: string;
  success: boolean;
  stopReason: string;
  iterations: number;
  toolCalls: number;
  toolFailures: number;
  totalTokens: number;
  wallClockMs: number;
  tokenReductionPct: number;
  quotaExhausted: boolean;
}

function taskIdOf(summary: RunSummary): string {
  const match = /targets[/\\]([A-Za-z0-9_]+)\.ts$/.exec(summary.targetFile || '');
  if (match) return match[1];
  return summary.targetFile || '(unknown)';
}

function loadRuns(traceDir: string): RunRecord[] {
  if (!fs.existsSync(traceDir)) return [];

  const files = fs
    .readdirSync(traceDir)
    .filter((name) => name.startsWith('run-') && name.endsWith('.json'))
    .sort();

  const records: RunRecord[] = [];

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf-8')) as TraceFile;
      const summary = parsed.summary;
      if (!summary) continue;

      // A quota abort is not a capability failure and must not be counted as one.
      const quotaExhausted =
        (summary.abortedReason !== undefined && isDailyQuotaExhausted(summary.abortedReason)) ||
        (parsed.events || []).some(
          (e) => e.category === 'error' && isDailyQuotaExhausted(e.content || '')
        );

      records.push({
        file,
        startedAt: summary.startedAt,
        taskId: taskIdOf(summary),
        success: summary.success,
        stopReason: summary.stopReason,
        iterations: summary.iterations,
        toolCalls: summary.toolCalls,
        toolFailures: summary.toolFailures,
        totalTokens: summary.totalTokens,
        wallClockMs: summary.wallClockMs,
        tokenReductionPct: summary.tokenReductionPct,
        quotaExhausted,
      });
    } catch {
      // A single unreadable trace must not break the history.
    }
  }

  return records;
}

function render(records: RunRecord[], traceDir: string): string {
  const lines: string[] = [];
  const scored = records.filter((r) => !r.quotaExhausted);
  const aborted = records.filter((r) => r.quotaExhausted);
  const solved = scored.filter((r) => r.success).length;
  const avg = (values: number[]) =>
    values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) : 0;

  lines.push('# CodeBuddy Agent — run history');
  lines.push('');
  lines.push(`Rebuilt from ${records.length} trace file(s) in \`${path.relative(process.cwd(), traceDir)}\``);
  lines.push(`at ${new Date().toISOString()}.`);
  lines.push('');

  lines.push('## Every persisted run, chronologically');
  lines.push('');
  lines.push('| Started | Task | Solved | Iterations | Tool calls | Tool errors | Tokens | Wall clock | Note |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const note = r.quotaExhausted
      ? 'did not complete: daily quota'
      : r.success
        ? ''
        : r.stopReason;
    lines.push(
      `| ${r.startedAt.replace('T', ' ').slice(0, 19)} | ${r.taskId} | ${r.success ? 'yes' : 'no'} | ` +
        `${r.iterations} | ${r.toolCalls} | ${r.toolFailures} | ${r.totalTokens} | ` +
        `${(r.wallClockMs / 1000).toFixed(1)}s | ${note} |`
    );
  }
  lines.push('');

  lines.push('## Aggregate over runs that actually completed');
  lines.push('');
  if (scored.length === 0) {
    lines.push('_No completed runs yet._');
  } else {
    lines.push(`- runs counted: ${scored.length} (excluded ${aborted.length} aborted by the daily quota)`);
    lines.push(`- solved: **${solved}/${scored.length} (${((solved / scored.length) * 100).toFixed(1)}%)**`);
    lines.push(`- avg iterations: ${avg(scored.map((r) => r.iterations))}`);
    lines.push(`- avg tool calls: ${avg(scored.map((r) => r.toolCalls))}`);
    lines.push(`- total tokens: ${scored.reduce((a, r) => a + r.totalTokens, 0)}`);
    lines.push(`- avg wall clock: ${(avg(scored.map((r) => r.wallClockMs)) / 1000).toFixed(1)}s`);
    lines.push(`- avg AST prompt-context reduction: ${avg(scored.map((r) => r.tokenReductionPct))}%`);
    lines.push('');
    lines.push('### Per-task (best run per task)');
    lines.push('');
    lines.push('| Task | Solved | Iterations | Tool calls | Tokens |');
    lines.push('|---|---|---|---|---|');
    for (const task of TASKS) {
      const runs = scored.filter((r) => r.taskId === task.id);
      if (runs.length === 0) {
        lines.push(`| ${task.id} | _not run_ | | | |`);
        continue;
      }
      const best = runs.find((r) => r.success) || runs[runs.length - 1];
      lines.push(
        `| ${task.id} | ${best.success ? 'yes' : 'no'} | ${best.iterations} | ${best.toolCalls} | ${best.totalTokens} |`
      );
    }
  }

  if (aborted.length > 0) {
    lines.push('');
    lines.push(
      `> ${aborted.length} run(s) were cut short by the provider's daily token allowance. ` +
        'They are excluded from the aggregate: a quota abort measures the account, not the agent.'
    );
  }

  return lines.join('\n');
}

function main() {
  const config = loadConfig({});
  const records = loadRuns(config.traceDir);

  if (records.length === 0) {
    console.error(`No traces found in ${config.traceDir}. Run \`npm run eval\` first.`);
    process.exit(1);
  }

  const markdown = render(records, config.traceDir);
  const outPath = path.join(path.dirname(config.traceDir), 'run-history.md');
  fs.writeFileSync(outPath, markdown, 'utf-8');

  console.log(markdown);
  console.log(`\n[history] wrote ${outPath}`);
}

main();
