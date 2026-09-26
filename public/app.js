
lucide.createIcons();

const BUGGY_CODE = `export interface TierRule {
  threshold: number;
  discount: number;
}

/**
 * Calculates final price based on tiered discount rules.
 * Contains subtle edge-case boundary bug and rounding glitch.
 */
export function calculateTieredDiscount(amount: number, tiers: TierRule[]): number {
  if (amount <= 0) return 0;

  // Sort tiers descending
  const sortedTiers = [...tiers].sort((a, b) => b.threshold - a.threshold);

  for (const tier of sortedTiers) {
    // BUG: uses > instead of >= causing boundary values to miss discount
    if (amount > tier.threshold) {
      // BUG: truncates floating point cents instead of proper rounding
      const finalPrice = Math.floor(amount - tier.discount);
      return finalPrice;
    }
  }

  return amount;
}
`;

const HEALED_CODE = `export interface TierRule {
  threshold: number;
  discount: number;
}

/**
 * Calculates final price based on tiered discount rules.
 * Verified and self-healed by CodeBuddy-Agent.
 */
export function calculateTieredDiscount(amount: number, tiers: TierRule[]): number {
  if (amount <= 0) return 0;

  // Sort tiers descending
  const sortedTiers = [...tiers].sort((a, b) => b.threshold - a.threshold);

  for (const tier of sortedTiers) {
    // FIX: Proper boundary condition >=
    if (amount >= tier.threshold) {
      // FIX: Maintain floating-point precision rounded to 2 decimals
      const rawPrice = amount - tier.discount;
      return Math.round(rawPrice * 100) / 100;
    }
  }

  return amount;
}
`;

const TEST_CODE = `import { describe, it, expect } from 'vitest';
import { calculateTieredDiscount, TierRule } from './tieredDiscount';

describe('calculateTieredDiscount', () => {
  const tiers: TierRule[] = [
    { threshold: 100, discount: 20 },
    { threshold: 200, discount: 50 },
  ];

  it('should apply discount when strictly above threshold', () => {
    expect(calculateTieredDiscount(150, tiers)).toBe(130);
  });

  it('should apply discount on EXACT boundary threshold (Edge Case)', () => {
    expect(calculateTieredDiscount(100, tiers)).toBe(80);
  });

  it('should handle floating point numbers accurately', () => {
    expect(calculateTieredDiscount(100.55, tiers)).toBe(80.55);
  });
});
`;

const FAILING_TERMINAL = `> npx vitest run src/benchmark/tieredDiscount.test.ts

 FAIL  src/benchmark/tieredDiscount.test.ts > calculateTieredDiscount > should apply discount on EXACT boundary threshold (Edge Case)
AssertionError: expected 100 to be 80 // Object.is equality
- Expected: 80
+ Received: 100

 FAIL  src/benchmark/tieredDiscount.test.ts > calculateTieredDiscount > should handle floating point numbers accurately
AssertionError: expected 80 to be 80.55 // Object.is equality
- Expected: 80.55
+ Received: 80

Test Files  1 failed (1)
     Tests  2 failed | 1 passed (3)
  Duration  198ms`;

const PASSING_TERMINAL = `> npx vitest run src/benchmark/tieredDiscount.test.ts

 ✓ src/benchmark/tieredDiscount.test.ts (3)
   ✓ calculateTieredDiscount > should apply discount when strictly above threshold
   ✓ calculateTieredDiscount > should apply discount on EXACT boundary threshold (Edge Case)
   ✓ calculateTieredDiscount > should handle floating point numbers accurately

Test Files  1 passed (1)
     Tests  3 passed (3)
  Duration  186ms
✨ [Success] All test assertions passing 100% green!`;

let editorInstance = null;
let currentFile = 'tieredDiscount.ts';

