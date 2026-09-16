import { describe, it, expect } from 'vitest';
import { calculateTieredDiscount, TierRule } from './tieredDiscount';

describe('calculateTieredDiscount', () => {
  const tiers: TierRule[] = [
    { threshold: 100, discount: 20 },
    { threshold: 200, discount: 50 },
  ];

  it('should apply discount when strictly above threshold', () => {
    expect(calculateTieredDiscount(150, tiers)).toBe(130);
  });

  it('should apply discount on EXACT boundary threshold (Edge Case)', () => {
    // 100 - 20 should be 80
    expect(calculateTieredDiscount(100, tiers)).toBe(80);
  });

  it('should handle floating point numbers accurately', () => {
    // 100.55 - 20 should be 80.55, NOT truncated to 80
    expect(calculateTieredDiscount(100.55, tiers)).toBe(80.55);
  });
});
