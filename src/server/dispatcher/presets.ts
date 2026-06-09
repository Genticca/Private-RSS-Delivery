import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TemplateRecord, TemplateRepository } from '../db/index.js';

export interface BuiltinPresetDefinition {
  name: string;
  label: string;
}

export interface SeedBuiltinPresetOptions {
  presetsDir?: string;
  updatedAt?: string;
}

export const BUILTIN_PRESETS: readonly BuiltinPresetDefinition[] = [
  // incident-active 단일 프리셋이 stageColor 로 진행중(빨강)·해결(초록)을 모두 칠하므로
  // 과거의 incident-resolved 는 통합 제거됨(0013_merge_incident_presets).
  { name: 'incident-active', label: '장애' },
  { name: 'news-article', label: '뉴스 기사' },
  { name: 'link-discussion', label: '링크·토론' },
  { name: 'minimal', label: '심플' }
] as const;

const DEFAULT_PRESETS_DIR = fileURLToPath(new URL('../../resources/presets/', import.meta.url));

export function seedBuiltinPresets(templates: TemplateRepository, options: SeedBuiltinPresetOptions = {}): TemplateRecord[] {
  const presetsDir = options.presetsDir ?? DEFAULT_PRESETS_DIR;
  return BUILTIN_PRESETS.map((preset) =>
    templates.upsertBuiltin(preset.name, preset.label, readPresetBody(presetsDir, preset.name), options.updatedAt)
  );
}

function readPresetBody(presetsDir: string, name: string): string {
  return readFileSync(join(presetsDir, `${name}.hbs`), 'utf8').trimEnd();
}
