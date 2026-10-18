/**
 * 설정 Export/Import. 비밀값을 제외해 내보내고 URL 검증을 마친 입력만 한 트랜잭션으로 반영한다.
 */
import type Database from 'better-sqlite3';
import type { DeliveryBindingService } from '../delivery/bindings.js';
import type { GroupRepository } from '../groups/repository.js';
import type { SourceRepository, SourceGroupRepository } from '../sources/repository.js';
import type { TemplateRepository } from '../templates/repository.js';
import { verifyFeedUrlSafe } from '../net/address.js';
import { validateOptionalWebhookUrl } from '../groups/service.js';
import { verifyWebhookUrlSafe } from '../net/webhook-url.js';
import { nowIso } from '../core/db.js';
import {
  sanitizeFetchOptions,
  parseDocument,
  validateDocument,
  type ExportDocumentV1,
  type ImportMode,
  type ImportPlan,
  type ImportBlockedSource,
  type ExportSource,
  type ExportGroup
} from './document.js';

export interface ExportImportServiceOptions {
  bindings?: DeliveryBindingService;
  db: Database.Database;
  repositories: {
    groups: Pick<GroupRepository, 'list' | 'findByNameNocase' | 'update' | 'create'>;
    sources: Pick<SourceRepository, 'list' | 'findByFeedUrl' | 'update' | 'create'>;
    templates: Pick<TemplateRepository, 'getById' | 'findByName'>;
    sourceGroups: Pick<SourceGroupRepository, 'setGroups' | 'listGroupIdsForSource'>;
  };
  now?: () => string;
  verifyFeedUrl?: (value: string) => Promise<unknown>;
  verifyWebhookUrl?: (value: string) => Promise<unknown>;
}

/** 같은 검증·계획 경로를 미리보기와 실제 적용에 사용한다. 새 소스는 초기 수집부터 시작한다. */
export class ExportImportService {
  constructor(private readonly options: ExportImportServiceOptions) { }

  /** 웹훅 원문·API 키·항목·발송 이력을 제외하고 소스와 그룹 설정만 내보낸다. */
  export(): ExportDocumentV1 {
    const groups = this.options.repositories.groups.list();
    const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
    return {
      kind: 'rss-discord-bridge/export',
      version: 1,
      exportedAt: this.now(),
      groups: groups.map((group) => ({
        name: group.name,
        webhookName: group.webhookName,
        webhookAvatarUrl: group.webhookAvatarUrl
      })),
      sources: this.options.repositories.sources.list().map((source) => {
        const template = source.templateId ? this.options.repositories.templates.getById(source.templateId) : null;
        return {
          feedUrl: source.feedUrl,
          name: source.name,
          enabled: source.enabled,
          profile: source.profileSetting,
          pollIntervalSeconds: source.pollIntervalSeconds,
          translate: source.translate,
          silent: source.silent,
          mentionRoleIds: [...source.mentionRoleIds],
          mentionUserIds: [...source.mentionUserIds],
          mentionEveryone: source.mentionEveryone,
          mentionHere: source.mentionHere,
          threadId: source.threadId,
          threadName: source.threadName,
          appliedTags: [...source.appliedTags],
          editInPlace: source.editInPlace,
          webhookName: source.webhookName,
          webhookAvatarUrl: source.webhookAvatarUrl,
          templateRef: template?.name ?? null,
          fetchOptions: sanitizeFetchOptions(source.fetchOptions),
          groupRefs: this.options.repositories.sourceGroups
            .listGroupIdsForSource(source.id)
            .map((groupId) => groupNameById.get(groupId))
            .filter((name): name is string => name !== undefined)
        };
      })
    };
  }

  /** DB를 변경하지 않고 현재 상태와 입력 문서의 적용 계획을 계산한다. */
  async dryRun(payload: string, mode: ImportMode = 'skip'): Promise<ImportPlan> {
    const { document, blockedFeedUrls } = await this.prepareImport(payload);
    return this.plan(document, mode, blockedFeedUrls);
  }

