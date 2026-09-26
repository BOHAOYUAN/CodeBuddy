import { describe, it, expect } from 'vitest';
import { calculateTieredDiscount, TierRule } from './tieredDiscount';

// Deliberately unsorted on purpose: the implementation is expected to sort tiers itself.
const tiers: TierRule[] = [
  { threshold: 200, discount: 50 },
  { threshold: 100, discount: 20 },
];

describe('calculateTieredDiscount', () => {
  it('applies the discount when the amount is strictly above the threshold', () => {
    expect(calculateTieredDiscount(150, tiers)).toBe(130);
  });

  it('applies the discount when the amount sits exactly on the threshold', () => {
    expect(calculateTieredDiscount(100, tiers)).toBe(80);
    expect(calculateTieredDiscount(200, tiers)).toBe(150);
  });

  it('picks the highest matching tier', () => {
    expect(calculateTieredDiscount(500, tiers)).toBe(450);
  });

  it('preserves cents instead of truncating them', () => {
    expect(calculateTieredDiscount(100.55, tiers)).toBe(80.55);
  });

  it('returns the amount unchanged when no tier matches', () => {
    expect(calculateTieredDiscount(99.99, tiers)).toBe(99.99);
  });

  it('returns 0 for non-positive amounts', () => {
    expect(calculateTieredDiscount(0, tiers)).toBe(0);
    expect(calculateTieredDiscount(-5, tiers)).toBe(0);
  });
});
