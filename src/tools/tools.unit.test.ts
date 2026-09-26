import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  dispatchTool,
  getToolSchemas,
  resolveInsideWorkspace,
  SchemaValidationError,
  validateAgainstSchema,
  ToolContext,
} from './registry';
import { applyCodePatch, readFileSlice } from './codeTools';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-tools-'));
}

function context(workspaceRoot: string): ToolContext {
  return { workspaceRoot, maxObservationChars: 4000, recall: () => [] };
}

const sampleSchema = {
  type: 'object',
  properties: {
    filePath: { type: 'string' },
    startLine: { type: 'integer', minimum: 1 },
    mode: { type: 'string', enum: ['read', 'write'] },
  },
  required: ['filePath'],
};

describe('validateAgainstSchema', () => {
  it('accepts a valid argument object', () => {
    expect(() =>
      validateAgainstSchema({ filePath: 'a.ts', startLine: 2, mode: 'read' }, sampleSchema, 'demo')
    ).not.toThrow();
  });

  it('names the missing argument and the tool when a required field is absent', () => {
    expect(() => validateAgainstSchema({}, sampleSchema, 'demo')).toThrowError(
      /demo.*missing required argument "filePath"/
    );
  });

  it('rejects unknown arguments instead of ignoring them', () => {
    expect(() =>
      validateAgainstSchema({ filePath: 'a.ts', nonsense: 1 }, sampleSchema, 'demo')
    ).toThrowError(/unknown argument "nonsense"/);
  });

  it('rejects a wrong type', () => {
    expect(() =>
      validateAgainstSchema({ filePath: 'a.ts', startLine: 'two' }, sampleSchema, 'demo')
    ).toThrowError(/must be an integer/);
  });

  it('enforces enum membership', () => {
    expect(() =>
      validateAgainstSchema({ filePath: 'a.ts', mode: 'delete' }, sampleSchema, 'demo')
    ).toThrowError(/must be one of/);
  });

  it('enforces numeric bounds', () => {
    expect(() =>
      validateAgainstSchema({ filePath: 'a.ts', startLine: 0 }, sampleSchema, 'demo')
    ).toThrowError(/must be >= 1/);
  });

  it('reports the tool name on every failure so the model can correct itself', () => {
    try {
      validateAgainstSchema({}, sampleSchema, 'my_tool');
      throw new Error('expected a validation error');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as Error).message).toContain('my_tool');
    }
  });
});

describe('resolveInsideWorkspace', () => {
  it('resolves a nested relative path under the root', () => {
    const root = tempDir();
    const resolved = resolveInsideWorkspace(root, 'src/deep/file.ts');
    expect(resolved.startsWith(path.resolve(root))).toBe(true);
  });

  it('refuses a path that escapes the workspace', () => {
    const root = tempDir();
    expect(() => resolveInsideWorkspace(root, '../outside.txt')).toThrowError(/escapes the workspace/);
  });

  it('refuses an absolute path pointing outside the workspace', () => {
    const root = tempDir();
    const outside = path.join(os.tmpdir(), 'definitely-outside.txt');
    expect(() => resolveInsideWorkspace(root, outside)).toThrowError(/escapes the workspace/);
  });
});

