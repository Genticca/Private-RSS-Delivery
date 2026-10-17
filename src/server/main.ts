import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AppInstance, type CreateAppOptions } from './app.js';

export async function startServer(options: CreateAppOptions = {}): Promise<AppInstance> {
  const app = createApp(options);
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    for (const worker of [app.container.workers.poller, app.container.workers.dispatcher, app.container.workers.cleanup]) worker.stop();
    try { await app.close(); }
    catch (error) { app.log.error({ err: error }, 'shutdown failed'); process.exitCode = 1; }
  };
  const onTerm = () => { void shutdown('SIGTERM'); };
  const onInt = () => { void shutdown('SIGINT'); };
  app.addHook('onClose', async () => { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); });
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
  startServer().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
