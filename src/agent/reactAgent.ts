import * as fs from 'fs';
import { AgentConfig, assertApiKey } from '../config';
import { ChatMessage, LlmClient } from '../llm/client';
import { analyzeCodeAST } from '../tools/astAnalyzer';
import { executeTestSuite } from '../tools/codeTools';
import { dispatchTool, getToolSchemas, resolveInsideWorkspace, ToolContext } from '../tools/registry';
import { LoopGuard } from './loopGuard';
import { LongTermMemory, ShortTermMemory } from './memory';
import { RunSummary, StopReason, Tracer, TraceEvent, TraceSink } from './trace';

export interface AgentRunOptions {
  goal: string;
  targetFile: string;
  testCommand: string;
  config: AgentConfig;
  onEvent?: TraceSink;
  /** Extra guidance appended to the task briefing (used by the eval harness). */
  extraGuidance?: string;
}

interface PlanStep {
  index: number;
  intent: string;
  tool: string;
}

interface Plan {
  hypothesis: string;
  steps: PlanStep[];
}

const SYSTEM_PROMPT = `You are CodeBuddy, an autonomous code-repair agent inside a real workspace.

Work the ReAct loop: think, call exactly one tool, read the observation, decide again.
Never claim something is fixed until a tool has proven it.

TOOLS
- recall_memory(query, limit)          Lessons from previous repairs. Call first.
- ast_analyze_file(filePath)           Structural skeleton instead of raw source.
- list_workspace_files(dir, maxDepth)  List files. Use instead of ls/find/dir.
- read_file_slice(filePath, start, end)  Read exact lines with line numbers.
- apply_code_patch(filePath, targetContent, replacementContent)  Snippet replacement.
- execute_test_suite(command)          Run a command; returns output + exit status.

ORDER OF WORK
1. recall_memory for anything resembling this failure.
2. ast_analyze_file on the target. It gives signatures and line ranges for a fraction of the
   tokens of the raw file — never read a whole file when the skeleton is enough.
3. execute_test_suite to see the REAL failure output. Never guess what the tests assert.
4. read_file_slice on the exact region you will change.
5. apply_code_patch with the smallest anchor, copied from what you read.
6. execute_test_suite again. The run ends only when the tests pass for real.

ENVIRONMENT
- The shell is Windows cmd.exe: ls, pwd, cat, head and find do not exist. Use
  list_workspace_files and read_file_slice instead.
- A non-zero exit from execute_test_suite is normal — the tests ran and failed, and the
  observation still contains the full output. Diagnose from it.

RULES
- One tool call per turn.
- A doc comment above a function is its specification. If the implementation disagrees with it, the
  implementation is what is wrong — read the comment before deciding on a fix.
- Watch for parameters that are declared but never used: they usually mark the exact behaviour that
  was dropped.
- Do not paraphrase the code in targetContent. Indentation is tolerated; wording is not.
- If a patch did not fix the failure, diagnose again from the new output. Never resend the same patch.
- Do not fabricate test output. Only an execute_test_suite observation is evidence.
- When the tests genuinely pass, stop calling tools and reply with a short plain-text summary:
  root cause, the change made, how it was verified.`;

class LoopDetected extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'LoopDetected';
  }
}

export class ReActAgent {
  private readonly llm: LlmClient;
  private readonly memory: LongTermMemory;
  private readonly shortTerm: ShortTermMemory;
  private readonly loopGuard = new LoopGuard(3, 6);
  private readonly tracer: Tracer;
  private readonly observedFiles = new Map<string, number>();

  private toolCalls = 0;
  private toolFailures = 0;
  private llmLatencyMs = 0;
  private contextCharsSent = 0;
  private skeletonChars = 0;
  private fullFileChars = 0;

  constructor(
    private readonly options: AgentRunOptions,
    private readonly logger: (msg: string) => void = () => undefined
  ) {
    const { config } = options;
    assertApiKey(config);

    this.llm = new LlmClient(config, logger);
    this.memory = new LongTermMemory(config.memoryFile);
    this.shortTerm = new ShortTermMemory(readNumberEnv('AGENT_CONTEXT_CHARS', 9_000));
    this.tracer = new Tracer(options.onEvent);
  }

  get memorySize(): number {
    return this.memory.size;
  }

  get trace(): readonly TraceEvent[] {
    return this.tracer.all;
  }

