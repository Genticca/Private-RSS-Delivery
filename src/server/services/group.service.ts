import type Database from 'better-sqlite3';
import type { CreateGroupRequest, GroupDto, UpdateGroupRequest } from '../contracts/api.js';
import { nowIso } from '../db/time.js';
import type { DeliveryBindingService } from './delivery-binding.service.js';
import type { GroupRepository } from '../db/index.js';
import { verifyWebhookUrlSafe } from '../security/index.js';
import { conflict, notFound, validationError } from './errors.js';
import { toGroupDto } from './serialization.js';
import { optionalBoolean, optionalString, requireObject, requiredString, validateOptionalWebhookUrl } from './validation.js';

export interface GroupServiceOptions {
  db: Database.Database;
  repositories: {
    groups: Pick<GroupRepository, 'list' | 'findByNameNocase' | 'create' | 'update' | 'delete' | 'getById'>;
  };
  now?: () => string;
  verifyWebhookUrl?: (value: string) => Promise<unknown>;
  bindings?: DeliveryBindingService;
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
      this.options.bindings?.reconcileAll(this.now());
      return toGroupDto(updated);
    })();
  }

  remove(id: number): void {
    this.requireGroup(id);
    this.options.db.transaction(() => {
      if (!this.options.repositories.groups.delete(id)) throw notFound('그룹을 찾을 수 없습니다.');
      this.options.bindings?.reconcileAll(this.now());
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
