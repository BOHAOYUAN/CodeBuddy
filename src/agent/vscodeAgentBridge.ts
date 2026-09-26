import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadConfig } from '../config';
import { createAgent } from './reactAgent';
import { TraceEvent } from './trace';
import { getTask, resetTask, TASKS, targetPath } from '../benchmark/tasks';
import { executeTestSuite } from '../tools/codeTools';

export type RunState = 'idle' | 'running' | 'done' | 'error';

export interface BridgeCallbacks {
  onEvent: (event: TraceEvent) => void;
  onRunState: (state: RunState, detail?: string) => void;
  onTestOutput: (payload: { output: string; passed: boolean }) => void;
  onLog: (message: string) => void;
}

/**
 * Bridges the VSCode sidebar to the real ReAct agent.
 *
 * The webview only renders events produced by an actual run — there is no
 * simulated feed. The test output shown in the panel is the raw output of the
 * command the agent executed.
 *
 * `extensionRoot` is deliberately used as the agent's workspace root instead of
 * the folder the user has open. The benchmark targets, their tests, the trace
 * files and the long-term memory all live inside this extension, so confining
 * the agent to the extension directory means a repair run can never write into
 * the user's project.
 */
export class VscodeAgentBridge {
  private busy = false;
  private activeDecorationType?: vscode.TextEditorDecorationType;

  constructor(
    private readonly extensionRoot: string,
    private readonly callbacks: BridgeCallbacks
  ) {}

  static listTasks() {
    return TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      difficulty: t.difficulty,
      bugClass: t.bugClass,
    }));
  }

  static baselineFor(taskId: string): string {
    return targetPath(taskId);
  }

  private readSettings(): {
    apiKey?: string;
    model?: string;
    maxIterations?: number;
    crossValidation?: boolean;
  } {
    try {
      const config = vscode.workspace.getConfiguration('codebuddy');
      return {
        apiKey: config.get<string>('groqApiKey') || undefined,
        model: config.get<string>('model') || undefined,
        maxIterations: config.get<number>('maxIterations') || undefined,
        crossValidation: config.get<boolean>('crossValidation') ?? undefined,
      };
    } catch {
      return {};
    }
  }

  async runRepair(taskId: string): Promise<void> {
    if (this.busy) {
      this.callbacks.onLog('A run is already in progress.');
      return;
    }

    const task = getTask(taskId);
    const settings = this.readSettings();

    const config = loadConfig({
      apiKey: settings.apiKey,
      workspaceRoot: this.extensionRoot,
      model: settings.model,
      maxIterations: settings.maxIterations,
    });
    if (settings.crossValidation !== undefined) {
      config.enableCrossValidation = settings.crossValidation;
    }

    if (!config.apiKey) {
      this.callbacks.onRunState(
        'error',
        'No Groq API key. Set codebuddy.groqApiKey in Settings, or put GROQ_API_KEY in the workspace .env file.'
      );
      return;
    }

    this.busy = true;
    this.callbacks.onRunState('running', `Repairing ${task.id} with ${config.model}`);

    try {
      resetTask(task.id);
      await this.openInEditor(path.join(this.extensionRoot, task.targetFile));

      const agent = createAgent({
        goal: task.goal,
        targetFile: task.targetFile,
        testCommand: task.testCommand,
        config,
        onEvent: (event) => this.callbacks.onEvent(event),
      });

      const { summary } = await agent.run();

      const testRun = executeTestSuite(task.testCommand, this.extensionRoot);
      const combined = `${testRun.output}\n${testRun.error || ''}`.trim();
      this.callbacks.onTestOutput({ output: combined, passed: summary.success });

      if (summary.success) {
        await this.highlightTarget(path.join(this.extensionRoot, task.targetFile));
      }

      this.callbacks.onRunState(
        summary.success ? 'done' : 'error',
        summary.success
          ? `Verified in ${summary.iterations} iteration(s), ${summary.toolCalls} tool call(s), ${summary.totalTokens} tokens, ${(summary.wallClockMs / 1000).toFixed(1)}s`
          : `Not verified: ${summary.stopReason}`
      );
    } catch (err) {
      this.callbacks.onRunState('error', (err as Error).message);
      this.callbacks.onLog(`Run failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  async resetTask(taskId: string): Promise<void> {
    try {
      resetTask(taskId);
      const task = getTask(taskId);
      await this.openInEditor(path.join(this.extensionRoot, task.targetFile));
      this.disposeDecoration();
      this.callbacks.onRunState('idle', `Restored the buggy baseline for ${taskId}`);
      this.callbacks.onTestOutput({
        output: 'Baseline restored. Run a repair to see the real failure output.',
        passed: false,
      });
    } catch (err) {
      this.callbacks.onLog(`Reset failed: ${(err as Error).message}`);
    }
  }

  private async openInEditor(absolutePath: string): Promise<void> {
    try {
      if (!fs.existsSync(absolutePath)) return;
      const document = await vscode.workspace.openTextDocument(absolutePath);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      // Opening the editor is a convenience, not a requirement.
    }
  }

  private async highlightTarget(absolutePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(absolutePath);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      this.disposeDecoration();

      this.activeDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(34, 197, 94, 0.18)',
        isWholeLine: true,
        border: '1px solid rgba(34, 197, 94, 0.4)',
      });

      const lastLine = Math.max(0, document.lineCount - 1);
      editor.setDecorations(this.activeDecorationType, [
        new vscode.Range(0, 0, lastLine, 0),
      ]);
    } catch {
      // Decoration is cosmetic.
    }
  }

  private disposeDecoration(): void {
    if (this.activeDecorationType) {
      this.activeDecorationType.dispose();
      this.activeDecorationType = undefined;
    }
  }
}
