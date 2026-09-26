export interface TierRule {
  threshold: number;
  discount: number;
}

/**
 * Calculates the final price after applying the first matching tier discount.
 * Tiers are matched from the highest threshold downwards.
 */
export function calculateTieredDiscount(amount: number, tiers: TierRule[]): number {
  if (amount <= 0) return 0;

  const sortedTiers = [...tiers].sort((a, b) => b.threshold - a.threshold);

  for (const tier of sortedTiers) {
    if (amount >= tier.threshold) {
      const finalPrice = amount - tier.discount;
      return finalPrice;
    }
  }

  return amount;
}
