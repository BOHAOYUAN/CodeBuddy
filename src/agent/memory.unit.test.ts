import { describe, it, expect } from 'vitest';
import { LongTermMemory, ShortTermMemory } from './memory';
import { ChatMessage } from '../llm/client';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-mem-'));
  return path.join(dir, name);
}

describe('ShortTermMemory', () => {
  const message = (content: string): ChatMessage => ({ role: 'user', content });

  it('never evicts pinned messages', () => {
    const memory = new ShortTermMemory(200);
    memory.pin({ role: 'system', content: 'SYSTEM PROMPT' });
    for (let i = 0; i < 30; i++) memory.push(message(`observation number ${i} with padding text`));

    const { messages } = memory.window();
    expect(messages[0].content).toBe('SYSTEM PROMPT');
  });

  it('keeps the newest turns when the budget is tight', () => {
    const memory = new ShortTermMemory(300);
    memory.pin({ role: 'system', content: 'S' });
    for (let i = 0; i < 30; i++) {
      memory.push(message(`turn-${i} ${'padding '.repeat(6)}`));
    }

    const { messages } = memory.window();
    const contents = messages.map((m) => m.content || '');
    expect(contents.some((c) => c.includes('turn-29'))).toBe(true);
    expect(contents.some((c) => c.includes('turn-0 '))).toBe(false);
  });

  it('tells the model that history was evicted instead of silently truncating', () => {
    const memory = new ShortTermMemory(200);
    memory.pin({ role: 'system', content: 'S' });
    for (let i = 0; i < 40; i++) memory.push(message(`observation-${i} with enough text to force eviction`));

    const { messages, stats } = memory.window();
    expect(stats.messagesDropped).toBeGreaterThan(0);
    expect(messages.some((m) => (m.content || '').includes('context window'))).toBe(true);
  });

  it('keeps the recorded transcript intact regardless of windowing', () => {
    const memory = new ShortTermMemory(100);
    for (let i = 0; i < 20; i++) memory.push(message(`x-${i}`));

    memory.window();
    memory.window();
    expect(memory.all).toHaveLength(20);
  });
});

describe('LongTermMemory', () => {
  const record = (overrides: Partial<Parameters<LongTermMemory['remember']>[0]> = {}) => ({
    goal: 'fix tiered discount boundary',
    targetFile: 'src/benchmark/targets/tieredDiscount.ts',
    rootCause: 'boundary comparison used > instead of >=',
    lesson: 'treat threshold equality as inclusive unless the spec says otherwise',
    rounds: 4,
    createdAt: new Date().toISOString(),
    toolSequence: ['ast_analyze_file', 'execute_test_suite', 'apply_code_patch'],
    ...overrides,
  });

  it('persists a lesson and recalls it by keyword', () => {
    const memory = new LongTermMemory(tempFile('memory.json'));
    memory.remember(record());

    const hits = memory.recall('discount boundary comparison', 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].rootCause).toContain('boundary');
  });

  it('survives a reload from disk', () => {
    const file = tempFile('memory.json');
    new LongTermMemory(file).remember(record());

    const reloaded = new LongTermMemory(file);
    expect(reloaded.size).toBe(1);
    expect(reloaded.recall('discount boundary', 1)).toHaveLength(1);
  });

  it('replaces instead of duplicating the same target and root cause', () => {
    const memory = new LongTermMemory(tempFile('memory.json'));
    memory.remember(record({ rounds: 4 }));
    memory.remember(record({ rounds: 2 }));

    expect(memory.size).toBe(1);
    expect(memory.recall('discount boundary', 1)[0].rounds).toBe(2);
  });

  it('returns nothing for an unrelated query', () => {
    const memory = new LongTermMemory(tempFile('memory.json'));
    memory.remember(record());
    expect(memory.recall('websocket reconnection backoff', 3)).toHaveLength(0);
  });

  it('starts empty when the memory file is corrupted', () => {
    const file = tempFile('memory.json');
    fs.writeFileSync(file, 'this is not json', 'utf-8');

    const memory = new LongTermMemory(file);
    expect(memory.size).toBe(0);
  });
});
