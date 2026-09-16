import { runCodeBuddyAgent } from './agent/reactAgent';
import * as path from 'path';

async function main() {
  const goal = 'Inspect src/benchmark/tieredDiscount.ts, analyze why unit tests in src/benchmark/tieredDiscount.test.ts are failing, repair the bugs with apply_code_patch, and verify that test suite npx vitest run src/benchmark/tieredDiscount.test.ts passes 100% green.';
  const workspaceDir = path.resolve(__dirname, '..');

  await runCodeBuddyAgent(goal, workspaceDir);
}

main().catch((err) => {
  console.error('Fatal agent runtime error:', err);
});
