import * as fs from 'fs';
import * as path from 'path';
import { ToolSchema } from '../llm/client';
import { analyzeCodeAST, CodeSkeleton } from './astAnalyzer';
import { applyCodePatch, executeTestSuite, readFileSlice, ToolResult } from './codeTools';

export interface ToolContext {
  workspaceRoot: string;
  maxObservationChars: number;
  /** Look up a previously learned lesson from long-term memory. */
  recall: (query: string, limit: number) => MemoryHit[];
}

export interface MemoryHit {
  goal: string;
  rootCause: string;
  lesson: string;
  rounds: number;
  createdAt: string;
}

export interface ToolDefinition {
  schema: ToolSchema;
  /** Executes the tool. Returning a string is treated as a successful observation. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolResult> | string | ToolResult;
}

/* ------------------------------------------------------------------ *
 * Minimal JSON Schema validator (structured-output validation layer).
 * Hand-rolled on purpose: zero runtime dependencies, and it makes the
 * validation rules explicit instead of hidden inside a library.
 * ------------------------------------------------------------------ */

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: SchemaNode,
  toolName: string
): void {
  const props = schema.properties || {};

  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null) {
      throw new SchemaValidationError(
        `Tool "${toolName}" is missing required argument "${key}". Expected one of: [${Object.keys(props).join(', ')}]`
      );
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) {
      throw new SchemaValidationError(
        `Tool "${toolName}" received unknown argument "${key}". Allowed: [${Object.keys(props).join(', ')}]`
      );
    }
    if (value === undefined || value === null) continue;

    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') {
          throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be a string, got ${typeof value}`);
        }
        break;
      case 'integer':
        if (!Number.isInteger(value)) {
          throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be an integer, got ${JSON.stringify(value)}`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be a number, got ${JSON.stringify(value)}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be a boolean, got ${typeof value}`);
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be an array`);
        }
        break;
      default:
        break;
    }

    if (spec.enum && !spec.enum.includes(value)) {
      throw new SchemaValidationError(
        `Argument "${key}" of "${toolName}" must be one of ${JSON.stringify(spec.enum)}, got ${JSON.stringify(value)}`
      );
    }
    if (spec.type === 'number' || spec.type === 'integer') {
      if (spec.minimum !== undefined && (value as number) < spec.minimum) {
        throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be >= ${spec.minimum}`);
      }
      if (spec.maximum !== undefined && (value as number) > spec.maximum) {
        throw new SchemaValidationError(`Argument "${key}" of "${toolName}" must be <= ${spec.maximum}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Path confinement
 * ------------------------------------------------------------------ */

export function resolveInsideWorkspace(workspaceRoot: string, relative: string): string {
  const absolute = path.resolve(workspaceRoot, relative);
  const rootResolved = path.resolve(workspaceRoot);
  const rel = path.relative(rootResolved, absolute);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SchemaValidationError(
      `Path "${relative}" escapes the workspace root. All file operations must stay inside ${rootResolved}.`
    );
  }
  return absolute;
}

/* ------------------------------------------------------------------ *
 * Tool implementations
 * ------------------------------------------------------------------ */

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n[... truncated ${text.length - maxChars} characters. Use read_file_slice with a line range to inspect the rest.]`
  );
}

function str(args: Record<string, unknown>, key: string): string {
  return String(args[key]);
}

function optionalNum(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  ast_analyze_file: {
    schema: {
      type: 'function',
      function: {
        name: 'ast_analyze_file',
        description:
          'Parse a TypeScript/JavaScript file and return its structural skeleton (imports, exports, function signatures with line ranges, classes and methods). ' +
          'Use this BEFORE reading raw source: it cuts prompt tokens by roughly 65% while preserving full architectural context.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file, relative to the workspace root. Example: src/benchmark/tieredDiscount.ts',
            },
          },
          required: ['filePath'],
        },
      },
    },
    handler: (args, ctx) => {
      const absolute = resolveInsideWorkspace(ctx.workspaceRoot, str(args, 'filePath'));
      const skeleton: CodeSkeleton = analyzeCodeAST(absolute);
      return clip(JSON.stringify(skeleton, null, 2), ctx.maxObservationChars);
    },
  },

  read_file_slice: {
    schema: {
      type: 'function',
      function: {
        name: 'read_file_slice',
        description:
          'Read a line range of a file with 1-based line numbers prefixed. Omitting startLine/endLine reads the whole file. ' +
          'Always read the exact region before patching it, so the patch anchor matches byte for byte.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path relative to the workspace root.' },
            startLine: { type: 'integer', description: 'First line to read (1-based).', minimum: 1 },
            endLine: { type: 'integer', description: 'Last line to read (inclusive).', minimum: 1 },
          },
          required: ['filePath'],
        },
      },
    },
    handler: (args, ctx) => {
      const absolute = resolveInsideWorkspace(ctx.workspaceRoot, str(args, 'filePath'));
      return clip(
        readFileSlice(absolute, optionalNum(args, 'startLine'), optionalNum(args, 'endLine')),
        ctx.maxObservationChars
      );
    },
  },

  list_workspace_files: {
    schema: {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description:
          'List source files under a directory of the workspace. Skips node_modules, .git, dist and hidden folders. ' +
          'Use this instead of shell commands such as ls, find or dir, which are not portable across platforms.',
        parameters: {
          type: 'object',
          properties: {
            dir: {
              type: 'string',
              description: 'Directory relative to the workspace root. Use "." for the workspace root.',
            },
            maxDepth: { type: 'integer', description: 'How deep to recurse (default 3).', minimum: 1, maximum: 6 },
          },
          required: [],
        },
      },
    },
    handler: (args, ctx) => {
      const dir = args.dir === undefined ? '.' : str(args, 'dir');
      const maxDepth = optionalNum(args, 'maxDepth') ?? 3;
      const root = resolveInsideWorkspace(ctx.workspaceRoot, dir);

      const IGNORED = new Set(['node_modules', '.git', 'dist', '.codebuddy', 'out', 'coverage']);
      const results: string[] = [];
      const LIMIT = 200;

      const walk = (current: string, depth: number): void => {
        if (depth > maxDepth || results.length >= LIMIT) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (results.length >= LIMIT) return;
          if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
          const absolute = path.join(current, entry.name);
          const relative = path.relative(ctx.workspaceRoot, absolute).split(path.sep).join('/');
          if (entry.isDirectory()) {
            results.push(`${relative}/`);
            walk(absolute, depth + 1);
          } else {
            let size = 0;
            try {
              size = fs.statSync(absolute).size;
            } catch {
              size = 0;
            }
            results.push(`${relative} (${size} bytes)`);
          }
        }
      };

      walk(root, 1);
      const suffix = results.length >= LIMIT ? `\n… truncated at ${LIMIT} entries` : '';
      return results.join('\n') + suffix || '(empty directory)';
    },
  },

  apply_code_patch: {
    schema: {
      type: 'function',
      function: {
        name: 'apply_code_patch',
        description:
          'Replace an exact text snippet inside a file. targetContent should be copied from what read_file_slice returned. ' +
          'Leading indentation is tolerated, but do not paraphrase or reflow the code: the snippet must otherwise be identical. ' +
          'If several places in the file match, the patch is refused. Prefer the smallest possible anchor.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path relative to the workspace root.' },
            targetContent: { type: 'string', description: 'Existing snippet to replace, copied verbatim from the file.' },
            replacementContent: { type: 'string', description: 'New snippet that replaces it.' },
            rationale: { type: 'string', description: 'One sentence on why this change fixes the failure.' },
          },
          required: ['filePath', 'targetContent', 'replacementContent'],
        },
      },
    },
    handler: (args, ctx) => {
      const absolute = resolveInsideWorkspace(ctx.workspaceRoot, str(args, 'filePath'));
      const result = applyCodePatch(
        absolute,
        str(args, 'targetContent'),
        str(args, 'replacementContent')
      );

      if (!result.success) {
        return { success: false, output: '', error: result.error };
      }
      return result.output + (args.rationale ? ` Rationale: ${args.rationale}` : '');
    },
  },

  execute_test_suite: {
    schema: {
      type: 'function',
      function: {
        name: 'execute_test_suite',
        description:
          'Run a shell command inside the workspace and return its combined stdout/stderr plus the exit status. ' +
          'Used to execute the test suite and observe real failure output. A failing test run is normal output, not an error: ' +
          'the observation always contains what the command printed. ' +
          'The shell is Windows cmd.exe on this machine — do not use ls, pwd, cat, head, or find.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Command to run, e.g. "npx vitest run src/benchmark/targets/tieredDiscount.test.ts".',
            },
          },
          required: ['command'],
        },
      },
    },
    handler: (args, ctx) => {
      const command = str(args, 'command');
      const blocked = /\brm\s+-rf\b|\bformat\b|\bdel\s+\/[sq]\b/i;
      if (blocked.test(command)) {
        return {
          success: false,
          output: '',
          error: 'Command rejected by the safety filter: destructive operations are not permitted.',
        };
      }

      const result = executeTestSuite(command, ctx.workspaceRoot);
      const merged = [result.output, result.error].filter(Boolean).join('\n').trim();
      const status = result.success ? 'exit code 0' : 'non-zero exit (the command ran; read the output below)';

      return {
        success: true,
        output: `[${status}] $ ${command}\n${clip(merged || '(the command produced no output)', ctx.maxObservationChars)}`,
      };
    },
  },

  recall_memory: {
    schema: {
      type: 'function',
      function: {
        name: 'recall_memory',
        description:
          'Search long-term memory for lessons from previously solved tasks (root cause + fix pattern). ' +
          'Call this first when the failure looks similar to something already handled, to avoid re-deriving the same root cause.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are trying to diagnose, in a few keywords.' },
            limit: { type: 'integer', description: 'Maximum number of lessons to return.', minimum: 1, maximum: 10 },
          },
          required: ['query'],
        },
      },
    },
    handler: (args, ctx) => {
      const hits = ctx.recall(str(args, 'query'), optionalNum(args, 'limit') ?? 3);
      if (hits.length === 0) {
        return 'Long-term memory contains no matching lesson for this query.';
      }
      return JSON.stringify(hits, null, 2);
    },
  },
};

export function getToolSchemas(names?: string[]): ToolSchema[] {
  const keys = names && names.length ? names : Object.keys(TOOL_DEFINITIONS);
  return keys.map((key) => {
    const def = TOOL_DEFINITIONS[key];
    if (!def) throw new Error(`Unknown tool: ${key}`);
    return def.schema;
  });
}

export interface DispatchResult {
  ok: boolean;
  observation: string;
}

export async function dispatchTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext
): Promise<DispatchResult> {
  const definition = TOOL_DEFINITIONS[name];
  if (!definition) {
    return {
      ok: false,
      observation: `Unknown tool "${name}". Available tools: [${Object.keys(TOOL_DEFINITIONS).join(', ')}]`,
    };
  }

  let args: Record<string, unknown>;
  try {
    args = rawArguments && rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch (err) {
    return {
      ok: false,
      observation: `Arguments for "${name}" were not valid JSON: ${(err as Error).message}. Received: ${rawArguments.slice(0, 300)}`,
    };
  }

  try {
    validateAgainstSchema(args, definition.schema.function.parameters as SchemaNode, name);
  } catch (err) {
    return { ok: false, observation: `Argument validation failed. ${(err as Error).message}` };
  }

  try {
    const result = await definition.handler(args, ctx);
    if (typeof result === 'string') {
      return { ok: true, observation: result };
    }
    if (result.success) {
      return { ok: true, observation: result.output || '(tool returned no output)' };
    }
    // Surface whatever the tool actually produced: a real diagnostic beats a placeholder.
    const detail = (result.output || '').trim() || (result.error || '').trim();
    return { ok: false, observation: detail || 'Tool failed without producing a message' };
  } catch (err) {
    return { ok: false, observation: `Tool "${name}" threw: ${(err as Error).message}` };
  }
}

export function workspaceFileExists(workspaceRoot: string, relative: string): boolean {
  try {
    return fs.existsSync(resolveInsideWorkspace(workspaceRoot, relative));
  } catch {
    return false;
  }
}