  async run(): Promise<{ summary: RunSummary; finalAnswer: string }> {
    const startedMs = Date.now();
    const startedIso = new Date().toISOString();
    const { config } = this.options;

    this.emit({
      step: 0,
      iteration: 0,
      category: 'plan',
      title: 'Session started',
      content:
        `Goal: ${this.options.goal}\n` +
        `Target: ${this.options.targetFile}\n` +
        `Model: ${config.model}\n` +
        `Max iterations: ${config.maxIterations}`,
    });

    let success = false;
    let stopReason: StopReason = 'model stopped without tool call';
    let finalAnswer = '';
    let lastIteration = 0;
    let plan: Plan | undefined;
    let loopDetail: string | undefined;
    let abortedReason: string | undefined;

    try {
      plan = await this.plan();

      const toolCtx: ToolContext = {
        workspaceRoot: config.workspaceRoot,
        maxObservationChars: config.maxObservationChars,
        recall: (query, limit) => this.memory.recall(query, limit),
      };
      const tools = getToolSchemas();

      this.shortTerm.pin({ role: 'system', content: SYSTEM_PROMPT });
      this.shortTerm.pin({ role: 'user', content: this.buildTaskBriefing(plan) });

      for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
        lastIteration = iteration;

        const window = this.shortTerm.window();
        this.contextCharsSent += window.stats.charsKept;

        const completion = await this.llm.complete({
          messages: window.messages,
          tools,
          phase: `iteration ${iteration}`,
        });
        this.llmLatencyMs += completion.latencyMs;

        const assistant = completion.message;
        this.shortTerm.push(assistant);

        const calls = assistant.tool_calls || [];

        if (calls.length === 0) {
          finalAnswer = (assistant.content || '').trim();
          this.emit({
            step: iteration,
            iteration,
            category: 'thought',
            title: 'Agent stopped calling tools',
            content: finalAnswer || '(the model returned no text)',
            tokens: toTraceTokens(completion.usage),
            latencyMs: completion.latencyMs,
          });
          stopReason = 'model stopped without tool call';
          break;
        }

        for (const call of calls) {
          const { name, arguments: rawArgs } = call.function;
          this.toolCalls++;
          this.loopGuard.record(name, rawArgs, iteration);

          const verdict = this.loopGuard.inspect();
          if (verdict.looping) {
            loopDetail = verdict.reason;
            this.emit({
              step: iteration,
              iteration,
              category: 'error',
              title: 'Loop detected — stopping before burning more budget',
              content: verdict.reason,
            });
            throw new LoopDetected(verdict.reason);
          }

          this.emit({
            step: iteration,
            iteration,
            category: 'action',
            title: `Call tool · ${name}`,
            content: this.prettyArgs(rawArgs),
            toolName: name,
            toolArgs: rawArgs,
            tokens: toTraceTokens(completion.usage),
            latencyMs: completion.latencyMs,
          });

          const parsed = this.tryParse(rawArgs);

          if (name === 'ast_analyze_file') {
            this.trackSkeletonSaving(String(parsed.filePath || ''));
          }

          const gate = await this.crossValidate(name, parsed, iteration);
          if (gate) {
            this.toolFailures++;
            this.shortTerm.push({ role: 'tool', tool_call_id: call.id, name, content: gate });
            this.emit({
              step: iteration,
              iteration,
              category: 'observation',
              title: 'Blocked by cross-validation',
              content: gate,
              ok: false,
            });
            continue;
          }

          const result = await dispatchTool(name, rawArgs, toolCtx);

          // A non-zero exit from the test command is evidence, not an agent error.
          const isEvidenceTool = name === 'execute_test_suite';
          if (!result.ok && !isEvidenceTool) this.toolFailures++;
          if (result.ok && (name === 'apply_code_patch' || isEvidenceTool)) {
            this.loopGuard.markProgress(iteration);
          }

          this.shortTerm.push({ role: 'tool', tool_call_id: call.id, name, content: result.observation });

          this.emit({
            step: iteration,
            iteration,
            category: 'observation',
            title: result.ok ? `Result · ${name}` : `Tool error · ${name}`,
            content: result.observation,
            ok: result.ok,
          });

          if (name === 'apply_code_patch' && result.ok) {
            this.emit({
              step: iteration,
              iteration,
              category: 'reflection',
              title: 'Patch applied — verification still pending',
              content:
                'The workspace changed. An applied patch is not a fix until a fresh execute_test_suite run passes.',
            });
          }
        }
      }

      if (loopDetail) {
        stopReason = 'loop detected';
      } else if (lastIteration >= config.maxIterations) {
        stopReason = 'max iterations reached';
        this.emit({
          step: lastIteration,
          iteration: lastIteration,
          category: 'error',
          title: 'Iteration cap reached',
          content: `All ${config.maxIterations} iterations were used without a verified fix.`,
        });
      }
    } catch (err) {
      if (err instanceof LoopDetected) {
        stopReason = 'loop detected';
        loopDetail = err.detail;
      } else {
        stopReason = 'fatal error';
        abortedReason = (err as Error).message;
        this.emit({
          step: lastIteration,
          iteration: lastIteration,
          category: 'error',
          title: 'Run aborted',
          content: abortedReason,
        });
      }
    }

