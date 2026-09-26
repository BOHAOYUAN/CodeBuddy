import chalk from 'chalk';
import { RunSummary, TraceEvent } from '../agent/trace';

const GLYPH: Record<string, string> = {
  plan: 'PLAN ',
  memory: 'MEM  ',
  thought: 'THINK',
  action: 'ACT  ',
  observation: 'OBS  ',
  reflection: 'REFL ',
  error: 'ERR  ',
  complete: 'DONE ',
};

function paint(event: TraceEvent): (text: string) => string {
  switch (event.category) {
    case 'plan':
      return chalk.bold.cyan;
    case 'memory':
      return chalk.magenta;
    case 'thought':
      return chalk.white;
    case 'action':
      return chalk.yellow;
    case 'observation':
      return event.ok === false ? chalk.red : chalk.green;
    case 'reflection':
      return chalk.blueBright;
    case 'error':
      return chalk.red;
    case 'complete':
      return chalk.bold.green;
    default:
      return chalk.gray;
  }
}

function clip(text: string, max = 2200): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text;
}

export function renderTraceEvent(event: TraceEvent): void {
  const paintLine = paint(event);
  const stamp = chalk.gray(`[+${(event.elapsedMs / 1000).toFixed(1)}s]`);
  const step = chalk.gray(`#${String(event.step).padStart(2, '0')}`);

  console.log('');
  console.log(`${stamp} ${step} ${paintLine(`${GLYPH[event.category] || 'INFO '} ${event.title}`)}`);

  if (event.content) {
    const indented = clip(event.content)
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n');
    console.log(chalk.gray(indented));
  }

  if (event.tokens) {
    console.log(
      chalk.gray(
        `      · ${event.latencyMs ?? 0}ms · ${event.tokens.prompt} prompt + ${event.tokens.completion} completion tokens`
      )
    );
  }
}

export function renderSummary(summary: RunSummary): void {
  const ok = summary.success;
  const heading = ok ? chalk.bold.green('RUN VERIFIED') : chalk.bold.red('RUN NOT VERIFIED');
  const lines = [
    `  result          : ${heading} (${summary.stopReason})`,
    `  iterations      : ${summary.iterations}`,
    `  tool calls      : ${summary.toolCalls} (${summary.toolFailures} errors)`,
    `  llm calls       : ${summary.llmCalls}`,
    `  tokens          : ${summary.promptTokens} prompt + ${summary.completionTokens} completion = ${summary.totalTokens}`,
    `  cost            : $${summary.costUsd}`,
    `  llm latency     : ${(summary.llmLatencyMs / 1000).toFixed(1)}s`,
    `  pacing wait     : ${(summary.pacedMs / 1000).toFixed(1)}s (rate-limit budget)`,
    `  wall clock      : ${(summary.wallClockMs / 1000).toFixed(1)}s`,
    `  prompt context  : ${summary.contextCharsSent} chars sent`,
    `  AST pruning     : ${summary.tokenReductionPct}% smaller than reading the raw file`,
  ];

  console.log('');
  console.log(chalk.bold('─'.repeat(72)));
  console.log(chalk.bold(ok ? 'Task complete — verified by an independent test run' : 'Task ended without a verified fix'));
  console.log(lines.join('\n'));
  console.log(chalk.bold('─'.repeat(72)));
}

export function renderBanner(title: string, subtitle: string): void {
  console.log('');
  console.log(chalk.bold.cyan('═'.repeat(72)));
  console.log(chalk.bold.cyan(`  ${title}`));
  console.log(chalk.gray(`  ${subtitle}`));
  console.log(chalk.bold.cyan('═'.repeat(72)));
}
