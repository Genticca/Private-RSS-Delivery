import process from 'node:process';
import { loadEnvironment } from './runtime/environment.js';

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
  bounds: { min?: number; max?: number } = {}
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