    // Verification is performed independently of whatever the model claimed.
    success = this.verify();
    if (success) stopReason = 'verified: tests passing';

    const reflection = await this.reflect(success, stopReason, plan);

    this.emit({
      step: lastIteration,
      iteration: lastIteration,
      category: 'complete',
      title: success ? 'Task complete — verified' : 'Ended without a verified fix',
      content:
        `${stopReason}. ${lastIteration} iteration(s), ${this.toolCalls} tool call(s), ` +
        `${this.toolFailures} tool error(s).` +
        (loopDetail ? `\n\nLoop detail: ${loopDetail}` : '') +
        `\n\n${finalAnswer || reflection}`,
    });

    if (success) {
      this.memory.remember({
        goal: this.options.goal,
        targetFile: this.options.targetFile,
        rootCause: reflection,
        lesson: reflection,
        rounds: lastIteration,
        createdAt: new Date().toISOString(),
        toolSequence: this.tracer.toolCallSequence(),
      });
    }

    const stats = this.llm.stats;
    const summary: RunSummary = {
      goal: this.options.goal,
      targetFile: this.options.targetFile,
      success,
      stopReason,
      iterations: lastIteration,
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
      llmCalls: stats.calls,
      promptTokens: stats.usage.promptTokens,
      completionTokens: stats.usage.completionTokens,
      totalTokens: stats.usage.totalTokens,
      costUsd: Number(stats.costUsd.toFixed(6)),
      llmLatencyMs: this.llmLatencyMs,
      pacedMs: stats.pacedMs,
      wallClockMs: Date.now() - startedMs,
      contextCharsSent: this.contextCharsSent,
      contextCharsIfNaiveRead: this.fullFileChars,
      tokenReductionPct:
        this.fullFileChars > 0
          ? Number((((this.fullFileChars - this.skeletonChars) / this.fullFileChars) * 100).toFixed(1))
          : 0,
      startedAt: startedIso,
      finishedAt: new Date().toISOString(),
      abortedReason,
    };

