import type { TranslationEventStatus, EventLogRepository } from '../logs/repository.js';
import { requireObject, optionalString, optionalBoolean } from '../core/input.js';
import { validationError } from '../core/errors.js';
import { nowIso } from '../core/db.js';
import type { ModelKeyDiagnostics, ModelTranslator } from './translator.js';
import type { TranslationCacheService } from './cache.js';
import { resolveModelCredentials, DEFAULT_MODEL } from './gemini.js';

export type ModelStatus = 'ready' | 'missing-key' | 'invalid-key' | 'cooldown';

/** 번역 모델은 환경 변수(GEMINI_MODEL, PRIMARY_MODEL_API_KEY)로 정한다. 키 원문은 응답에 넣지 않는다. */
export interface ModelDiagnosticsResponse {
  model: string;
  status: ModelStatus;
  lastRequestAt: string | null;
  /** 'success', 실패 코드(timeout·invalid-key 등) 또는 호출 전 안내 문구다. */
  lastRequestResult: string;
  counts: Record<TranslationEventStatus, number>;
  keys: ModelKeyDiagnostics;
}

export interface ModelServiceOptions {
  repositories: {
    eventLog: Pick<EventLogRepository, 'latestTranslationRequest' | 'countByStatus'>;
  };
  env?: NodeJS.ProcessEnv;
  /** GEMINI_MODEL 환경 변수에서 읽은 모델 이름. */
  model?: string;
  now?: () => string;
  translation?: TranslationCacheService;
  translator?: Pick<ModelTranslator, 'getKeyStatus'>;
}

/** 번역 모델 상태와 진단을 제공한다. 모델·키는 환경 변수로만 바꾸며 API 키 자체는 응답에 담지 않는다. */
export class ModelService {
  constructor(private readonly options: ModelServiceOptions) { }

  getDiagnostics(): ModelDiagnosticsResponse {
    const eventLog = this.options.repositories.eventLog;
    const request = eventLog.latestTranslationRequest();
    const counts = eventLog.countByStatus('translation');
    const credentials = resolveModelCredentials(this.options.env);
    const keys: ModelKeyDiagnostics = this.options.translator?.getKeyStatus() ?? {
      activeKey: credentials[0]?.slot ?? null,
      primary: { state: credentials.some((key) => key.slot === 'primary') ? 'ready' : 'missing', retryAt: null },
      fallback: { state: credentials.some((key) => key.slot === 'fallback') ? 'ready' : 'missing', retryAt: null }
    };
    return {
      model: this.options.model ?? DEFAULT_MODEL,
      status: this.status(keys, request?.status === 'failed' ? request.detail : null),
      lastRequestAt: request?.createdAt ?? null,
      lastRequestResult: request ? request.detail ?? request.status : '아직 호출하지 않음',
      keys,
      counts: {
        success: counts.success ?? 0,
        failed: counts.failed ?? 0,
        cache_hit: counts.cache_hit ?? 0,
        skipped: counts.skipped ?? 0
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

  private status(keys: ModelKeyDiagnostics, latestFailure: string | null): ModelStatus {
    // 키 설정과 최근 실패로 표시 상태를 계산한다. 이 조회 자체로 외부 API를 호출하지 않는다.
    if (keys.primary.state === 'missing' && keys.fallback.state === 'missing') return 'missing-key';
    if (keys.activeKey) return 'ready';
    if (latestFailure?.endsWith('invalid-key')) return 'invalid-key';
    return 'cooldown';
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}
