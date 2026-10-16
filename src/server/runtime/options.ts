export interface RuntimeOptions {
  pollConcurrency: number;
  deliveryConcurrency: number;
  shutdownTimeoutMs: number;
  feedMaxBytes: number;
  holdCount: number;
  holdRatio: number;
  holdMinItems: number;
  itemContentRetentionDays: number;
}

export function loadRuntimeOptions(env: NodeJS.ProcessEnv): RuntimeOptions {
  return {
    pollConcurrency: integer(env, 'POLL_CONCURRENCY', 2, 1, 16),
    deliveryConcurrency: integer(env, 'DELIVERY_CONCURRENCY', 2, 1, 16),
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 30_000, 100, 300_000),
    feedMaxBytes: integer(env, 'FEED_MAX_BYTES', 5_242_880, 1024, 52_428_800),
    holdCount: integer(env, 'NEW_ITEMS_HOLD_COUNT', 50, 1, 100_000),
    holdRatio: ratio(env.NEW_ITEMS_HOLD_RATIO ?? '0.8'),
    holdMinItems: integer(env, 'NEW_ITEMS_HOLD_MIN', 10, 1, 100_000),
    itemContentRetentionDays: integer(env, 'ITEM_CONTENT_RETENTION_DAYS', 180, 1, 3650)
  };
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function ratio(raw: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('NEW_ITEMS_HOLD_RATIO must be greater than 0 and at most 1.');
  }
  return value;
}
