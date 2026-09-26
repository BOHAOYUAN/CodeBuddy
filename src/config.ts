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
  /** Requests-per-minute token ceiling. 0 disables client-side pacing. */
  tpmLimit: number;
  pricePerMTokIn: number;
  pricePerMTokOut: number;
}

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_VALIDATOR_MODEL = 'openai/gpt-oss-20b';

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

  const apiKey = overrides.apiKey || process.env.GROQ_API_KEY || '';

  return {
    apiKey,
    baseUrl: process.env.GROQ_BASE_URL || DEFAULT_BASE_URL,
    model: overrides.model || process.env.GROQ_MODEL || DEFAULT_MODEL,
    validatorModel: process.env.GROQ_VALIDATOR_MODEL || DEFAULT_VALIDATOR_MODEL,
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
    // Groq's on-demand free tier allows 8,000 tokens/minute per model. Pacing
    // to that ceiling is cheaper than absorbing 429s.
    tpmLimit: num(process.env.AGENT_TPM_LIMIT, 8000),
    pricePerMTokIn: num(process.env.AGENT_PRICE_IN_PER_MTOK, 0),
    pricePerMTokOut: num(process.env.AGENT_PRICE_OUT_PER_MTOK, 0),
  };
}

export function assertApiKey(config: AgentConfig): void {
  if (!config.apiKey) {
    throw new Error(
      'Missing API key. Set GROQ_API_KEY in the workspace .env file, or export it in the shell.\n' +
        'Get a free key at https://console.groq.com/keys'
    );
  }
}
