export interface Dedupable {
  id: string;
  value: number;
}

/**
 * Removes duplicate entries, keeping the FIRST occurrence of each key.
 *
 * Contract:
 *  - The input array must not be mutated.
 *  - The relative order of the surviving entries must match the input order.
 */
export function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const k = keyOf(item);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }

  return result;
}
