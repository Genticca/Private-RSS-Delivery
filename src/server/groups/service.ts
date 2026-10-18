/**
 * 발신 그룹 관리. 웹훅 검증과 마스킹을 수행하고 설정 변경에 맞춰 발송 연결을 갱신한다.
 */
import type Database from 'better-sqlite3';
import { conflict, validationError, notFound } from '../core/errors.js';
import { verifyWebhookUrlSafe, assertSafeWebhookUrl } from '../net/webhook-url.js';
import { nowIso } from '../core/db.js';
import {
  requireObject,
  requiredString,
  optionalString,
  optionalBoolean,
  securityValidationError
} from '../core/input.js';
import type { GroupRepository, GroupRecord } from './repository.js';

export type GroupId = number;

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

export interface GroupServiceOptions {
  db: Database.Database;
  repositories: {
    groups: Pick<GroupRepository, 'list' | 'findByNameNocase' | 'create' | 'update' | 'delete' | 'getById'>;
  };
  now?: () => string;
  verifyWebhookUrl?: (value: string) => Promise<unknown>;
  reconcileAllDestinations?: (now: string) => void;
}

/** 그룹 입력을 검증하고 웹훅 변경에 맞춰 소스의 발송 연결을 함께 조정한다. */
export class GroupService {
  constructor(private readonly options: GroupServiceOptions) { }

  list(): GroupDto[] {
    return this.options.repositories.groups.list().map(toGroupDto);
  }

  get(id: number): GroupDto {
    return toGroupDto(this.requireGroup(id));
  }

  /** 그룹 이름 중복과 웹훅 주소를 확인한 뒤 재사용 가능한 발신 채널을 만든다. */
  async create(value: unknown): Promise<GroupDto> {
    const input = normalizeGroupCreate(value);
    if (this.options.repositories.groups.findByNameNocase(input.name)) {
      throw conflict('이미 존재하는 그룹 이름입니다.', { name: '이미 사용 중입니다.' });
    }
    if (input.webhookUrl) await this.verifyWebhookUrl(input.webhookUrl);
    const timestamp = this.now();
    return toGroupDto(
      this.options.repositories.groups.create({
        ...input,
        webhookUrl: input.webhookUrl ?? null,
        webhookName: input.webhookName ?? null,
        webhookAvatarUrl: input.webhookAvatarUrl ?? null,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
  }

  /** 빈 웹훅 입력은 유지하고 clearWebhook만 삭제로 처리한다. 연결 갱신도 같은 트랜잭션에서 수행한다. */
  async update(id: number, value: unknown): Promise<GroupDto> {
    const current = this.requireGroup(id);
    const input = normalizeGroupUpdate(value);
    if (input.clearWebhook && input.webhookUrl) {
      throw validationError('webhook 입력이 모순됩니다.', { webhookUrl: 'clearWebhook과 동시에 지정할 수 없습니다.' });
    }
    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) {
      const existing = this.options.repositories.groups.findByNameNocase(input.name);
      if (existing && existing.id !== id) throw conflict('이미 존재하는 그룹 이름입니다.', { name: '이미 사용 중입니다.' });
    }
    if (input.webhookUrl) await this.verifyWebhookUrl(input.webhookUrl);
    // 비어 있는 폼 입력은 기존 웹훅을 유지한다. clearWebhook을 선택한 경우만 제거한다.
    const webhookUrl = input.clearWebhook ? null : input.webhookUrl ?? undefined;
    return this.options.db.transaction(() => {
      const updated = this.options.repositories.groups.update(id, {
        name: input.name,
        webhookUrl,
        webhookName: input.webhookName,
        webhookAvatarUrl: input.webhookAvatarUrl,
        updatedAt: this.now()
      });
      // 변경된 웹훅으로 기존 발송 이력을 옮기지 않고 새 연결 세대로 반영한다.
      this.options.reconcileAllDestinations?.(this.now());
      return toGroupDto(updated);
    })();
  }

  /** 그룹 삭제 후 현재 목적지 집합과 연결 세대를 다시 맞춘다. */
  remove(id: number): void {
    this.requireGroup(id);
    this.options.db.transaction(() => {
      if (!this.options.repositories.groups.delete(id)) throw notFound('그룹을 찾을 수 없습니다.');
      this.options.reconcileAllDestinations?.(this.now());
    })();
  }

  private requireGroup(id: number) {
    const group = this.options.repositories.groups.getById(id);
    if (!group) throw notFound('그룹을 찾을 수 없습니다.');
    return group;
  }

  private async verifyWebhookUrl(value: string): Promise<void> {
    await (this.options.verifyWebhookUrl ?? verifyWebhookUrlSafe)(value);
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

function normalizeGroupCreate(value: unknown): CreateGroupRequest {
  const body = requireObject(value);
  return {
    name: requiredString(body.name, 'name', 200),
    webhookUrl: validateOptionalWebhookUrl(body.webhookUrl),
    webhookName: optionalString(body.webhookName, 'webhookName', 80),
    webhookAvatarUrl: optionalString(body.webhookAvatarUrl, 'webhookAvatarUrl', 2048)
  };
}

function normalizeGroupUpdate(value: unknown): UpdateGroupRequest {
  const body = requireObject(value);
  return {
    name: optionalString(body.name, 'name', 200) ?? undefined,
    webhookUrl: validateOptionalWebhookUrl(body.webhookUrl),
    clearWebhook: optionalBoolean(body.clearWebhook),
    webhookName: optionalString(body.webhookName, 'webhookName', 80),
    webhookAvatarUrl: optionalString(body.webhookAvatarUrl, 'webhookAvatarUrl', 2048)
  };
}

/** 웹훅 원문을 제외하고 연결 유무·마스킹 주소만 관리 응답에 포함한다. */
export function toGroupDto(group: GroupRecord): GroupDto {
  // 웹훅 토큰 원문 대신 설정 여부와 마스킹한 주소만 관리 화면에 전달한다.
  return {
    id: group.id,
    name: group.name,
    webhookName: group.webhookName,
    webhookAvatarUrl: group.webhookAvatarUrl,
    hasWebhook: group.webhookUrl !== null,
    maskedWebhookUrl: maskWebhookUrl(group.webhookUrl),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt
  };
}

/** 주소의 토큰 대부분과 부가 정보를 숨겨 관리 화면에 필요한 식별 정보만 남긴다. */
export function maskWebhookUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    const token = parts.at(-1) ?? '';
    const suffix = token.slice(-4);
    parts[parts.length - 1] = suffix ? `...${suffix}` : '...';
    url.pathname = `/${parts.join('/')}`;
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '...';
  }
}

/** 웹훅 미입력·비우기 의미를 보존하면서 입력된 URL만 Discord 주소 규칙으로 검증한다. */
export function validateOptionalWebhookUrl(value: unknown): string | null | undefined {
  const webhookUrl = optionalString(value, 'webhookUrl', 2048);
  if (webhookUrl === undefined || webhookUrl === null) return webhookUrl;
  try {
    return assertSafeWebhookUrl(webhookUrl).toString();
  } catch (error) {
    throw securityValidationError(error, 'webhookUrl');
  }
}
