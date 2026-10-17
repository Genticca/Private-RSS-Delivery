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
