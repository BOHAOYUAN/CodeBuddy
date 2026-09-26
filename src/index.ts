import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { createAgent } from './agent/reactAgent';
import { getTask, resetTask, TASKS } from './benchmark/tasks';
import { renderBanner, renderSummary, renderTraceEvent } from './cli/renderer';

function parseArgs(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) options[match[1]] = match[2] ?? 'true';
  }
  return options;
}

const HELP = `
CodeBuddy Agent — autonomous ReAct code repair

  npx tsx src/index.ts [options]

Options
  --task=<id>            Repair task to run. Default: tieredDiscount
                         Available: ${TASKS.map((t) => t.id).join(', ')}
  --no-reset             Do not restore the target file to its buggy baseline first
  --model=<name>         Override the model
  --max-iterations=<n>   Override the iteration cap
  --cross-validation     Enable the second-model patch review gate
  --list                 List available tasks
  --help                 Show this message
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === 'true') {
    console.log(HELP);
    return;
  }

  if (args.list === 'true') {
    for (const task of TASKS) {
      console.log(`  ${task.id.padEnd(16)} [${task.difficulty}] ${task.title}  (${task.bugClass})`);
    }
    return;
  }

  const task = getTask(args.task || 'tieredDiscount');

  const config = loadConfig({ model: args.model });
  if (args['max-iterations']) config.maxIterations = Number(args['max-iterations']);
  if (args['cross-validation'] === 'true') config.enableCrossValidation = true;

  if (args['no-reset'] !== 'true') {
    resetTask(task.id);
  }

  renderBanner(
    'CodeBuddy Agent · autonomous ReAct repair',
    `task=${task.id} · model=${config.model} · workspace=${config.workspaceRoot}`
  );
  console.log(`  Goal: ${task.goal}`);

  const absoluteTarget = path.join(config.workspaceRoot, task.targetFile);
  if (!fs.existsSync(absoluteTarget)) {
    console.log(`  warning: target file ${task.targetFile} does not exist yet`);
  }

  const agent = createAgent({
    goal: task.goal,
    targetFile: task.targetFile,
    testCommand: task.testCommand,
    config,
    onEvent: renderTraceEvent,
  });

  const { summary } = await agent.run();
  renderSummary(summary);

  process.exitCode = summary.success ? 0 : 1;
}

main().catch((err) => {
  console.error('\nFatal agent runtime error:', err);
  process.exit(1);
});
