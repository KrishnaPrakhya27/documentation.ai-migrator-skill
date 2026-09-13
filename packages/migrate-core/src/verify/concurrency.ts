/** Bounded asynchronous work with deterministic output ordering. */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  visit: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const count = Math.max(1, Math.min(Number.isFinite(concurrency) ? Math.floor(concurrency) : 1, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await visit(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}
