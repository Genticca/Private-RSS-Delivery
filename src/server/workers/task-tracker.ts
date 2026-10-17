/** A worker owns every scheduled and manual operation until it has settled. */
export class TaskTracker {
  private accepting = true;
  private readonly tasks = new Set<Promise<unknown>>();

  get stopped(): boolean { return !this.accepting; }

  stop(): void { this.accepting = false; }

  track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Worker is shutting down.'));
    const task = Promise.resolve().then(operation);
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }
}

export async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await action(values[index]);
    }
  }));
  return results;
}
