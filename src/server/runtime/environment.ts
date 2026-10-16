import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LoadEnvironmentOptions {
  envFilePath?: string;
}

/** Load secrets and settings once without mutating process.env. */
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
    if (match && merged[match[1]] === undefined) merged[match[1]] = parseValue(match[2] ?? '');
  }
  return merged;
}

function parseValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  const hash = trimmed.indexOf(' #');
  return (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim();
}
