export interface TierRule {
  threshold: number;
  discount: number;
}

/**
 * Calculates final price based on tiered discount rules.
 * Contains subtle edge-case boundary bug and rounding glitch.
 */
export function calculateTieredDiscount(amount: number, tiers: TierRule[]): number {
  if (amount <= 0) return 0;

  // Sort tiers descending
  const sortedTiers = [...tiers].sort((a, b) => b.threshold - a.threshold);

    for (const tier of sortedTiers) {
    // FIX: Include boundary condition >=
    if (amount >= tier.threshold) {
      // FIX: Maintain floating-point precision rounded to 2 decimals
      const rawPrice = amount - tier.discount;
      return Math.round(rawPrice * 100) / 100;
    }
  }

  return amount;
}
