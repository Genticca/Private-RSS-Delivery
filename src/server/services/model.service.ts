import type { ModelConfigResponse, ModelProvider, ModelRole, ModelStatus, ModelStatusResponse, ModelUsageResponse } from '../contracts/api.js';
import { nowIso } from '../db/time.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import { resolveModelApiKey } from '../translator/keys.js';
import { validationError } from './errors.js';
import { toModelConfigEntryDto, toModelUsageDto } from './serialization.js';
import { optionalBoolean, optionalInteger, optionalString, requireObject, validateProvider } from './validation.js';

export interface ModelServiceOptions {
  repositories: RepositoryRegistry;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

const ROLES: ModelRole[] = ['primary', 'fallback'];

export class ModelService {
  constructor(private readonly options: ModelServiceOptions) {}

  getConfig(): ModelConfigResponse {
    const primary = this.requireConfig('primary');
    const fallback = this.requireConfig('fallback');
    return {
      primary: toModelConfigEntryDto(primary),
      fallback: toModelConfigEntryDto(fallback),
      targetLang: primary.targetLang,
      promptLogMaxBytes: primary.promptLogMaxBytes
    };
  }

  updateConfig(value: unknown): ModelConfigResponse {
    const body = requireObject(value);
    for (const role of ROLES) {
      if (body[role] !== undefined) {
        const current = this.requireConfig(role);
        const patch = normalizeRolePatch(body[role]);
        if (Object.keys(patch).length > 0) {
          validateProviderModel(patch.provider ?? current.provider, patch.model ?? current.model);
          this.options.repositories.modelConfig.updateRole(role, { ...patch, targetLang: 'ko', updatedAt: this.now() });
        }
      }
    }
    const promptLogMaxBytes = optionalInteger(body.promptLogMaxBytes, 'promptLogMaxBytes', 0, 1_000_000);
    if (promptLogMaxBytes !== undefined) {
      for (const role of ROLES) {
        this.options.repositories.modelConfig.updateRole(role, { promptLogMaxBytes, targetLang: 'ko', updatedAt: this.now() });
      }
    }
    return this.getConfig();
  }

  getStatus(): ModelStatusResponse {
    return {
      primary: this.statusFor('primary'),
      fallback: this.statusFor('fallback')
    };
  }

  listUsage(options: { limit?: number; before?: number } = {}): ModelUsageResponse {
    const limit = clampLimit(options.limit);
    const rows = this.options.repositories.modelUsage.list({ before: options.before, limit });
    return {
      items: rows.map(toModelUsageDto),
      nextBefore: rows.length === limit ? rows.at(-1)?.id ?? null : null
    };
  }

  private statusFor(role: ModelRole): ModelStatus {
    const config = this.requireConfig(role);
    if (!config.enabled) return 'disabled';
    if (!resolveModelApiKey(role, this.options.env)) return 'missing-key';
    const latest = this.options.repositories.modelUsage.list({ role, limit: 1 })[0];
    if (latest?.error === 'invalid-key') return 'invalid-key';
    return 'ready';
  }

  private requireConfig(role: ModelRole) {
    const config = this.options.repositories.modelConfig.getByRole(role);
    if (!config) throw validationError(`모델 설정이 없습니다: ${role}`);
    return config;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

function normalizeRolePatch(value: unknown) {
  const body = requireObject(value);
  const provider = validateProvider(body.provider);
  const model = optionalString(body.model, 'model', 200) ?? undefined;
  const enabled = optionalBoolean(body.enabled);
  if (provider !== undefined && model !== undefined) validateProviderModel(provider, model);
  return { provider, model, enabled };
}

function validateProviderModel(provider: ModelProvider, model: string): void {
  if (provider === 'gemini') {
    if (!/^gemini-[a-z0-9][a-z0-9._-]*$/i.test(model)) {
      throw validationError('provider와 model 조합이 올바르지 않습니다.', { model: 'gemini provider는 gemini-* 모델만 허용됩니다.' });
    }
    return;
  }
  if (provider === 'nvidia-nim' && /^gemini-/i.test(model)) {
    throw validationError('provider와 model 조합이 올바르지 않습니다.', { model: 'nvidia-nim provider에는 gemini-* 모델을 사용할 수 없습니다.' });
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 100;
  return Math.max(1, Math.min(limit, 500));
}