require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }});
require(['vs/editor/editor.main'], function() {
  editorInstance = monaco.editor.create(document.getElementById('monacoContainer'), {
    value: BUGGY_CODE,
    language: 'typescript',
    theme: 'vs-dark',
    fontFamily: 'Fira Code, monospace',
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderLineHighlight: 'all',
    tabSize: 2
  });

  document.getElementById('terminalOutput').textContent = FAILING_TERMINAL;
});

function switchFile(filename) {
  currentFile = filename;
  document.getElementById('activeFileName').textContent = filename;
  const tabMain = document.getElementById('tabTieredDiscount');
  const tabTest = document.getElementById('tabTieredTest');

  if (filename === 'tieredDiscount.ts') {
    tabMain.className = "pl-6 pr-2 py-1.5 rounded flex items-center space-x-2 cursor-pointer bg-blue-500/10 text-blue-300 font-mono text-[11px] border-l-2 border-blue-500";
    tabTest.className = "pl-6 pr-2 py-1.5 rounded flex items-center space-x-2 cursor-pointer hover:bg-codex-surface text-slate-400 font-mono text-[11px] transition";
    editorInstance.setValue(BUGGY_CODE);
  } else {
    tabTest.className = "pl-6 pr-2 py-1.5 rounded flex items-center space-x-2 cursor-pointer bg-blue-500/10 text-blue-300 font-mono text-[11px] border-l-2 border-blue-500";
    tabMain.className = "pl-6 pr-2 py-1.5 rounded flex items-center space-x-2 cursor-pointer hover:bg-codex-surface text-slate-400 font-mono text-[11px] transition";
    editorInstance.setValue(TEST_CODE);
  }
}

document.getElementById('tabTieredDiscount').addEventListener('click', () => switchFile('tieredDiscount.ts'));
document.getElementById('tabTieredTest').addEventListener('click', () => switchFile('tieredDiscount.test.ts'));

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function triggerAgent() {
  const feed = document.getElementById('agentFeed');
  const badge = document.getElementById('agentStatusBadge');
  const badgeText = document.getElementById('agentStatusText');
  const stepCounter = document.getElementById('stepCounter');
  const runBtn = document.getElementById('runAgentBtn');

  runBtn.disabled = true;
  runBtn.classList.add('opacity-50');

  badge.className = 'flex items-center space-x-1.5 px-2 py-0.5 rounded-full text-xs font-mono bg-blue-500/10 text-blue-400 border border-blue-500/30';
  badgeText.textContent = 'Agent Running...';
  feed.innerHTML = '';

  // Step 1
  stepCounter.textContent = 'Step 1/4';
  appendCard(feed, 'thought', 'Step 1: AST Extraction & Skeletons', 'Parsing AST structure with Babel. Pruning body blocks to protect LLM context limits.');
  await sleep(1000);
  appendCard(feed, 'action', 'Tool: ast_analyze_file', 'Extracted `calculateTieredDiscount` (lines 10-26). Token reduction: 68%.');
  await sleep(1000);

  // Step 2
  stepCounter.textContent = 'Step 2/4';
  appendCard(feed, 'thought', 'Step 2: Executing Diagnostic Tests', 'Invoking test harness to capture stack trace and failure modes.');
  await sleep(1000);
  appendCard(feed, 'observation', 'Tool: execute_test_suite', '2 Failures detected: \n- Boundary 100 missed (expected 80)\n- Precision truncated by Math.floor (expected 80.55)');
  await sleep(1200);

  // Step 3
  stepCounter.textContent = 'Step 3/4';
  appendCard(feed, 'thought', 'Step 3: Reflection & Patch Synthesis', 'Root causes isolated: replacing `>` with `>=` and replacing `Math.floor` with decimal rounding.');
  await sleep(1000);

  if (currentFile !== 'tieredDiscount.ts') switchFile('tieredDiscount.ts');
  editorInstance.setValue(HEALED_CODE);

  appendCard(feed, 'action', 'Tool: apply_code_patch', 'Surgical patch applied to lines 18-22 in tieredDiscount.ts.');
  await sleep(1200);

  // Step 4
  stepCounter.textContent = 'Step 4/4';
  appendCard(feed, 'thought', 'Step 4: Regression Verification', 'Re-executing test suite on patched codebase.');
  await sleep(1000);

  document.getElementById('terminalOutput').textContent = PASSING_TERMINAL;
  document.getElementById('testBadge').className = 'px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  document.getElementById('testBadge').textContent = 'All Tests Passing (3/3)';

  appendCard(feed, 'success', 'Task Completed 100% Green', 'Root cause cured! All 3 assertions passed without regressions.');

  badge.className = 'flex items-center space-x-1.5 px-2 py-0.5 rounded-full text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
  badgeText.textContent = 'Verified Green';

  runBtn.disabled = false;
  runBtn.classList.remove('opacity-50');
  lucide.createIcons();
}

