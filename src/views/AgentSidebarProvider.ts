import * as vscode from 'vscode';

export interface TaskDescriptor {
  id: string;
  title: string;
  difficulty: string;
  bugClass: string;
}

export class AgentSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codebuddy.agentSidebar';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _tasks: TaskDescriptor[],
    private readonly _onRunRequested: (taskId: string) => void,
    private readonly _onResetRequested: (taskId: string) => void
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data?.type) {
        case 'RUN':
          this._onRunRequested(String(data.taskId));
          break;
        case 'RESET':
          this._onResetRequested(String(data.taskId));
          break;
      }
    });
  }

  public postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(): string {
    const taskOptions = this._tasks
      .map((t) => `<option value="${t.id}">${t.id} — ${t.title}</option>`)
      .join('\n      ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28));
    border-radius: 6px;
    padding: 10px;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .badge {
    font-size: 10px; font-family: monospace; padding: 2px 6px; border-radius: 4px;
    background: rgba(56,189,248,0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3);
  }
  .badge.ok { background: rgba(34,197,94,0.18); color: #4ade80; border-color: rgba(34,197,94,0.35); }
  .badge.bad { background: rgba(239,68,68,0.18); color: #f87171; border-color: rgba(239,68,68,0.35); }
  .badge.busy { background: rgba(245,158,11,0.18); color: #fbbf24; border-color: rgba(245,158,11,0.35); }
  label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  select, button { font-family: inherit; width: 100%; }
  select {
    margin-top: 4px; padding: 5px 6px; font-size: 11px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
  }
  .btns { display: flex; gap: 6px; margin-top: 8px; }
  button {
    flex: 1; padding: 6px 8px; border-radius: 4px; border: none; font-size: 11px;
    font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .primary { background: var(--vscode-button-background, #2563eb); color: var(--vscode-button-foreground, #fff); }
  .secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ddd); }
  .status { margin-top: 8px; font-size: 11px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
  .feed { display: flex; flex-direction: column; gap: 7px; max-height: 46vh; overflow-y: auto; }
  .ev {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.22));
    border-left-width: 3px;
    border-radius: 5px; padding: 7px 9px; font-size: 11px; line-height: 1.45;
    animation: fade .18s ease-out;
  }
  @keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .ev .hd { display: flex; justify-content: space-between; gap: 6px; font-weight: 600; font-size: 10px; margin-bottom: 3px; }
  .ev .bd { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
  .ev .mt { margin-top: 4px; font-size: 9.5px; color: var(--vscode-descriptionForeground); font-family: monospace; }
  .plan { border-left-color: #38bdf8; } .plan .hd { color: #38bdf8; }
  .memory { border-left-color: #c084fc; } .memory .hd { color: #c084fc; }
  .thought { border-left-color: #93c5fd; } .thought .hd { color: #93c5fd; }
  .action { border-left-color: #fbbf24; } .action .hd { color: #fbbf24; }
  .observation { border-left-color: #4ade80; } .observation .hd { color: #4ade80; }
  .observation.neg { border-left-color: #f87171; } .observation.neg .hd { color: #f87171; }
  .reflection { border-left-color: #60a5fa; } .reflection .hd { color: #60a5fa; }
  .error { border-left-color: #ef4444; } .error .hd { color: #ef4444; }
  .complete { border-left-color: #22c55e; } .complete .hd { color: #22c55e; }
  .term {
    background: var(--vscode-terminal-background, #1e1e1e);
    color: var(--vscode-terminal-foreground, #ccc);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28));
    border-radius: 4px; padding: 7px 8px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; line-height: 1.45; max-height: 150px; overflow: auto; white-space: pre-wrap;
  }
  .hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 6px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div class="row">
      <strong style="font-size:12px;">CodeBuddy ReAct Agent</strong>
      <span class="badge" id="stateBadge">idle</span>
    </div>
    <div style="margin-top:8px;">
      <label for="taskSelect">Repair task</label>
      <select id="taskSelect">
      ${taskOptions}
      </select>
    </div>
    <div class="btns">
      <button class="primary" id="runBtn">Run repair</button>
      <button class="secondary" id="resetBtn">Reset baseline</button>
    </div>
    <div class="status" id="statusLine">Select a task and run. The agent starts from the buggy baseline every time.</div>
  </div>

  <div>
    <div class="row" style="margin-bottom:6px;">
      <label>Test output (raw)</label>
      <span class="badge" id="testBadge">not run</span>
    </div>
    <div class="term" id="termBox">No test run yet.</div>
  </div>

  <div class="row">
    <label>Agent telemetry</label>
    <span style="font-size:10px;font-family:monospace;color:var(--vscode-descriptionForeground);" id="stepCounter">0 events</span>
  </div>
  <div class="feed" id="feed">
    <div class="ev plan">
      <div class="hd"><span>READY</span></div>
      <div class="bd">The agent plans, then acts through real tool calls. Every line below is produced by an actual model response or tool execution.</div>
    </div>
  </div>
  <div class="hint">Requires a Groq API key: set <code>codebuddy.groqApiKey</code> in Settings or GROQ_API_KEY in the workspace .env.</div>

<script>
  var vscode = acquireVsCodeApi();
  var feed = document.getElementById('feed');
  var termBox = document.getElementById('termBox');
  var testBadge = document.getElementById('testBadge');
  var stateBadge = document.getElementById('stateBadge');
  var statusLine = document.getElementById('statusLine');
  var stepCounter = document.getElementById('stepCounter');
  var runBtn = document.getElementById('runBtn');
  var resetBtn = document.getElementById('resetBtn');
  var taskSelect = document.getElementById('taskSelect');
  var eventCount = 0;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setBusy(busy) {
    runBtn.disabled = busy;
    resetBtn.disabled = busy;
    runBtn.textContent = busy ? 'Running...' : 'Run repair';
  }

  runBtn.addEventListener('click', function () {
    setBusy(true);
    feed.innerHTML = '';
    eventCount = 0;
    stepCounter.textContent = '0 events';
    vscode.postMessage({ type: 'RUN', taskId: taskSelect.value });
  });

  resetBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'RESET', taskId: taskSelect.value });
  });

  window.addEventListener('message', function (event) {
    var msg = event.data || {};

    if (msg.type === 'RUN_STATE') {
      var state = msg.state;
      stateBadge.className = 'badge' + (state === 'running' ? ' busy' : state === 'done' ? ' ok' : state === 'error' ? ' bad' : '');
      stateBadge.textContent = state;
      if (msg.detail) statusLine.textContent = msg.detail;
      setBusy(state === 'running');
      return;
    }

    if (msg.type === 'TEST_OUTPUT') {
      termBox.textContent = msg.output || '(no output)';
      testBadge.className = 'badge ' + (msg.passed ? 'ok' : 'bad');
      testBadge.textContent = msg.passed ? 'passing' : 'failing';
      return;
    }

    if (msg.type === 'TRACE_EVENT') {
      var ev = msg.event || {};
      eventCount++;
      stepCounter.textContent = eventCount + ' events';

      var node = document.createElement('div');
      var negative = ev.category === 'observation' && ev.ok === false;
      node.className = 'ev ' + ev.category + (negative ? ' neg' : '');

      var meta = [];
      if (ev.step) meta.push('step ' + ev.step);
      if (typeof ev.elapsedMs === 'number') meta.push((ev.elapsedMs / 1000).toFixed(1) + 's');
      if (ev.latencyMs) meta.push(ev.latencyMs + 'ms');
      if (ev.tokens) meta.push(ev.tokens.prompt + '+' + ev.tokens.completion + ' tok');

      var html = '<div class="hd"><span>' + esc(ev.title) + '</span><span>' + esc(ev.category) + '</span></div>';
      if (ev.content) html += '<div class="bd">' + esc(ev.content) + '</div>';
      if (meta.length) html += '<div class="mt">' + esc(meta.join(' · ')) + '</div>';
      node.innerHTML = html;

      feed.appendChild(node);
      feed.scrollTop = feed.scrollHeight;
    }
  });
</script>
</body>
</html>`;
  }
}
