import * as vscode from 'vscode';
import { AgentSidebarProvider } from './views/AgentSidebarProvider';
import { VscodeAgentBridge } from './agent/vscodeAgentBridge';
import { TASKS } from './benchmark/tasks';

const LAST_TASK_KEY = 'codebuddy.lastTaskId';

export function activate(context: vscode.ExtensionContext) {
  // The agent is confined to the extension's own directory. The benchmark targets,
  // their tests, the trace files and long-term memory all live here, so a repair
  // run can never modify the folder the user has open.
  const extensionRoot = context.extensionUri.fsPath;

  const tasks = VscodeAgentBridge.listTasks();
  const defaultTaskId = context.workspaceState.get<string>(LAST_TASK_KEY) || tasks[0]?.id || 'tieredDiscount';

  let bridge: VscodeAgentBridge;

  const sidebarProvider = new AgentSidebarProvider(
    context.extensionUri,
    tasks,
    async (taskId) => {
      await context.workspaceState.update(LAST_TASK_KEY, taskId);
      await runWithFeedback(taskId);
    },
    async (taskId) => {
      await bridge.resetTask(taskId);
    }
  );

  bridge = new VscodeAgentBridge(extensionRoot, {
    onEvent: (event) => sidebarProvider.postMessage({ type: 'TRACE_EVENT', event }),
    onRunState: (state, detail) => sidebarProvider.postMessage({ type: 'RUN_STATE', state, detail }),
    onTestOutput: (payload) => sidebarProvider.postMessage({ type: 'TEST_OUTPUT', ...payload }),
    onLog: (message) => {
      sidebarProvider.postMessage({
        type: 'TRACE_EVENT',
        event: {
          step: 0,
          iteration: 0,
          category: 'error',
          title: 'Extension',
          content: message,
          timestamp: new Date().toISOString(),
          elapsedMs: 0,
        },
      });
    },
  });

  async function runWithFeedback(taskId: string): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `CodeBuddy: repairing ${taskId}...`, cancellable: false },
        async () => {
          await bridge.runRepair(taskId);
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`CodeBuddy: ${(err as Error).message}`);
    }
  }

  async function pickTask(): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      tasks.map((t) => ({
        label: t.id,
        description: `[${t.difficulty}] ${t.bugClass}`,
        detail: t.title,
        id: t.id,
      })),
      { title: 'CodeBuddy: choose a repair task', placeHolder: defaultTaskId }
    );
    if (!picked) return undefined;
    await context.workspaceState.update(LAST_TASK_KEY, picked.id);
    return picked.id;
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentSidebarProvider.viewType, sidebarProvider),

    vscode.commands.registerCommand('codebuddy.repairTask', async () => {
      const taskId = await pickTask();
      if (taskId) await runWithFeedback(taskId);
    }),

    vscode.commands.registerCommand('codebuddy.repairActiveTask', async () => {
      await runWithFeedback(context.workspaceState.get<string>(LAST_TASK_KEY) || defaultTaskId);
    }),

    vscode.commands.registerCommand('codebuddy.resetTask', async () => {
      const taskId = await pickTask();
      if (taskId) await bridge.resetTask(taskId);
    }),

    vscode.commands.registerCommand('codebuddy.listTasks', () => {
      const report = TASKS.map((t) => `${t.id}  [${t.difficulty}]  ${t.title}  (${t.bugClass})`).join('\n');
      vscode.window.showInformationMessage(`CodeBuddy tasks:\n${report}`, { modal: true });
    })
  );

  console.log(`CodeBuddy Agent activated. ${tasks.length} repair task(s) registered.`);
}

export function deactivate() {}
