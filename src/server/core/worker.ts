/**
 * 비동기 작업 수명 관리. 새 작업 접수 중단, 진행 중 작업 대기, 제한된 병렬 실행을 제공한다.
 */

export interface DrainableWorker {
  stop(): void;
  drain(): Promise<void>;
}

/** 종료 제한 시간을 넘겨도 작업이 사용 중인 DB를 강제로 닫지 않는다. */
export async function stopAndDrain(workers: readonly DrainableWorker[], timeoutMs: number): Promise<void> {
  for (const worker of workers) worker.stop();
  let timer: NodeJS.Timeout | undefined;
  try {
    // 대기를 중단하는 것과 실행 중인 작업을 취소하는 것은 다르다.
    // 타임아웃은 호출자에게 실패를 알리고, DB 종료 여부는 호출자가 결정한다.
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

/** 예약 실행과 수동 실행을 함께 추적하여 종료 전에 진행 중인 작업을 기다린다. */
export class TaskTracker {
  private accepting = true;
  private readonly tasks = new Set<Promise<unknown>>();

  get stopped(): boolean {
    return !this.accepting;
  }

  /** 이미 시작한 작업은 유지하고 이후 작업 접수만 중단한다. */
  stop(): void {
    this.accepting = false;
  }

  /** 추적 목록에 등록한 Promise를 그대로 반환해 호출자가 원래 성공·실패를 관찰하게 한다. */
  track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Worker is shutting down.'));
    const task = Promise.resolve().then(operation);
    this.tasks.add(task);
    // 성공과 실패 모두 추적 목록에서 제거하되, 원래 작업의 오류는 호출자에게 전달한다.
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  /** 실패한 작업도 대기 완료로 처리한다. 대기 중 추적 목록이 바뀔 수 있어 빌 때까지 확인한다. */
  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}

/** 동시에 실행할 슬롯 수만 제한하고 결과 배열의 순서는 입력 순서와 같게 유지한다. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>
): Promise<R[]> {
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
