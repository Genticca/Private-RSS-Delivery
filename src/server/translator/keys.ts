import process from 'node:process';
import type { ModelRole } from '../contracts/api.js';

const KEY_ENV_BY_ROLE: Record<ModelRole, string> = {
  primary: 'PRIMARY_MODEL_API_KEY',
  fallback: 'FALLBACK_MODEL_API_KEY'
};

export function modelApiKeyEnvName(role: ModelRole): string {
  return KEY_ENV_BY_ROLE[role];
}

export function resolveModelApiKey(role: ModelRole, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[modelApiKeyEnvName(role)]?.trim();
  return value && value.length > 0 ? value : null;
}
