import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
