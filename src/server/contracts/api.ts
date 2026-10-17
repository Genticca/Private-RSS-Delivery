/** HTTP API에서 주고받는 DTO다. DB 레코드의 내부 필드와 분리해 관리한다. */
import type { NormalizedItem, Profile, SourceProfile } from '../domain/normalize/types.js';
import type { FetchOptions } from '../security/types.js';
import type { DiscordWebhookPayload } from './render-context.js';

export type SourceId = string;

export type GroupId = number;

export type TemplateId = number;

export type DeliveryStatus = 'success' | 'failed' | 'skipped';

export type ItemDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'historical';

export type FetchOutcome = '200' | '304' | 'error';

export type ModelProvider = 'gemini';

export type ModelRole = 'primary';

export type ModelStatus = 'ready' | 'disabled' | 'missing-key' | 'invalid-key';

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
  lastOutcome?: FetchOutcome | null;
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

export interface SetSourceEnabledRequest {
  enabled: boolean;
}

export interface SetSourceGroupsRequest {
  groupIds: GroupId[];
}

export interface QueuedResponse {
  queued: true;
}

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

export interface ModelConfigEntryDto {
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  enabled: boolean;
  targetLang: string;
  promptLogMaxBytes: number;
}

export interface ModelConfigResponse {
  primary: ModelConfigEntryDto;
  targetLang: string;
  promptLogMaxBytes: number;
}

export interface ModelStatusResponse {
  primary: ModelStatus;
}

export interface ModelUsageDto {
  httpRequested?: boolean;
  itemId?: number | null;
  jobId?: number | null;
  id: number;
  role: ModelRole;
  provider: ModelProvider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface DeliveryLogDto {
  id: number;
  itemId: number;
  attemptNo: number;
  status: DeliveryStatus;
  httpStatus: number | null;
  error: string | null;
  renderedBytes: number | null;
  destinationKey: string | null;
  contentHash: string | null;
  failureReason: string | null;
  discordMessageId: string | null;
  createdAt: string;
}

export interface FetchLogDto {
  id: number;
  sourceId: SourceId;
  sourceName: string | null;
  outcome: FetchOutcome;
  httpStatus: number | null;
  itemsNew: number;
  itemsHistorical: number;
  itemsChanged: number;
  itemsSkipped: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextBefore: number | null;
}

export type LogsResponse = PaginatedResponse<DeliveryLogDto> | PaginatedResponse<FetchLogDto>;

export type ModelUsageResponse = PaginatedResponse<ModelUsageDto>;
