import * as fs from 'fs';
import * as path from 'path';

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  validatorModel: string;
  enableCrossValidation: boolean;
  maxIterations: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
  temperature: number;
  maxTokens: number;
  workspaceRoot: string;
  memoryFile: string;
  traceDir: string;
  maxObservationChars: number;
  maxPlanSteps: number;
  /**
   * Iteration at which the agent reminds the model that it has not edited
   * anything yet. 0 disables the nudge.
   */
  noPatchNudgeAtIteration: number;
  /** Requests-per-minute token ceiling. 0 disables client-side pacing. */
  tpmLimit: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_VALIDATOR_MODEL = 'deepseek-v4-pro';

/**
 * Reads a setting under its current name, falling back to the legacy GROQ_*
 * alias. The project started on Groq, so existing .env files still use those
 * names; renaming them outright would break every checkout silently.
 */
function setting(current: string, legacy: string): string | undefined {
  const value = process.env[current];
  if (value !== undefined && value !== '') return value;
  return process.env[legacy];
}

/**
 * Minimal .env parser. Avoids a runtime dependency on dotenv so the same code
 * path works inside the bundled VSCode extension and the plain CLI.
 * Existing process.env values always win (VSCode settings / shell exports).
 */
export function loadEnvFile(dir: string): void {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export interface ConfigOverrides {
  apiKey?: string;
  workspaceRoot?: string;
  model?: string;
  maxIterations?: number;
}

export function loadConfig(overrides: ConfigOverrides = {}): AgentConfig {
  const workspaceRoot = path.resolve(overrides.workspaceRoot || process.cwd());
  loadEnvFile(workspaceRoot);

  const apiKey = overrides.apiKey || setting('PROVIDER_API_KEY', 'GROQ_API_KEY') || '';

  return {
    apiKey,
    baseUrl: setting('PROVIDER_BASE_URL', 'GROQ_BASE_URL') || DEFAULT_BASE_URL,
    model: overrides.model || setting('PROVIDER_MODEL', 'GROQ_MODEL') || DEFAULT_MODEL,
    validatorModel: setting('PROVIDER_VALIDATOR_MODEL', 'GROQ_VALIDATOR_MODEL') || DEFAULT_VALIDATOR_MODEL,
    enableCrossValidation: bool(process.env.AGENT_CROSS_VALIDATION, false),
    maxIterations: overrides.maxIterations ?? num(process.env.AGENT_MAX_ITERATIONS, 12),
    maxRetries: num(process.env.AGENT_MAX_RETRIES, 5),
    retryBaseDelayMs: num(process.env.AGENT_RETRY_BASE_DELAY_MS, 1200),
    requestTimeoutMs: num(process.env.AGENT_REQUEST_TIMEOUT_MS, 60_000),
    temperature: num(process.env.AGENT_TEMPERATURE, 0.1),
    maxTokens: num(process.env.AGENT_MAX_TOKENS, 700),
    workspaceRoot,
    memoryFile: process.env.AGENT_MEMORY_FILE || path.join(workspaceRoot, '.codebuddy', 'memory.json'),
    traceDir: process.env.AGENT_TRACE_DIR || path.join(workspaceRoot, '.codebuddy', 'traces'),
    maxObservationChars: num(process.env.AGENT_MAX_OBSERVATION_CHARS, 1800),
    maxPlanSteps: num(process.env.AGENT_MAX_PLAN_STEPS, 5),
    // Some providers happily read files and run tests forever without ever
    // attempting a fix. Nudging at iteration 3 costs almost nothing and is
    // provider-agnostic.
    noPatchNudgeAtIteration: num(process.env.AGENT_NO_PATCH_NUDGE_AT, 3),
    // Client-side pacing only matters against a provider with a per-minute
    // token ceiling (Groq's free tier: 8,000 TPM). DeepSeek bills instead of
    // throttling, so the default is off.
    tpmLimit: num(process.env.AGENT_TPM_LIMIT, 0),
    pricePerMTokIn: num(process.env.AGENT_PRICE_IN_PER_MTOK, 0),
    pricePerMTokOut: num(process.env.AGENT_PRICE_OUT_PER_MTOK, 0),
  };
}

export function assertApiKey(config: AgentConfig): void {
  if (!config.apiKey) {
    throw new Error(
      'Missing API key. Set PROVIDER_API_KEY (or the legacy GROQ_API_KEY) in the ' +
        'workspace .env file, or export it in the shell.'
    );
  }
}
