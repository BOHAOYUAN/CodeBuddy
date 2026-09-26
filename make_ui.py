import os

html_code = """<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeBuddy-IDE // Autonomous Code Review & Self-Healing Agent</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            codex: {
              bg: '#0D0E11',
              panel: '#131418',
              surface: '#1A1B20',
              border: '#2A2C34',
              accent: '#3B82F6',
              green: '#10B981',
              red: '#EF4444',
              orange: '#F59E0B',
              text: '#E2E8F0',
              muted: '#71717A'
            }
          },
          fontFamily: {
            mono: ['JetBrains Mono', 'Fira Code', 'Menlo', 'monospace'],
            sans: ['Inter', 'system-ui', 'sans-serif']
          }
        }
      }
    };
  </script>
  <link rel="stylesheet" data-name="vs/editor/editor.main" href="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/editor/editor.main.min.css">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    body { font-family: Inter, sans-serif; background-color: #0D0E11; color: #E2E8F0; overflow: hidden; }
    .font-mono { font-family: 'Fira Code', monospace; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #131418; }
    ::-webkit-scrollbar-thumb { background: #2A2C34; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #3B82F6; }
    .pulse-glow { box-shadow: 0 0 15px rgba(59, 130, 246, 0.4); }
  </style>
</head>
<body class="h-screen w-screen flex flex-col select-none">
  <!-- Top Titlebar -->
  <header class="h-10 bg-codex-bg border-b border-codex-border flex items-center justify-between px-3 z-30 shrink-0">
    <div class="flex items-center space-x-3">
      <div class="flex space-x-1.5">
        <div class="w-3 h-3 rounded-full bg-red-500/80"></div>
        <div class="w-3 h-3 rounded-full bg-yellow-500/80"></div>
        <div class="w-3 h-3 rounded-full bg-green-500/80"></div>
      </div>
      <div class="flex items-center space-x-2 pl-2 text-xs text-codex-muted border-l border-codex-border">
        <i data-lucide="cpu" class="w-3.5 h-3.5 text-blue-400"></i>
        <span class="font-medium text-slate-300">CodeBuddy IDE</span>
        <span class="text-slate-600">/</span>
        <span class="text-slate-400 font-mono text-[11px]">tieredDiscount.ts</span>
      </div>
    </div>
    <div class="flex items-center space-x-1 bg-codex-panel px-2.5 py-1 rounded border border-codex-border/60 text-xs text-codex-muted">
      <i data-lucide="layers" class="w-3.5 h-3.5 text-blue-400"></i>
      <span class="font-mono text-slate-300">ReAct Autonomous Self-Healing Environment</span>
    </div>
    <div class="flex items-center space-x-3">
      <div id="agentStatusBadge" class="flex items-center space-x-1.5 px-2 py-0.5 rounded-full text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        <span id="agentStatusText">Agent Ready</span>
      </div>
      <button id="resetBtn" class="flex items-center space-x-1 px-2.5 py-1 text-xs rounded bg-codex-surface hover:bg-codex-border border border-codex-border text-slate-300 transition">
        <i data-lucide="rotate-ccw" class="w-3 h-3"></i>
        <span>Reset Bug</span>
      </button>
      <button id="runAgentBtn" class="flex items-center space-x-1.5 px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white pulse-glow transition">
        <i data-lucide="zap" class="w-3.5 h-3.5"></i>
        <span>Auto-Repair (ReAct)</span>
      </button>
    </div>
  </header>

  <!-- Main Workbench -->
  <div class="flex-1 flex overflow-hidden">
    <!-- Left Activity Bar -->
    <aside class="w-12 bg-codex-bg border-r border-codex-border flex flex-col items-center py-3 space-y-5 text-codex-muted shrink-0">
      <button class="text-blue-400 p-1.5 rounded-lg bg-blue-500/10"><i data-lucide="files" class="w-5 h-5"></i></button>
      <button class="hover:text-white p-1.5 rounded-lg hover:bg-codex-surface"><i data-lucide="git-branch" class="w-5 h-5"></i></button>
      <button class="hover:text-white p-1.5 rounded-lg hover:bg-codex-surface"><i data-lucide="bot" class="w-5 h-5 text-purple-400"></i></button>
      <div class="flex-1"></div>
      <button class="hover:text-white p-1.5 rounded-lg hover:bg-codex-surface"><i data-lucide="settings" class="w-5 h-5"></i></button>
    </aside>

    <!-- File Explorer -->
    <div class="w-56 bg-codex-panel border-r border-codex-border flex flex-col shrink-0 text-xs">
      <div class="h-8 px-3 flex items-center justify-between text-codex-muted font-semibold tracking-wider uppercase text-[10px] border-b border-codex-border/40">
        <span>Workspace</span>
        <i data-lucide="folder-code" class="w-3.5 h-3.5"></i>
      </div>
      <div class="p-2 space-y-0.5">
        <div class="text-slate-400 font-mono text-[11px] px-2 py-1 flex items-center space-x-1.5 font-semibold">
          <i data-lucide="chevron-down" class="w-3 h-3"></i>
          <span>src / benchmark</span>
        </div>
        <div id="tabTieredDiscount" class="pl-6 pr-2 py-1.5 rounded flex items-center space-x-2 cursor-pointer bg-blue-500/10 text-blue-300 font-mono text-[11px] border-l-2 border-blue-500">
          <i data-lucide="file-code-2" class="w-3.5 h-3.5 text-blue-400"></i>
          <span class="truncate">tieredDiscount.ts</span>
        </div>
        <div id="tabTieredTest" class="pl-6 pr-2 py-1.5 rounded flex items-center space-x-2 cursor-pointer hover:bg-codex-surface text-slate-400 font-mono text-[11px] transition">
          <i data-lucide="test-tube-2" class="w-3.5 h-3.5 text-yellow-400"></i>
          <span class="truncate">tieredDiscount.test.ts</span>
        </div>
      </div>
    </div>

    <!-- Center Code Editor -->
    <main class="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
      <div class="h-8 bg-codex-bg border-b border-codex-border flex items-center px-1 text-xs shrink-0">
        <div class="h-full px-3 flex items-center space-x-2 bg-[#1e1e1e] border-t-2 border-blue-500 text-slate-200 font-mono text-[11px]">
          <i data-lucide="file-code-2" class="w-3.5 h-3.5 text-blue-400"></i>
          <span id="activeFileName">tieredDiscount.ts</span>
        </div>
      </div>
      <div id="monacoContainer" class="flex-1 w-full h-full"></div>

      <!-- Mini Terminal -->
      <div class="h-44 bg-codex-panel border-t border-codex-border flex flex-col shrink-0">
        <div class="h-7 px-3 flex items-center justify-between border-b border-codex-border/40 text-[11px] text-codex-muted bg-codex-bg">
          <span class="text-slate-300 font-medium flex items-center space-x-1">
            <i data-lucide="terminal" class="w-3 h-3 text-blue-400"></i>
            <span>Terminal & Test Harness (Vitest)</span>
          </span>
          <span id="testBadge" class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">Tests Failing (2)</span>
        </div>
        <pre id="terminalOutput" class="flex-1 p-3 overflow-y-auto font-mono text-[11px] text-slate-300 leading-relaxed"></pre>
      </div>
    </main>

    <!-- Right Codex Agent Deck -->
    <aside class="w-96 bg-codex-panel border-l border-codex-border flex flex-col shrink-0">
      <div class="h-10 px-4 flex items-center justify-between border-b border-codex-border text-xs">
        <div class="flex items-center space-x-2">
          <div class="w-5 h-5 rounded bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-[10px] border border-blue-500/30">AI</div>
          <span class="font-semibold text-slate-200">CodeBuddy Agent</span>
          <span class="text-[10px] font-mono text-codex-muted bg-codex-surface px-1.5 py-0.5 rounded border border-codex-border">ReAct Loop</span>
        </div>
        <span class="text-[11px] text-codex-muted font-mono" id="stepCounter">Step 0/4</span>
      </div>
      <div id="agentFeed" class="flex-1 p-3 overflow-y-auto space-y-3 font-sans text-xs">
        <div class="p-3 rounded-lg bg-codex-surface border border-codex-border/60 text-slate-400 text-xs leading-relaxed">
          <p class="font-medium text-slate-200 mb-1 flex items-center space-x-1.5">
            <i data-lucide="sparkles" class="w-3.5 h-3.5 text-blue-400"></i>
            <span>Ready for autonomous diagnosis</span>
          </p>
          Click <strong class="text-blue-400 font-mono">Auto-Repair (ReAct)</strong> above. The agent will inspect AST tokens, capture Vitest failure stack traces, synthesize a precise patch, and self-heal the codebase in real time.
        </div>
      </div>
      <div class="p-3 border-t border-codex-border bg-codex-bg">
        <div class="relative flex items-center">
          <input type="text" readonly value="Goal: Repair failing unit tests in tieredDiscount.ts" class="w-full bg-codex-surface border border-codex-border rounded-lg pl-3 pr-9 py-2 text-xs text-slate-300 font-mono focus:outline-none" />
          <button id="submitPromptBtn" class="absolute right-2 text-blue-400 hover:text-white transition"><i data-lucide="arrow-up-circle" class="w-5 h-5"></i></button>
        </div>
      </div>
    </aside>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.min.js"></script>
  <script src="app.js"></script>
</body>
</html>"""

with open('public/index.html', 'w', encoding='utf-8') as f:
    f.write(html_code)
print('Successfully generated public/index.html')

app_js = """
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
  appendCard(feed, 'observation', 'Tool: execute_test_suite', '2 Failures detected: \\n- Boundary 100 missed (expected 80)\\n- Precision truncated by Math.floor (expected 80.55)');
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
"""

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(app_js)
print('Successfully generated public/app.js')

