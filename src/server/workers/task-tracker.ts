/** 예약 실행과 수동 실행을 함께 추적하여 종료 전에 진행 중인 작업을 기다린다. */
export class TaskTracker {
  private accepting = true;
  private readonly tasks = new Set<Promise<unknown>>();

  get stopped(): boolean {
    return !this.accepting;
  }

  stop(): void {
    this.accepting = false;
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Worker is shutting down.'));
    const task = Promise.resolve().then(operation);
    this.tasks.add(task);
    // 성공과 실패 모두 추적 목록에서 제거하되, 원래 작업의 오류는 호출자에게 전달한다.
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}

export async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);

  // 실행 슬롯끼리 다음 인덱스를 나누어 사용하고, 결과는 입력 순서대로 보관한다.
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await action(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
