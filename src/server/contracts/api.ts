import type { SourceId } from '../sources/service.js';
import type { DiscordWebhookPayload } from '../templates/render.js';
import type { NormalizedItem } from '../feed/parse.js';
import type { TranslationEventStatus } from '../logs/repository.js';

export type ModelStatus = 'ready' | 'missing-key' | 'invalid-key' | 'cooldown';

export type PreviewMode = 'sample' | 'live';

export interface PreviewRequest {
  templateBody: string;
  sourceId?: SourceId;
  mode: PreviewMode;
}

export type PreviewErrorStage = 'fetch' | 'render' | 'validate';

export interface PreviewError {
  stage: PreviewErrorStage;
  message: string;
  path?: string;
}

export type PreviewResponse =
  | {
    ok: true;
    payload: DiscordWebhookPayload
  }
  | {
    ok: false;
    errors: PreviewError[]
  };

export type SampleItemResponse = NormalizedItem;

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

export interface ModelKeyDiagnostics {
  /** 대기 중이 아닌 키 중 다음 요청에 사용할 우선순위가 가장 높은 슬롯. */
  activeKey: 'primary' | 'fallback' | null;
  primary: { state: 'missing' | 'ready' | 'cooldown'; retryAt: string | null };
  fallback: { state: 'missing' | 'ready' | 'cooldown'; retryAt: string | null };
}
