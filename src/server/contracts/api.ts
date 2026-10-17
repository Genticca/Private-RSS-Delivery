/** HTTP API에서 주고받는 DTO다. DB 레코드의 내부 필드와 분리해 관리한다. */
import type { NormalizedItem, Profile, SourceProfile } from '../domain/normalize/types.js';
import type { FetchOptions } from '../security/types.js';
import type { DiscordWebhookPayload } from './render-context.js';

export type SourceId = string;

export type GroupId = number;

export type TemplateId = number;

export type EventKind = 'fetch' | 'delivery' | 'translation';

export type FetchEventStatus = 'ok' | 'not_modified' | 'error';

export type DeliveryEventStatus = 'success' | 'failed';

export type TranslationEventStatus = 'success' | 'failed' | 'cache_hit' | 'skipped';

export type EventStatus = FetchEventStatus | DeliveryEventStatus | TranslationEventStatus;

export type ModelStatus = 'ready' | 'missing-key' | 'invalid-key' | 'cooldown';

export interface SourceDto {
  consecutiveFailures?: number;
  id: SourceId;
  feedUrl: string;
  name: string | null;
  enabled: boolean;
  profile: SourceProfile;
  detectedProfile: Profile | null;
  pollIntervalSeconds: number;
  translate: boolean;
  templateId: TemplateId | null;
  webhookName: string | null;
  webhookAvatarUrl: string | null;
  groupIds: GroupId[];
  groupNames: string[];
  silent: boolean;
  mentionRoleIds: string[];
  mentionUserIds: string[];
  mentionEveryone: boolean;
  mentionHere: boolean;
  threadId: string | null;
  threadName: string | null;
  appliedTags: string[];
  editInPlace: boolean;
  lastOutcome?: FetchEventStatus | null;
}

export interface CreateSourceRequest {
  feedUrl: string;
  name?: string | null;
  profile?: SourceProfile;
  pollIntervalSeconds?: number;
  translate?: boolean;
  templateId?: TemplateId | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
  fetchOptions?: FetchOptions;
  groupIds?: GroupId[];
  silent?: boolean;
  mentionRoleIds?: string[];
  mentionUserIds?: string[];
  mentionEveryone?: boolean;
  mentionHere?: boolean;
  threadId?: string | null;
  threadName?: string | null;
  appliedTags?: string[];
  editInPlace?: boolean;
}

export type UpdateSourceRequest = Partial<CreateSourceRequest>;

export interface GroupDto {
  id: GroupId;
  name: string;
  webhookName: string | null;
  webhookAvatarUrl: string | null;
  hasWebhook: boolean;
  maskedWebhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupRequest {
  name: string;
  webhookUrl?: string | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
}

export type UpdateGroupRequest = Partial<CreateGroupRequest> & {
  clearWebhook?: boolean;
};

export interface TemplateDto {
  id: TemplateId;
  name: string;
  label: string;
  body: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateRequest {
  // 식별자(name 슬러그)는 사용자 입력이 아니라 서버가 label에서 자동 생성한다(TemplateService.create). 폼도 label/body/cloneFrom만 전송.
  label: string;
  body: string;
  cloneFrom?: TemplateId;
}

export interface UpdateTemplateRequest {
  label?: string;
  body?: string;
}

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

export interface EventLogDto {
  id: number;
  createdAt: string;
  kind: EventKind;
  status: EventStatus;
  sourceId: SourceId | null;
  sourceName: string | null;
  itemId: number | null;
  jobId: number | null;
  httpStatus: number | null;
  durationMs: number | null;
  itemCount: number | null;
  detail: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextBefore: number | null;
}

export type LogsResponse = PaginatedResponse<EventLogDto>;
