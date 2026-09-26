import { describe, it, expect } from 'vitest';
import { ShortTermMemory } from './memory';
import { ChatMessage } from '../llm/client';

const assistantWithCalls = (id: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'read_file_slice', arguments: '{}' } }],
});

const toolResponse = (id: string): ChatMessage => ({
  role: 'tool',
  content: 'file contents',
  tool_call_id: id,
});

const userMessage = (text: string): ChatMessage => ({ role: 'user', content: text });

function windowOf(messages: ChatMessage[]): ChatMessage[] {
  const mem = new ShortTermMemory(1_000_000);
  mem.pushMany(messages);
  return mem.window().messages;
}

/**
 * The invariant strict providers enforce: every `tool` message answers a
 * tool_call from the immediately preceding assistant turn, and every call id
 * is answered exactly once.
 */
function expectValidSequence(messages: ChatMessage[]): void {
  let pending: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      expect(pending, 'new tool_calls while previous ones unanswered').toEqual([]);
      pending = m.tool_calls.map((tc) => tc.id);
    } else if (m.role === 'tool') {
      expect(pending.length, 'tool message without a preceding tool_calls turn').toBeGreaterThan(0);
      pending = pending.filter((id) => id !== m.tool_call_id);
    }
  }
  expect(pending, 'assistant ended while still expecting tool output').toEqual([]);
}

describe('ShortTermMemory tool-sequence validity', () => {
  it('keeps a complete assistant/tool pair intact', () => {
    const out = windowOf([userMessage('fix it'), assistantWithCalls('c1'), toolResponse('c1')]);
    expect(out.some((m) => m.role === 'tool')).toBe(true);
    expectValidSequence(out);
  });

  it('drops an orphan tool message left behind by trimming', () => {
    // This is the exact shape that made DeepSeek return HTTP 400 while Groq
    // silently accepted it.
    const out = windowOf([userMessage('fix it'), toolResponse('c1')]);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expectValidSequence(out);
  });

  it('drops an assistant turn whose tool calls were never answered', () => {
    const out = windowOf([userMessage('fix it'), assistantWithCalls('c1')]);
    expect(out.some((m) => m.role === 'assistant' && m.tool_calls?.length)).toBe(false);
    expectValidSequence(out);
  });

  it('drops a partially answered tool_call group', () => {
    const twoCalls: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file_slice', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'list_workspace_files', arguments: '{}' } },
      ],
    };
    const out = windowOf([userMessage('fix it'), twoCalls, toolResponse('c1')]);
    expectValidSequence(out);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('stays valid after aggressive trimming', () => {
    const messages: ChatMessage[] = [userMessage('fix it')];
    for (let i = 0; i < 40; i++) {
      messages.push(assistantWithCalls('c' + i), toolResponse('c' + i));
    }
    const mem = new ShortTermMemory(2_000); // small enough to force eviction
    mem.pushMany(messages);
    expectValidSequence(mem.window().messages);
  });
});
