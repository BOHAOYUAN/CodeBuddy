import { describe, it, expect } from 'vitest';
import { dedupeByKey, Dedupable } from './dedupe';

const byId = (item: Dedupable) => item.id;

describe('dedupeByKey', () => {
  it('keeps the first occurrence of a duplicated key', () => {
    const input: Dedupable[] = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'a', value: 99 },
    ];

    expect(dedupeByKey(input, byId)).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ]);
  });

  it('preserves the input order of the surviving entries', () => {
    const input: Dedupable[] = [
      { id: 'z', value: 1 },
      { id: 'a', value: 2 },
      { id: 'm', value: 3 },
    ];

    expect(dedupeByKey(input, byId).map((item) => item.id)).toEqual(['z', 'a', 'm']);
  });

  it('does not mutate the input array', () => {
    const input: Dedupable[] = [
      { id: 'a', value: 1 },
      { id: 'a', value: 2 },
    ];

    dedupeByKey(input, byId);

    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ id: 'a', value: 1 });
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeByKey([], byId)).toEqual([]);
  });
});
