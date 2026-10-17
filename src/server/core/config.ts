import process from 'node:process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const DEFAULT_PORT = 8080;

const DEFAULT_HOST = '127.0.0.1';

const DEFAULT_DATABASE_PATH = './data/rss-discord-bridge.sqlite';

export interface AppConfig {
  port: number;
  host: string;
  /** SQLite 파일 경로. 런타임 데이터이므로 data/ 아래 (gitignore). env 로 덮어씀. */
  databasePath: string;
  isProduction: boolean;
}

export interface LoadConfigOptions {
  envFilePath?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): AppConfig {
  const effectiveEnv = loadEnvironment(env, options);
  const isProduction = effectiveEnv.NODE_ENV === 'production';
  const host = readString(effectiveEnv.HOST, DEFAULT_HOST, 'HOST');
  if (isProduction && !isLoopbackHost(host)) {
    throw new Error('HOST must be loopback-only in production.');
  }

  return {
    port: readInt(effectiveEnv.PORT, DEFAULT_PORT, 'PORT', { min: 1, max: 65_535 }),
    // 내부·루프백 전용 관리 도구 → 기본 127.0.0.1
    host,
    databasePath: readString(effectiveEnv.DATABASE_PATH, DEFAULT_DATABASE_PATH, 'DATABASE_PATH'),
    isProduction
  };
}

function readString(value: string | undefined, fallback: string, name: string): string {
  const candidate = value?.trim() ?? fallback;
  if (candidate.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return candidate;
}

function readInt(
  value: string | undefined,
  fallback: number,
  name: string,
  bounds: {
    min?: number;
    max?: number
  } = {}
): number {
  if (value === undefined || value.trim() === '') return fallback;

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new Error(`${name} must be greater than or equal to ${bounds.min}.`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`${name} must be less than or equal to ${bounds.max}.`);
  }
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export interface LoadEnvironmentOptions {
  envFilePath?: string;
}

/** process.env를 바꾸지 않고, 외부 환경 변수에 없는 값만 .env에서 채운다. */
export function loadEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const merged = { ...env };
  const file = options.envFilePath ?? (env === process.env ? resolve(process.cwd(), '.env') : undefined);
  if (!file || !existsSync(file)) return merged;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (merged[name] === undefined) {
      merged[name] = parseValue(value ?? '');
    }
  }
  return merged;
}

function parseValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  // 따옴표 밖에서 공백 뒤에 붙은 #만 주석의 시작으로 취급한다.
  const commentIndex = trimmed.indexOf(' #');
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}

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
  // 잘못된 제한값으로 실행을 시작하지 않도록 부팅 단계에서 범위까지 검증한다.
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
