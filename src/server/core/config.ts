/**
 * 설정 경계. 외부 환경 변수와 .env를 병합하고 부팅 전에 주소·범위·실행 제한값을 검증한다.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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

/** 네트워크 노출과 저장 경로를 부팅 시 검증한다. production은 loopback 주소만 허용한다(컨테이너는 ALLOW_NON_LOOPBACK_HOST로 모든 인터페이스 허용). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): AppConfig {
  const effectiveEnv = loadEnvironment(env, options);
  const isProduction = effectiveEnv.NODE_ENV === 'production';
  const host = readString(effectiveEnv.HOST, DEFAULT_HOST, 'HOST');
  const allowAllInterfaces = readBoolean(effectiveEnv.ALLOW_NON_LOOPBACK_HOST, 'ALLOW_NON_LOOPBACK_HOST');
  if (isProduction && !isLoopbackHost(host) && !(allowAllInterfaces && isAllInterfacesHost(host))) {
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

/** 공백 입력과 누락을 구분해 설정별 기본값·필수값 규칙을 적용한다. */
function readString(value: string | undefined, fallback: string, name: string): string {
  const candidate = value?.trim() ?? fallback;
  if (candidate.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return candidate;
}

/** 기본 설정의 정수 범위를 검증한다. 실행 제한값 검증과 오류 문구가 달라 별도로 유지한다. */
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

/** 관리 화면을 외부 인터페이스에 직접 노출하지 않도록 허용 주소를 명시한다. */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** 빈 값은 비활성으로 두고 true·false만 허용해 의도하지 않은 외부 바인딩을 막는다. */
function readBoolean(value: string | undefined, name: string): boolean {
  const candidate = value?.trim() ?? '';
  if (candidate === '' || candidate === 'false') return false;
  if (candidate === 'true') return true;
  throw new Error(`${name} must be true or false.`);
}

/** 컨테이너용 예외는 모든 인터페이스 주소만 허용하며 특정 외부 주소까지 허용하지 않는다. */
function isAllInterfacesHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
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

/** .env의 따옴표·이스케이프·행 끝 주석 규칙만 해석하며 임의 코드를 실행하지 않는다. */
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

/** 동시성·수집 크기·보존 기간을 읽고 허용 범위를 벗어난 값은 실행 전에 거부한다. */
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

/** 실행 제한값은 숫자 문자열이면서 안전한 정수이고 지정 범위 안에 있어야 한다. */
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** 보류 비율은 0 초과 1 이하로 제한해 분모 대비 판단을 일정하게 유지한다. */
function ratio(raw: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('NEW_ITEMS_HOLD_RATIO must be greater than 0 and at most 1.');
  }
  return value;
}
