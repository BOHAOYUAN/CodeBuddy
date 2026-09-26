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
  return sliced.map((line: string, idx: number) => (start + idx) + ' | ' + line).join('\n');
}

export interface PatchResult extends ToolResult {
  /** How the anchor was located. Reported back to the model so it can learn. */
  matchedBy?: 'exact' | 'outer-whitespace' | 'line-normalized';
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function ambiguous(base: string, count: number): PatchResult {
  return {
    success: false,
    output: '',
    error:
      `Target snippet matches ${count} different regions in ${base}. ` +
      'Widen the anchor (include the surrounding function or a distinctive neighbouring line) so it ' +
      'matches exactly one place — refusing rather than guessing which occurrence you meant.',
  };
}

/**
 * Locates a multi-line anchor allowing leading/trailing whitespace to differ.
 *
 * Models routinely re-indent a snippet when they copy it into a tool call, and a
 * byte-exact matcher then rejects a semantically perfect patch. Falling back to a
 * line-normalized window scan keeps the edit surgical while tolerating that.
 * The match must still be unique, otherwise the patch is refused rather than
 * applied to the wrong place.
 */
function findNormalizedWindow(
  fileLines: string[],
  anchorLines: string[]
): { start: number; count: number } | undefined {
  const height = anchorLines.length;
  if (height === 0 || height > fileLines.length) return undefined;

  const wanted = anchorLines.map((line) => line.trim());
  const matches: number[] = [];

  for (let i = 0; i + height <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < height; k++) {
      if (fileLines[i + k].trim() !== wanted[k]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
    if (matches.length > 1) return undefined; // ambiguous — refuse
  }

  return matches.length === 1 ? { start: matches[0], count: height } : undefined;
}

export function applyCodePatch(
  filePath: string,
  targetContent: string,
  replacementContent: string
): PatchResult {
  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: 'File not found: ' + filePath };
  }

  const raw = normalize(fs.readFileSync(filePath, 'utf-8'));
  const base = path.basename(filePath);
  const target = normalize(targetContent);
  const replacement = normalize(replacementContent);

  // 1. Byte-exact match — the ideal case, but only when it is unambiguous.
  //    String.replace() would silently take the first of several identical regions.
  const exactCount = countOccurrences(raw, target);
  if (exactCount > 1) {
    return ambiguous(base, exactCount);
  }
  if (exactCount === 1) {
    fs.writeFileSync(filePath, raw.replace(target, replacement), 'utf-8');
    return {
      success: true,
      output: `Successfully applied patch to ${base} (exact match, ${target.split('\n').length} line(s) replaced).`,
      matchedBy: 'exact',
    };
  }

  // 2. Tolerate a trailing/leading newline difference only.
  const trimmedTarget = target.replace(/^\n+/, '').replace(/\n+$/, '');
  const trimmedCount = countOccurrences(raw, trimmedTarget);
  if (trimmedTarget && trimmedCount > 1) {
    return ambiguous(base, trimmedCount);
  }
  if (trimmedTarget && trimmedCount === 1) {
    fs.writeFileSync(filePath, raw.replace(trimmedTarget, replacement), 'utf-8');
    return {
      success: true,
      output: `Successfully applied patch to ${base} (matched after trimming outer blank lines).`,
      matchedBy: 'outer-whitespace',
    };
  }

  // 3. Line-normalized window match — rescues indentation drift.
  const fileLines = raw.split('\n');
  const anchorLines = trimmedTarget.split('\n');
  const window = findNormalizedWindow(fileLines, anchorLines);

  if (window) {
    const patched = [
      ...fileLines.slice(0, window.start),
      ...normalize(replacement).split('\n'),
      ...fileLines.slice(window.start + window.count),
    ].join('\n');

    fs.writeFileSync(filePath, patched, 'utf-8');
    return {
      success: true,
      output:
        `Successfully applied patch to ${base} (matched by ignoring indentation differences at lines ` +
        `${window.start + 1}-${window.start + window.count}). The replacement text was inserted exactly as supplied, ` +
        `so check the indentation of the patched region if it matters.`,
      matchedBy: 'line-normalized',
    };
  }

  // Nothing matched: hand back the real lines so the model can copy them verbatim.
  const firstLine = anchorLines[0]?.trim() || '';
  const hintLine = fileLines.findIndex((line) => firstLine.length > 3 && line.includes(firstLine.slice(0, 12)));
  const hint =
    hintLine >= 0
      ? `\nThe first line of your anchor resembles line ${hintLine + 1}:\n${readFileSlice(filePath, Math.max(1, hintLine - 1), hintLine + 4)}`
      : '';

  return {
    success: false,
    output: '',
    error:
      `Target snippet was not found in ${base}, even ignoring indentation. ` +
      `Re-read the region with read_file_slice and copy the snippet verbatim.${hint}`,
  };
}

/**
 * Cheap up-front check that this environment can execute commands at all.
 *
 * Without it, a locked-down machine burns the whole iteration budget probing
 * for a shell that will never start (observed: EBUSY on every command,
 * including `echo hi`), and every resulting failure is misattributed to the
 * model. One probe now costs a single spawn and saves the entire run.
 *
 * A probe that runs and exits non-zero proves the environment works — only a
 * spawn failure counts.
 */
export function checkCommandEnvironment(
  cwd: string,
  options: { shell?: string; command?: string } = {}
): { ok: true } | { ok: false; error: string } {
  const probe = executeTestSuite(options.command || 'echo ok', cwd, {
    ...(options.shell ? { shell: options.shell } : {}),
  });
  if (!probe.success && /DID NOT RUN/.test(probe.error || '')) {
    return { ok: false, error: probe.error as string };
  }
  return { ok: true };
}

export function executeTestSuite(
  command: string,
  cwd: string,
  options: { shell?: string } = {}
): ToolResult {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      // Overridable so the spawn-failure path can be tested without breaking
      // the real shell. Never set this in production code paths.
      ...(options.shell ? { shell: options.shell } : {}),
    });
    return {
      success: true,
      output: stdout,
    };
  } catch (err: any) {
    // Distinguish "the tests ran and failed" from "no shell could be started".
    // Conflating them is expensive: the caller sees a non-zero exit that looks
    // like a failing test, sees no output to diagnose, and starts probing with
    // different command spellings - which the loop guard then reports as a loop.
    // Observed in a locked-down environment where spawning cmd.exe returns EBUSY
    // for every command, including `echo hi`.
    const spawnFailureCodes = ['EBUSY', 'ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE'];
    if (typeof err?.code === 'string' && spawnFailureCodes.includes(err.code)) {
      return {
        success: false,
        output: '',
        error:
          `The command could not be started at all (${err.code}). The tests DID NOT RUN.\n` +
          `This is an environment failure, not a test failure. Re-running the same command or a ` +
          `different spelling of it will not help - stop probing and report this instead.\n` +
          `Underlying message: ${String(err.message || '').split('\n')[0]}`,
      };
    }

    // A non-zero exit is expected for failing tests; both streams are evidence.
    return {
      success: false,
      output: err.stdout ? String(err.stdout) : '',
      error: err.stderr ? String(err.stderr) : err.message || 'Command exited with a non-zero status',
    };
  }
}
