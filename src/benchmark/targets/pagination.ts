/**
 * Returns one page of items using 1-based page numbers.
 *
 * @param items  The full collection.
 * @param page   1-based page index.
 * @param size   Number of items per page.
 */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  if (page < 1 || size <= 0) return [];

  const start = (page - 1) * size;
  const end = start + size;

  return items.slice(start, end);
}

export function totalPages(itemCount: number, size: number): number {
  if (size <= 0) return 0;
  return Math.floor(itemCount / size);
}
