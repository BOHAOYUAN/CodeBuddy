import { describe, it, expect } from 'vitest';
import { paginate, totalPages } from './pagination';

const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe('paginate', () => {
  it('returns the first page', () => {
    expect(paginate(items, 1, 3)).toEqual([1, 2, 3]);
  });

  it('returns the second page', () => {
    expect(paginate(items, 2, 3)).toEqual([4, 5, 6]);
  });

  it('returns a partial final page', () => {
    expect(paginate(items, 4, 3)).toEqual([10]);
  });

  it('returns an empty array past the end', () => {
    expect(paginate(items, 5, 3)).toEqual([]);
  });

  it('returns an empty array for invalid page or size', () => {
    expect(paginate(items, 0, 3)).toEqual([]);
    expect(paginate(items, 1, 0)).toEqual([]);
  });
});

describe('totalPages', () => {
  it('rounds a partial trailing page up', () => {
    expect(totalPages(10, 3)).toBe(4);
    expect(totalPages(9, 3)).toBe(3);
  });

  it('returns 0 for a non-positive size', () => {
    expect(totalPages(10, 0)).toBe(0);
  });
});
