import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export function readFileSlice(filePath: string, startLine?: number, endLine?: number): string {
  if (!fs.existsSync(filePath)) {
    throw new Error('File does not exist: ' + filePath);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  const start = Math.max(1, startLine || 1);
  const end = Math.min(lines.length, endLine || lines.length);
  
  const sliced = lines.slice(start - 1, end);
  return sliced.map((line, idx) => (start + idx) + ' | ' + line).join('\n');
}

export function applyCodePatch(filePath: string, targetContent: string, replacementContent: string): ToolResult {
  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: 'File not found: ' + filePath };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const normalizedRaw = raw.replace(/\r\n/g, '\n');
  const normalizedTarget = targetContent.replace(/\r\n/g, '\n').trim();
  const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n');

  if (!normalizedRaw.includes(normalizedTarget)) {
    return {
      success: false,
      output: '',
      error: 'Target content snippet was not found in ' + path.basename(filePath) + '. Please read the file first to ensure exact line matching.'
    };
  }

  const patched = normalizedRaw.replace(normalizedTarget, normalizedReplacement);
  fs.writeFileSync(filePath, patched, 'utf-8');

  return {
    success: true,
    output: 'Successfully applied patch to ' + path.basename(filePath) + '.'
  };
}

export function executeTestSuite(command: string, cwd: string): ToolResult {
  try {
    const stdout = execSync(command, { cwd, encoding: 'utf-8', timeout: 30000 });
    return {
      success: true,
      output: stdout
    };
  } catch (err: any) {
    return {
      success: false,
      output: err.stdout ? String(err.stdout) : '',
      error: err.stderr ? String(err.stderr) : (err.message || 'Test suite failed')
    };
  }
}
