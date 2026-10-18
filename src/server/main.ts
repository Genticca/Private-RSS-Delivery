/**
 * 실행 진입점. HTTP listen 성공 후 워커를 시작하고 종료 신호를 한 번만 처리한다.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AppInstance, type CreateAppOptions } from './app.js';

/** HTTP 기동이 성공한 뒤에만 예약 작업을 시작한다. 종료 실패는 프로세스 종료 코드에 남긴다. */
export async function startServer(options: CreateAppOptions = {}): Promise<AppInstance> {
  const app = createApp(options);
  let closing = false;
  const shutdown = async (signal: string) => {
    // 여러 종료 신호가 들어와도 종료 절차는 한 번만 시작한다.
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const { poller, dispatcher, cleanup } = app.container.workers;
    for (const worker of [poller, dispatcher, cleanup]) {
      worker.stop();
    }
    // onClose에서 실행 중인 작업을 기다린 뒤 DB와 외부 연결을 닫는다.
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exitCode = 1;
    }
  };
  const onTerm = () => {
    void shutdown('SIGTERM');
  };
  const onInt = () => {
    void shutdown('SIGINT');
  };
  app.addHook('onClose', async () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  });
  try {
    await app.listen({ port: app.container.config.port, host: app.container.config.host });
    app.container.workers.cleanup.start();
    app.container.workers.poller.start();
    app.container.workers.dispatcher.start();
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
