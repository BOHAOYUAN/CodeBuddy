import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../llm/client';
import { MemoryHit } from '../tools/registry';

/* ------------------------------------------------------------------ *
 * Short-term memory: bounded message window
 * ------------------------------------------------------------------ */

export interface ShortTermStats {
  messagesKept: number;
  messagesDropped: number;
  charsKept: number;
  charsDropped: number;
}

/**
 * Keeps the working conversation inside a character budget.
 *
 * Naive agents append every observation forever, so a long repair session
 * eventually blows the context window (and the bill). This window always
 * retains the system prompt, the plan, and the most recent turns, and replaces
 * older tool output with a one-line stub that is still enough to reason about.
 */
export class ShortTermMemory {
  private messages: ChatMessage[] = [];
  private droppedCount = 0;
  private droppedChars = 0;

  constructor(private readonly charBudget: number) {}

  push(message: ChatMessage): void {
    this.messages.push(message);
  }

  pushMany(messages: ChatMessage[]): void {
    for (const m of messages) this.push(m);
  }

  get all(): ChatMessage[] {
    return this.messages;
  }

  /** Pinned messages (system + plan) that must never be evicted. */
  private pinned: ChatMessage[] = [];

  pin(message: ChatMessage): void {
    this.pinned.push(message);
  }

  private size(messages: ChatMessage[]): number {
    return messages.reduce(
      (total, m) => total + (m.content ? m.content.length : 0) + JSON.stringify(m.tool_calls || '').length,
      0
    );
  }

  /**
   * Returns the message list to send, trimmed to the char budget.
   * Never mutates the recorded history — trimming only affects what goes on the wire,
   * so the full transcript stays available for the trace file.
   */
  window(): { messages: ChatMessage[]; stats: ShortTermStats } {
    const maxIter = { messagesKept: 0, messagesDropped: 0, charsKept: 0, charsDropped: 0 };

    const mustKeep = [...this.pinned];
    let keptTail: ChatMessage[] = [];

    // Walk backwards, keeping the newest turns until the budget is exhausted.
    let used = this.size(mustKeep);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      const cost = (message.content ? message.content.length : 0) + JSON.stringify(message.tool_calls || '').length;

      if (used + cost > this.charBudget && keptTail.length >= 4) {
        break;
      }
      keptTail.unshift(message);
      used += cost;
    }

    const keptIds = new Set([...mustKeep, ...keptTail]);
    const dropped = this.messages.filter((m) => !keptIds.has(m));

    for (const m of dropped) {
      this.droppedCount++;
      this.droppedChars += m.content ? m.content.length : 0;
    }

    const summaryStub: ChatMessage | undefined =
      dropped.length > 0
        ? {
            role: 'user',
            content:
              `[context window] ${dropped.length} earlier message(s) were evicted to stay inside the context budget ` +
              `(${this.droppedChars} characters reclaimed). The evicted content was older tool observations that have ` +
              `already been acted on. Re-run a tool if you need that data again.`,
          }
        : undefined;

    const messages = [...mustKeep, ...(summaryStub ? [summaryStub] : []), ...keptTail];

    maxIter.messagesKept = messages.length;
    maxIter.messagesDropped = dropped.length;
    maxIter.charsKept = this.size(messages);
    maxIter.charsDropped = this.droppedChars;

    return { messages, stats: maxIter };
  }
}

/* ------------------------------------------------------------------ *
 * Long-term memory: persisted lessons across runs
 * ------------------------------------------------------------------ */

export interface MemoryRecord extends MemoryHit {
  targetFile: string;
  toolSequence: string[];
}

interface MemoryFile {
  version: number;
  records: MemoryRecord[];
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
  'it', 'this', 'that', 'fix', 'bug', 'error', 'please', 'make', 'test', 'tests', 'pass',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Persists what the agent learned after each successful run.
 *
 * This is what turns a one-shot script into something that improves: the next
 * task with a similar signature starts with the previously successful root cause
 * already in context, instead of re-deriving it from scratch.
 */
export class LongTermMemory {
  private records: MemoryRecord[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as MemoryFile;
      if (Array.isArray(parsed.records)) {
        this.records = parsed.records;
      }
    } catch {
      // A corrupted memory file must never block a run.
      this.records = [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: MemoryFile = { version: 1, records: this.records };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch {
      // Best-effort: memory persistence failure is not fatal.
    }
  }

  get size(): number {
    return this.records.length;
  }

  remember(record: MemoryRecord): void {
    const duplicate = this.records.findIndex(
      (r) => r.targetFile === record.targetFile && r.rootCause === record.rootCause
    );
    if (duplicate >= 0) {
      this.records[duplicate] = record;
    } else {
      this.records.push(record);
    }
    // Keep the store bounded so recall stays fast and cheap.
    if (this.records.length > 200) {
      this.records = this.records.slice(-200);
    }
    this.persist();
  }

  recall(query: string, limit = 3): MemoryHit[] {
    if (this.records.length === 0) return [];

    const queryTokens = new Set(tokenize(query));

    const scored = this.records
      .map((record) => {
        const haystack = new Set(
          tokenize(`${record.goal} ${record.rootCause} ${record.lesson} ${record.targetFile}`)
        );
        let overlap = 0;
        for (const token of queryTokens) {
          if (haystack.has(token)) overlap++;
        }
        // Recency only breaks ties between records that already match the query.
        // Adding it before the threshold check would make every record score > 0
        // and recall would return the entire store.
        const recency = new Date(record.createdAt).getTime() / 1e13;
        return { record, overlap, score: overlap + recency };
      })
      .filter((entry) => entry.overlap > 0);

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        goal: s.record.goal,
        rootCause: s.record.rootCause,
        lesson: s.record.lesson,
        rounds: s.record.rounds,
        createdAt: s.record.createdAt,
      }));
  }
}
