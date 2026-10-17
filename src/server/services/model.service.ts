import type { ModelConfigResponse, ModelRole, ModelStatus, ModelStatusResponse, ModelUsageResponse } from '../contracts/api.js';
import { nowIso } from '../db/time.js';
import type { ModelUsageRepository, TranslationCacheRepository, ModelConfigRepository } from '../db/index.js';
import { resolveModelApiKey } from '../translator/keys.js';
import type { TranslationCacheService } from '../translator/translation-cache.service.js';
import { validationError } from './errors.js';
import { toModelConfigEntryDto, toModelUsageDto } from './serialization.js';
import { optionalBoolean, optionalInteger, optionalString, requireObject, validateProvider } from './validation.js';

export interface ModelServiceOptions {
  repositories: {
    modelUsage: Pick<ModelUsageRepository, 'latestRequest' | 'statistics' | 'list'>;
    translationCache: Pick<TranslationCacheRepository, 'statistics'>;
    modelConfig: Pick<ModelConfigRepository, 'updateRole' | 'getByRole'>;
  };
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  translation?: TranslationCacheService;
}

const ROLES: ModelRole[] = ['primary'];

/** 번역 모델 설정과 사용 이력 기반 상태를 관리한다. API 키 자체는 응답에 담지 않는다. */
export class ModelService {
  constructor(private readonly options: ModelServiceOptions) { }

  getDiagnostics() {
    return {
      roles: ROLES.map((role) => {
        const request = this.options.repositories.modelUsage.latestRequest(role);
        return {
          role,
          keyStatus: this.statusFor(role),
          lastRequestAt: request?.createdAt ?? null,
          lastRequestResult: request ? request.error ?? 'success' : '아직 호출하지 않음'
        };
      }), requests: this.options.repositories.modelUsage.statistics(), cache: {
        cache_hit: 0,
        local_skip: 0,
        single_flight: 0,
        failure_cooldown: 0,
        ...this.options.repositories.translationCache.statistics()
      }
    };
  }

  async diagnose(value: unknown) {
    // 진단은 실패 대기 시간을 무시한다. fresh를 요청한 경우에는 성공 캐시도 재사용하지 않는다.
    const body = requireObject(value);
    const title = optionalString(body.title, 'title', 1000) ?? '';
    const summary = optionalString(body.summary, 'summary', 3500) ?? '';
    if (!title && !summary) throw validationError('진단할 제목 또는 본문이 필요합니다.');
    if (!this.options.translation) throw validationError('번역 진단을 사용할 수 없습니다.');
    return this.options.translation.translate({ title, summary }, {
      profileSetting: 'generic',
      detectedProfile: null,
      threadId: null,
      threadName: null,
      appliedTags: []
    }, { now: this.now(), ignoreCooldown: true, fresh: optionalBoolean(body.fresh) ?? false });
  }

  getConfig(): ModelConfigResponse {
    const primary = this.requireConfig('primary');
    return {
      primary: toModelConfigEntryDto(primary),
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
          validateModel(patch.model ?? current.model);
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
      primary: this.statusFor('primary')
    };
  }

  listUsage(options: {
    limit?: number;
    before?: number
  } = {}): ModelUsageResponse {
    const limit = clampLimit(options.limit);
    const rows = this.options.repositories.modelUsage.list({ before: options.before, limit });
    return {
      items: rows.map(toModelUsageDto),
      nextBefore: rows.length === limit ? rows.at(-1)?.id ?? null : null
    };
  }

  private statusFor(role: ModelRole): ModelStatus {
    // 설정·키·최근 오류로 표시 상태를 계산한다. 이 조회 자체로 외부 API를 호출하지 않는다.
    const config = this.requireConfig(role);
    if (!config.enabled) return 'disabled';
    if (!resolveModelApiKey(this.options.env)) return 'missing-key';
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
  if (model !== undefined) validateModel(model);
  return { provider, model, enabled };
}

function validateModel(model: string): void {
  if (!/^gemini-[a-z0-9][a-z0-9._-]*$/i.test(model)) {
    throw validationError('model 값이 올바르지 않습니다.', { model: 'gemini-* 모델만 허용됩니다.' });
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 100;
  return Math.max(1, Math.min(limit, 500));
}