function appendCard(container, type, title, detail) {
  const card = document.createElement('div');
  card.className = 'p-3 rounded-lg border text-xs leading-relaxed transition-all duration-300';

  if (type === 'thought') {
    card.classList.add('bg-blue-950/20', 'border-blue-500/30', 'text-blue-200');
    card.innerHTML = `<div class="flex items-center space-x-1.5 font-medium text-blue-400 mb-1"><i data-lucide="brain-circuit" class="w-3.5 h-3.5"></i><span>${title}</span></div><p class="text-slate-300 text-[11px]">${detail}</p>`;
  } else if (type === 'action') {
    card.classList.add('bg-purple-950/20', 'border-purple-500/30', 'text-purple-200');
    card.innerHTML = `<div class="flex items-center space-x-1.5 font-medium text-purple-400 mb-1"><i data-lucide="play-circle" class="w-3.5 h-3.5"></i><span>${title}</span></div><p class="font-mono text-purple-300 text-[11px]">${detail}</p>`;
  } else if (type === 'observation') {
    card.classList.add('bg-amber-950/20', 'border-amber-500/30', 'text-amber-200');
    card.innerHTML = `<div class="flex items-center space-x-1.5 font-medium text-amber-400 mb-1"><i data-lucide="eye" class="w-3.5 h-3.5"></i><span>${title}</span></div><pre class="font-mono text-amber-300/90 text-[10px] whitespace-pre-wrap">${detail}</pre>`;
  } else if (type === 'success') {
    card.classList.add('bg-emerald-950/30', 'border-emerald-500/40', 'text-emerald-200');
    card.innerHTML = `<div class="flex items-center space-x-1.5 font-bold text-emerald-400 mb-1"><i data-lucide="check-circle-2" class="w-4 h-4"></i><span>${title}</span></div><p class="text-emerald-300 text-[11px]">${detail}</p>`;
  }

  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  lucide.createIcons();
}

document.getElementById('runAgentBtn').addEventListener('click', triggerAgent);
document.getElementById('submitPromptBtn').addEventListener('click', triggerAgent);
document.getElementById('resetBtn').addEventListener('click', () => {
  editorInstance.setValue(BUGGY_CODE);
  document.getElementById('terminalOutput').textContent = FAILING_TERMINAL;
  document.getElementById('testBadge').className = 'px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/10 text-red-400 border border-red-500/20';
  document.getElementById('testBadge').textContent = 'Tests Failing (2)';
  document.getElementById('stepCounter').textContent = 'Step 0/4';
  document.getElementById('agentFeed').innerHTML = `
    <div class="p-3 rounded-lg bg-codex-surface border border-codex-border/60 text-slate-400 text-xs leading-relaxed">
      <p class="font-medium text-slate-200 mb-1 flex items-center space-x-1.5">
        <i data-lucide="sparkles" class="w-3.5 h-3.5 text-blue-400"></i>
        <span>Reset to Buggy Baseline</span>
      </p>
      Ready for another live demonstration run.
    </div>`;
  lucide.createIcons();
});