  /** URL 검증을 다시 수행한 뒤 그룹·소스·배정·연결 갱신을 한 번에 반영한다. */
  async commit(payload: string, mode: ImportMode = 'skip'): Promise<ImportPlan> {
    // DNS 등 외부 검증은 쓰기 트랜잭션 전에 끝내 DB 잠금을 오래 잡지 않는다.
    const { document, blockedFeedUrls } = await this.prepareImport(payload);
    const plan = this.plan(document, mode, blockedFeedUrls);
    const timestamp = this.now();
    this.options.db.transaction(() => {
      for (const group of document.groups) {
        const existing = this.options.repositories.groups.findByNameNocase(group.name);
        if (existing && mode === 'overwrite') {
          this.options.repositories.groups.update(existing.id, {
            name: group.name,
            webhookUrl: group.legacyWebhookUrl ?? undefined,
            webhookName: group.webhookName ?? null,
            webhookAvatarUrl: group.webhookAvatarUrl ?? null,
            updatedAt: timestamp
          });
        } else if (!existing) {
          this.options.repositories.groups.create({
            name: group.name,
            webhookUrl: group.legacyWebhookUrl ?? null,
            webhookName: group.webhookName ?? null,
            webhookAvatarUrl: group.webhookAvatarUrl ?? null,
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
      }

      for (const source of document.sources) {
        const templateId = source.templateRef ? this.options.repositories.templates.findByName(source.templateRef)?.id ?? null : null;
        const groupIds = this.groupIdsForImportSource(source);
        const existing = this.options.repositories.sources.findByFeedUrl(source.feedUrl);
        if (existing && mode === 'skip') continue;
        if (existing && mode === 'overwrite') {
          this.options.repositories.sources.update(existing.id, {
            name: source.name ?? null,
            enabled: source.enabled,
            profileSetting: source.profile as never,
            pollIntervalSeconds: source.pollIntervalSeconds,
            translate: source.translate,
            templateId,
            webhookName: source.webhookName ?? null,
            webhookAvatarUrl: source.webhookAvatarUrl ?? null,
            fetchOptions: source.fetchOptions ?? {},
            silent: source.silent ?? false,
            mentionRoleIds: source.mentionRoleIds ?? [],
            mentionUserIds: source.mentionUserIds ?? [],
            mentionEveryone: source.mentionEveryone ?? false,
            mentionHere: source.mentionHere ?? false,
            threadId: source.threadId ?? null,
            threadName: source.threadName ?? null,
            appliedTags: source.appliedTags ?? [],
            editInPlace: source.editInPlace ?? false
          });
          this.options.repositories.sourceGroups.setGroups(existing.id, groupIds);
          continue;
        }
        const created = this.options.repositories.sources.create({
          feedUrl: source.feedUrl,
          name: source.name ?? null,
          enabled: source.enabled,
          profileSetting: source.profile as never,
          pollIntervalSeconds: source.pollIntervalSeconds,
          translate: source.translate,
          templateId,
          webhookName: source.webhookName ?? null,
          webhookAvatarUrl: source.webhookAvatarUrl ?? null,
          fetchOptions: source.fetchOptions ?? {},
          silent: source.silent ?? false,
          mentionRoleIds: source.mentionRoleIds ?? [],
          mentionUserIds: source.mentionUserIds ?? [],
          mentionEveryone: source.mentionEveryone ?? false,
          mentionHere: source.mentionHere ?? false,
          threadId: source.threadId ?? null,
          threadName: source.threadName ?? null,
          appliedTags: source.appliedTags ?? [],
          editInPlace: source.editInPlace ?? false,
          deliveryCutoffAt: timestamp,
          initialized: false,
          nextPollAt: null,
          createdAt: timestamp
        });
        this.options.repositories.sourceGroups.setGroups(created.id, groupIds);
      }
      this.options.bindings?.reconcileAll(timestamp);
    })();
    return plan;
  }

  /** 문서 검증과 외부 URL 확인 후 차단된 소스는 사유와 함께 적용 대상에서 제외한다. */
  private async prepareImport(payload: string): Promise<{
    document: ExportDocumentV1;
    blockedFeedUrls: ImportBlockedSource[]
  }> {
    const document = parseDocument(payload);
    validateDocument(document);
    const blockedGroupWebhooks = await this.normalizeAndVerifyGroupWebhooks(document.groups);
    const blockedFeedUrls: ImportBlockedSource[] = [];
    const sources: ExportSource[] = [];
    // 차단된 항목은 사유를 남기고 제외한다. 미리보기와 실제 적용에 같은 입력을 사용한다.
    for (const source of document.sources) {
      try {
        await (this.options.verifyFeedUrl ?? verifyFeedUrlSafe)(source.feedUrl);
      } catch (error) {
        blockedFeedUrls.push({ feedUrl: source.feedUrl, kind: 'feed', reason: importBlockReason(error) });
        continue;
      }

      const blockedGroup = this.firstBlockedGroupForSource(source, blockedGroupWebhooks);
      if (blockedGroup) {
        blockedFeedUrls.push({ feedUrl: source.feedUrl, kind: 'webhook', reason: webhookBlockReason(blockedGroup.reason) });
        continue;
      }

      sources.push(source);
    }
    return { document: { ...document, sources }, blockedFeedUrls };
  }

  /** 옛 그룹 웹훅의 호환 입력만 검증한다. 차단된 웹훅은 제거하고 참조하는 소스에도 사유를 전달한다. */
  private async normalizeAndVerifyGroupWebhooks(groups: readonly ExportGroup[]): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();
    for (const group of groups) {
      if (!group.legacyWebhookUrl) continue;
      try {
        group.legacyWebhookUrl = validateOptionalWebhookUrl(group.legacyWebhookUrl) ?? null;
        if (group.legacyWebhookUrl) await (this.options.verifyWebhookUrl ?? verifyWebhookUrlSafe)(group.legacyWebhookUrl);
      } catch (error) {
        group.legacyWebhookUrl = null;
        blocked.set(group.name.toLowerCase(), importBlockReason(error));
      }
    }
    return blocked;
  }

  private firstBlockedGroupForSource(source: ExportSource, blockedGroups: ReadonlyMap<string, string>): {
    name: string;
    reason: string
  } | null {
    for (const groupRef of source.groupRefs) {
      const reason = blockedGroups.get(groupRef.toLowerCase());
      if (reason) return { name: groupRef, reason };
    }
    return null;
  }

  private groupIdsForImportSource(source: ExportSource): number[] {
    return source.groupRefs
      .map((name) => this.options.repositories.groups.findByNameNocase(name)?.id)
      .filter((id): id is number => id !== undefined);
  }

  /** skip·overwrite 규칙과 참조 가능 여부를 기준으로 적용 전 건수·경고를 만든다. */
  private plan(document: ExportDocumentV1, mode: ImportMode, blockedFeedUrls: ImportBlockedSource[]): ImportPlan {
    const warnings: string[] = [];
    const plan: ImportPlan = {
      addedGroups: 0,
      updatedGroups: 0,
      skippedGroups: 0,
      addedSources: 0,
      updatedSources: 0,
      skippedSources: 0,
      blockedSources: blockedFeedUrls.length,
      unresolvedTemplates: 0,
      unresolvedGroups: 0,
      webhookReentryRequired: 0,
      blockedFeedUrls,
      warnings
    };
    for (const blocked of blockedFeedUrls) {
      const target = blocked.kind === 'webhook' ? '웹훅' : '피드';
      warnings.push(`${target} SSRF 검증에 실패해 제외합니다: ${blocked.feedUrl} (${blocked.reason})`);
    }

    for (const group of document.groups) {
      const existing = this.options.repositories.groups.findByNameNocase(group.name);
      if (!existing) {
        plan.addedGroups += 1;
        if (!group.legacyWebhookUrl) {
          plan.webhookReentryRequired += 1;
          warnings.push(`신규 그룹은 webhook 재입력이 필요합니다: ${group.name}`);
        }
      } else if (mode === 'overwrite') plan.updatedGroups += 1;
      else plan.skippedGroups += 1;
    }

    for (const source of document.sources) {
      const existing = this.options.repositories.sources.findByFeedUrl(source.feedUrl);
      if (!source.templateRef || !this.options.repositories.templates.findByName(source.templateRef)) {
        if (source.templateRef) {
          plan.unresolvedTemplates += 1;
          warnings.push(`템플릿을 찾을 수 없어 NULL로 가져옵니다: ${source.templateRef}`);
        }
      }
      for (const groupRef of source.groupRefs) {
        if (!document.groups.some((group) => group.name.toLowerCase() === groupRef.toLowerCase())
          && !this.options.repositories.groups.findByNameNocase(groupRef)) {
          plan.unresolvedGroups += 1;
          warnings.push(`그룹을 찾을 수 없어 멤버십에서 제외합니다: ${groupRef}`);
        }
      }
      if (!existing) {
        plan.addedSources += 1;
      } else if (mode === 'overwrite') {
        plan.updatedSources += 1;
      } else {
        plan.skippedSources += 1;
      }
    }
    return plan;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

function importBlockReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'feed URL 검증 실패';
}

function webhookBlockReason(error: unknown): string {
  return `웹훅 차단: ${importBlockReason(error)}`;
}