    this.persistTrace(summary);
    return { summary, finalAnswer };
  }

  /* ---------------------------------------------------------------- *
   * Phase 1 — planning
   * ---------------------------------------------------------------- */

  private async plan(): Promise<Plan> {
    const recalled = this.memory.recall(this.options.goal, 3);

    this.emit({
      step: 0,
      iteration: 0,
      category: 'memory',
      title: `Long-term memory · ${this.memory.size} record(s) on disk`,
      content:
        recalled.length > 0
          ? `Relevant lessons from previous runs:\n${recalled
              .map((r, i) => `${i + 1}. ${r.rootCause} (solved in ${r.rounds} round(s))`)
              .join('\n')}`
          : 'No matching prior repair. Reasoning from first principles.',
    });

    const completion = await this.llm.complete({
      phase: 'plan',
      temperature: 0,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'You are the planning module of an autonomous code-repair agent. Produce a short, concrete plan. ' +
            'Respond with JSON only, matching exactly: ' +
            '{"hypothesis": string, "steps": [{"index": number, "intent": string, "tool": string}]}. ' +
            'Allowed tool values: recall_memory, ast_analyze_file, list_workspace_files, read_file_slice, ' +
            'apply_code_patch, execute_test_suite. ' +
            `Use at most ${this.options.config.maxPlanSteps} steps and keep each intent under 12 words. ` +
            'Start with ast_analyze_file on the target, then execute_test_suite to observe the real failure.',
        },
        {
          role: 'user',
          content:
            `Goal: ${this.options.goal}\n` +
            `Target file: ${this.options.targetFile}\n` +
            `Verification command: ${this.options.testCommand}\n` +
            (recalled.length ? `Prior lessons: ${JSON.stringify(recalled)}` : ''),
        },
      ],
    });

    this.llmLatencyMs += completion.latencyMs;

    let plan: Plan = { hypothesis: 'Not derived', steps: [] };
    const raw = (completion.message.content || '{}').trim();
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      plan = {
        hypothesis: String(parsed.hypothesis || 'Not derived'),
        steps: Array.isArray(parsed.steps)
          ? parsed.steps
              .slice(0, this.options.config.maxPlanSteps)
              .map((s: Record<string, unknown>, i: number) => ({
                index: Number(s.index ?? i + 1),
                intent: String(s.intent ?? ''),
                tool: String(s.tool ?? ''),
              }))
          : [],
      };
    } catch {
      this.emit({
        step: 0,
        iteration: 0,
        category: 'error',
        title: 'Plan could not be parsed — continuing reactively',
        content: `The planning model returned non-JSON output: ${cleaned.slice(0, 200)}`,
      });
    }

    this.emit({
      step: 0,
      iteration: 0,
      category: 'plan',
      title: 'Plan',
      content:
        `Hypothesis: ${plan.hypothesis}\n` +
        (plan.steps.length
          ? plan.steps.map((s) => `${s.index}. ${s.intent} → ${s.tool}()`).join('\n')
          : '(no structured steps; proceeding reactively)'),
      tokens: toTraceTokens(completion.usage),
      latencyMs: completion.latencyMs,
    });

    return plan;
  }

  private buildTaskBriefing(plan: Plan): string {
    return (
      `TASK\n` +
      `Goal: ${this.options.goal}\n` +
      `Target file (relative to workspace root): ${this.options.targetFile}\n` +
      `Verification command: ${this.options.testCommand}\n\n` +
      `PLAN FROM THE PLANNING MODULE\n` +
      `Hypothesis: ${plan.hypothesis}\n` +
      (plan.steps.length
        ? plan.steps.map((s) => `${s.index}. ${s.intent} → ${s.tool}()`).join('\n')
        : '(none)') +
      `\n\nThe plan is a starting point, not a contract. Follow the observations when they disagree with the plan.` +
      (this.options.extraGuidance ? `\n\nADDITIONAL GUIDANCE\n${this.options.extraGuidance}` : '')
    );
  }

  /* ---------------------------------------------------------------- *
   * Optional second-model gate in front of the only mutating tool
   * ---------------------------------------------------------------- */

  private async crossValidate(
    toolName: string,
    parsed: Record<string, unknown>,
    iteration: number
  ): Promise<string | undefined> {
    if (toolName !== 'apply_code_patch' || !this.options.config.enableCrossValidation) {
      return undefined;
    }

    try {
      const completion = await this.llm.complete({
        phase: 'cross-validate',
        model: this.options.config.validatorModel,
        temperature: 0,
        maxTokens: 300,
        responseFormat: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You review a proposed code patch before it is written to disk. Respond with JSON only: ' +
              '{"approve": boolean, "reason": string}. Reject when the patch does not address the stated failure, ' +
              'or when it changes behaviour unrelated to the failing test.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              failureEvidence: this.lastTestEvidence(),
              target: parsed.filePath,
              replaces: parsed.targetContent,
              with: parsed.replacementContent,
              rationale: parsed.rationale,
            }),
          },
        ],
      });

      this.llmLatencyMs += completion.latencyMs;

      const verdict = JSON.parse(completion.message.content || '{}');
      if (verdict.approve !== true) {
        return (
          `Cross-validation by ${this.options.config.validatorModel} rejected this patch: ` +
          `${verdict.reason || 'no reason given'}. Gather more evidence or revise the patch.`
        );
      }

      this.emit({
        step: iteration,
        iteration,
        category: 'observation',
        title: 'Cross-validation approved',
        content: `Verdict from ${this.options.config.validatorModel}: approved.`,
      });
    } catch {
      this.logger('[agent] cross-validation skipped (validator call failed)');
    }

    return undefined;
  }

  private lastTestEvidence(): string {
    for (let i = this.tracer.all.length - 1; i >= 0; i--) {
      const event = this.tracer.all[i];
      if (event.toolName === 'execute_test_suite') return event.content.slice(0, 1500);
    }
    return '(no test run captured yet)';
  }

  /* ---------------------------------------------------------------- *
   * Phase 3 — reflection persisted to long-term memory
   * ---------------------------------------------------------------- */

  private async reflect(success: boolean, stopReason: StopReason, plan?: Plan): Promise<string> {
    try {
      const completion = await this.llm.complete({
        phase: 'reflect',
        temperature: 0,
        maxTokens: 400,
        responseFormat: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Write a post-mortem for a code-repair run. Respond with JSON only: ' +
              '{"rootCause": string, "lesson": string}. ' +
              'rootCause names the specific defect (max 25 words). lesson is a reusable heuristic for future runs (max 25 words).',
          },
          {
            role: 'user',
            content: JSON.stringify({
              goal: this.options.goal,
              success,
              stopReason,
              plannedHypothesis: plan?.hypothesis,
              toolSequence: this.tracer.toolCallSequence(),
              lastTestOutput: this.lastTestEvidence(),
            }),
          },
        ],
      });

      this.llmLatencyMs += completion.latencyMs;

      const parsed = JSON.parse(completion.message.content || '{}');
      const rootCause = String(parsed.rootCause || '').trim();
      const lesson = String(parsed.lesson || '').trim();
      const text = [rootCause, lesson].filter(Boolean).join(' — ');

      if (text) {
        this.emit({
          step: 0,
          iteration: 0,
          category: 'reflection',
          title: success ? 'Reflection committed to long-term memory' : 'Reflection (task not solved)',
          content: text,
        });
        return text;
      }
    } catch {
      // Reflection is best-effort and must never fail the run.
    }
    return success ? 'Task verified by an independent test run.' : `Run ended: ${stopReason}.`;
  }

  /* ---------------------------------------------------------------- *
   * Independent verification
   * ---------------------------------------------------------------- */

  private verify(): boolean {
    const result = executeTestSuite(this.options.testCommand, this.options.config.workspaceRoot);
    const combined = `${result.output}\n${result.error || ''}`.trim();
    const passed =
      result.success &&
      !/\b[1-9]\d*\s+failed\b/i.test(combined) &&
      !/\bFAIL\b/.test(combined) &&
      !/AssertionError/i.test(combined);

    this.emit({
      step: 0,
      iteration: 0,
      category: 'observation',
      title: passed ? 'Independent verification passed' : 'Independent verification failed',
      content: combined.slice(0, 2000) || '(no output)',
      ok: passed,
    });

    return passed;
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  private emit(event: Omit<TraceEvent, 'timestamp' | 'elapsedMs'>): TraceEvent {
    return this.tracer.emit(event);
  }

  private tryParse(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private prettyArgs(raw: string): string {
    const parsed = this.tryParse(raw);
    const keys = Object.keys(parsed);
    if (keys.length === 0) return raw || '(no arguments)';
    return keys
      .map((key) => {
        const value = parsed[key];
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
      })
      .join('\n');
  }

  /** Measures how much prompt context the AST skeleton saves versus the raw file. */
  private trackSkeletonSaving(relative: string): void {
    if (!relative || this.observedFiles.has(relative)) return;
    try {
      const absolute = resolveInsideWorkspace(this.options.config.workspaceRoot, relative);
      const fullSize = fs.statSync(absolute).size;
      const skeletonSize = JSON.stringify(analyzeCodeAST(absolute)).length;
      this.observedFiles.set(relative, fullSize);
      this.fullFileChars += fullSize;
      this.skeletonChars += skeletonSize;
    } catch {
      // Sizing is a metric, never a hard dependency.
    }
  }

  private persistTrace(summary: RunSummary): void {
    try {
      fs.mkdirSync(this.options.config.traceDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `${this.options.config.traceDir}/run-${stamp}.json`;
      fs.writeFileSync(file, JSON.stringify({ summary, events: this.tracer.all }, null, 2), 'utf-8');
      this.logger(`[agent] trace written to ${file}`);
    } catch {
      // Non-fatal.
    }
  }
}

function readNumberEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Maps the wire-level usage shape onto the compact shape stored in the trace. */
function toTraceTokens(usage: { promptTokens: number; completionTokens: number; totalTokens: number }) {
  return { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens };
}

export function createAgent(options: AgentRunOptions): ReActAgent {
  return new ReActAgent(options);
}

export type { ChatMessage };
