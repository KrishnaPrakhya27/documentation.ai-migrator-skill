/** Bounded work with deterministic result order; no unbounded Promise.all over site pages. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('concurrency must be an integer from 1 to 64');
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await operation(items[index], index); }
      catch (error) { failed = true; failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
  return results;
}
