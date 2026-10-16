export interface DrainableWorker {
  stop(): void;
  drain(): Promise<void>;
}

/** A timeout rejects shutdown; it never closes a DB still used by active work. */
export async function stopAndDrain(workers: readonly DrainableWorker[], timeoutMs: number): Promise<void> {
  for (const worker of workers) worker.stop();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(workers.map((worker) => worker.drain())),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Worker shutdown exceeded ${timeoutMs}ms; database remains open.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
