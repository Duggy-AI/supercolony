// Keep each slot occupied without waiting for the slowest item in a batch.
export async function mapConcurrent(items, concurrency, map) {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      try { results[index] = await map(items[index], index); }
      catch (error) { stopped = true; throw error; }
    }
  }));
  return results;
}