describe('getToolSchemas', () => {
  it('exposes every tool with a name, description and object parameter schema', () => {
    const schemas = getToolSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(6);

    for (const schema of schemas) {
      expect(schema.type).toBe('function');
      expect(schema.function.name).toMatch(/^[a-z_]+$/);
      expect((schema.function.description || '').length).toBeGreaterThan(20);
      expect(schema.function.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('keeps the mutating tool behind an explicit name', () => {
    const names = getToolSchemas().map((s) => s.function.name);
    expect(names).toContain('apply_code_patch');
    expect(names).toContain('recall_memory');
  });
});

describe('dispatchTool', () => {
  it('reports an unknown tool along with the available ones', async () => {
    const result = await dispatchTool('no_such_tool', '{}', context(tempDir()));
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('Unknown tool');
    expect(result.observation).toContain('ast_analyze_file');
  });

  it('reports malformed JSON arguments instead of throwing', async () => {
    const result = await dispatchTool('read_file_slice', '{not json', context(tempDir()));
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('not valid JSON');
  });

  it('reports schema violations before any handler runs', async () => {
    const result = await dispatchTool('read_file_slice', '{"filePath":123}', context(tempDir()));
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('Argument validation failed');
  });

  it('returns a structural skeleton for a real file', async () => {
    const root = tempDir();
    fs.writeFileSync(
      path.join(root, 'sample.ts'),
      'export function alpha(a: number): number {\n  return a + 1;\n}\n',
      'utf-8'
    );

    const result = await dispatchTool('ast_analyze_file', '{"filePath":"sample.ts"}', context(root));
    expect(result.ok).toBe(true);
    expect(result.observation).toContain('alpha');
  });

  it('refuses a destructive shell command', async () => {
    const result = await dispatchTool(
      'execute_test_suite',
      JSON.stringify({ command: 'rm -rf /' }),
      context(tempDir())
    );
    expect(result.ok).toBe(false);
    expect(result.observation).toContain('safety filter');
  });

  it('lists workspace files without touching node_modules', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 1;\n', 'utf-8');
    fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), 'x\n', 'utf-8');

    const result = await dispatchTool('list_workspace_files', '{"dir":"."}', context(root));
    expect(result.ok).toBe(true);
    expect(result.observation).toContain('src/index.ts');
    expect(result.observation).not.toContain('node_modules');
  });
});

describe('applyCodePatch', () => {
  it('applies a byte-exact patch', () => {
    const root = tempDir();
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'const value = 1;\nreturn value;\n', 'utf-8');

    const result = applyCodePatch(file, 'const value = 1;', 'const value = 2;');

    expect(result.success).toBe(true);
    expect(result.matchedBy).toBe('exact');
    expect(fs.readFileSync(file, 'utf-8')).toContain('const value = 2;');
  });

  it('rescues a patch whose indentation drifted', () => {
    const root = tempDir();
    const file = path.join(root, 'b.ts');
    fs.writeFileSync(file, 'function f() {\n    if (a > b) {\n        return 1;\n    }\n}\n', 'utf-8');

    const result = applyCodePatch(
      file,
      'if (a > b) {\n  return 1;\n}',
      'if (a >= b) {\n  return 2;\n}'
    );

    expect(result.success).toBe(true);
    expect(result.matchedBy).toBe('line-normalized');
    expect(fs.readFileSync(file, 'utf-8')).toContain('if (a >= b)');
  });

  it('refuses to patch when the anchor matches more than one region', () => {
    const root = tempDir();
    const file = path.join(root, 'c.ts');
    fs.writeFileSync(file, 'if (x) {\n  return 1;\n}\n\nif (x) {\n  return 1;\n}\n', 'utf-8');

    const result = applyCodePatch(file, 'if (x) {\n  return 1;\n}', 'if (y) {\n  return 2;\n}');

    expect(result.success).toBe(false);
    expect(result.error).toContain('matches 2 different regions');
    // The file must be untouched: guessing which occurrence was meant is worse than failing.
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('if (y)');
  });

  it('applies the patch once the anchor is made unique', () => {
    const root = tempDir();
    const file = path.join(root, 'c2.ts');
    fs.writeFileSync(file, 'if (x) {\n  return 1;\n}\n\nif (x) {\n  return 2;\n}\n', 'utf-8');

    const result = applyCodePatch(file, 'if (x) {\n  return 2;\n}', 'if (y) {\n  return 3;\n}');

    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('if (y) {\n  return 3;\n}');
    expect(fs.readFileSync(file, 'utf-8')).toContain('if (x) {\n  return 1;\n}');
  });

  it('returns a nearby hint when the anchor is genuinely absent', () => {
    const root = tempDir();
    const file = path.join(root, 'd.ts');
    fs.writeFileSync(file, 'export function target(amount: number) {\n  return amount;\n}\n', 'utf-8');

    const result = applyCodePatch(file, 'return amount * 2;', 'return amount * 3;');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('reports a missing file rather than throwing', () => {
    const result = applyCodePatch(path.join(tempDir(), 'nope.ts'), 'a', 'b');
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });
});

describe('readFileSlice', () => {
  it('prefixes each line with its 1-based number', () => {
    const root = tempDir();
    const file = path.join(root, 'e.ts');
    fs.writeFileSync(file, 'one\ntwo\nthree\n', 'utf-8');

    const slice = readFileSlice(file, 2, 3);
    expect(slice).toBe('2 | two\n3 | three');
  });

  it('throws for a missing file', () => {
    expect(() => readFileSlice(path.join(tempDir(), 'missing.ts'))).toThrowError(/does not exist/);
  });
});

describe('end-to-end tool context', () => {
  it('threads long-term memory recall through the tool layer', async () => {
    const ctx: ToolContext = {
      workspaceRoot: tempDir(),
      maxObservationChars: 1000,
      recall: () => [
        {
          goal: 'fix boundary comparison',
          rootCause: 'used > instead of >=',
          lesson: 'treat equality as inclusive',
          rounds: 3,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const result = await dispatchTool('recall_memory', '{"query":"boundary"}', ctx);
    expect(result.ok).toBe(true);
    expect(result.observation).toContain('used > instead of >=');
  });
});
