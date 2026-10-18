/**
 * 필드별 번역 캐시. 성공값·실패 대기와 진행 중 요청 공유를 조합해 같은 원문 호출을 줄인다.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import Handlebars from 'handlebars';
import type { SourceRecord } from '../sources/repository.js';
import type { ItemRecord } from '../feed/repository.js';
import type { EventLogRepository } from '../logs/repository.js';
import { nowIso } from '../core/db.js';
import { effectiveProfile } from '../feed/normalize.js';
import { TARGET_LANG, type ModelTranslator } from './translator.js';

export interface TranslationCacheRecord {
  cacheKey: string;
  field: 'title' | 'summary';
  status: 'success' | 'failed';
  value: string | null;
  lastError: string | null;
  retryAfter: string | null;
}

/** 필드별 번역 성공값과 실패 대기 시각을 저장한다. 사용 기록은 event_log에 남긴다. */
export class TranslationCacheRepository {
  /** 정리 대상 시각보다 오래된 실패 캐시만 제거하며 성공 번역값은 보존한다. */
  pruneFailed(before: string): void {
    this.db.prepare("DELETE FROM translation_cache WHERE status = 'failed' AND updated_at < ?").run(before);
  }

  constructor(private readonly db: Database.Database) { }

  get(cacheKey: string): TranslationCacheRecord | null {
    return this.db.prepare('SELECT cache_key AS cacheKey, field, status, value, last_error AS lastError, retry_after AS retryAfter FROM translation_cache WHERE cache_key = ?').get(cacheKey) as TranslationCacheRecord ?? null;
  }

  save(row: TranslationCacheRecord, now: string): void {
    this.db.prepare(`INSERT INTO translation_cache(cache_key, field, status, value, last_error, retry_after, updated_at)
      VALUES (@cacheKey, @field, @status, @value, @lastError, @retryAfter, @now)
      ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, value = excluded.value,
        last_error = excluded.last_error, retry_after = excluded.retry_after, updated_at = excluded.updated_at`).run({ ...row, now });
  }
}

export type TranslationField = 'title' | 'summary';

export const TRANSLATION_POLICY_VERSION = '2';

/** 원문·필드·언어·프로필·정책 버전을 묶어 다른 번역 문맥의 값을 재사용하지 않게 한다. */
export function translationCacheKey(
  field: TranslationField,
  inputText: string,
  contextProfile: string,
  targetLang = 'ko'
): string {
  // 정책이나 문맥이 달라지면 같은 원문이라도 이전 번역을 재사용하지 않는다.
  return createHash('sha256').update(JSON.stringify({
    policyVersion: TRANSLATION_POLICY_VERSION,
    targetLang,
    field,
    contextProfile,
    glossaryVersion: '1',
    inputText
  })).digest('hex');
}

/** 템플릿의 실제 참조에서 번역할 필드를 고른다. 해석이 불확실하면 두 필드를 모두 번역한다. */
export function requiredTranslationFields(
  templateBody: string | undefined,
  source: Pick<SourceRecord, 'threadId' | 'threadName' | 'appliedTags'>
): TranslationField[] {
  if (templateBody === undefined) return ['title', 'summary'];
  const fields = new Set<TranslationField>();
  let uncertain = false;
  try {
    const ast = Handlebars.parse(templateBody);
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const value = node as Record<string, unknown>;
      if (value.type === 'PathExpression') {
        const parts = Array.isArray(value.parts) ? value.parts.map(String) : [];
        if (value.data === true && parts[0] === 'root') parts.shift();
        const path = parts.length > 0 ? parts.join('.') : String(value.original);
        if (path === 'item.title' || path.startsWith('item.title.')) fields.add('title');
        else if (path === 'item.summary' || path.startsWith('item.summary.')) fields.add('summary');
        else if (!/^(item\.|source\.|feed\.|json$|truncate$|formatDate$|default$|if$|unless$|each$|with$|eq$|and$|or$)/.test(path))
          uncertain = true;
      }
      for (const [key, child] of Object.entries(value)) if (key !== 'loc') visit(child);
    };
    visit(ast);
  } catch {
    uncertain = true;
  }
  if (!source.threadId && !source.threadName && source.appliedTags.length > 0) fields.add('title');
  // 템플릿 참조를 확실히 해석하지 못하면 누락을 막기 위해 두 필드를 모두 번역한다.
  return uncertain ? ['title', 'summary'] : [...fields];
}

/** 빈 값·알려진 장애 단계·이미 한국어인 값은 외부 호출 없이 처리한다. null은 공급자 호출 필요를 뜻한다. */
export function localTranslation(text: string, targetLang: string): string | null {
  if (text.trim() === '') return text;
  if (targetLang !== 'ko') return null;
  const stages: Record<string, string> = {
    Investigating: '조사 중',
    Identified: '원인 확인',
    Monitoring: '모니터링 중',
    Resolved: '해결됨',
    Update: '업데이트'
  };
  if (Object.hasOwn(stages, text)) return stages[text];
  return /[가-힣]/.test(text) && !/[A-Za-z]/.test(text) ? text : null;
}

interface FieldResult {
  value: string;
  translated: boolean;
}

interface Deferred {
  promise: Promise<FieldResult>;
  resolve: (value: FieldResult) => void;
}

type TranslationItem = Pick<ItemRecord, 'title' | 'summary'> & Partial<Pick<ItemRecord, 'id'>>;

type TranslationSource = Pick<SourceRecord, 'profileSetting' | 'detectedProfile' | 'threadId' | 'threadName' | 'appliedTags'>;

interface CachedTranslationOptions {
  templateBody?: string;
  jobId?: number;
  now?: string;
  /** 동일 입력의 실패 캐시 대기만 무시한다. API 키 자체의 대기는 번역기에서 계속 적용한다. */
  ignoreCooldown?: boolean;
  /** 성공 캐시를 우회한다. 이미 진행 중인 동일 요청의 공유까지 해제하는 옵션은 아니다. */
  fresh?: boolean;
}

interface OwnedField {
  key: string;
  deferred: Deferred;
}

export interface TranslationCacheServiceOptions {
  repositories: {
    translationCache: TranslationCacheRepository;
    eventLog: Pick<EventLogRepository, 'append'>
  };
  translator: Pick<ModelTranslator, 'translate'>;
  failureCooldownMs?: number;
}

/** 캐시 상태와 실행 중 Promise의 소유권을 관리한다. 같은 필드를 기다리는 요청은 결과를 공유한다. */
export class TranslationCacheService {
  // 같은 필드·본문·언어의 동시 요청은 하나의 번역 결과를 함께 기다린다.
  private readonly inFlightTranslations = new Map<string, Promise<FieldResult>>();
  constructor(private readonly options: TranslationCacheServiceOptions) { }

  /** 로컬 처리 → 성공 캐시 → 실패 대기 → 실행 중 요청 공유 → 새 요청 순으로 필드별 경로를 결정한다. */
  async translate(item: TranslationItem, source: TranslationSource, options: CachedTranslationOptions = {}) {
    const now = options.now ?? nowIso();
    const cacheRepository = this.options.repositories.translationCache;
    // 실제 요청 없이 끝난 필드도 번역 로그에 남긴다. 같은 요청 합치기는 캐시 사용으로 본다.
    const record = (status: 'cache_hit' | 'skipped', field: TranslationField, reason: string) =>
      this.options.repositories.eventLog.append({
        kind: 'translation', status, itemId: item.id, jobId: options.jobId, detail: `${field}: ${reason}`, createdAt: now
      });
    const profile = effectiveProfile(source.profileSetting, source.detectedProfile);
    const fields = requiredTranslationFields(options.templateBody, source);
    // pendingFields는 기다릴 모든 필드, ownedFields는 이번 호출이 직접 번역해야 할 필드다.
    const pendingFields = new Map<TranslationField, Promise<FieldResult>>();
    const ownedFields = new Map<TranslationField, OwnedField>();
    try {
      for (const field of fields) {
        const text = item[field] ?? '';
        const local = localTranslation(text, TARGET_LANG);
        if (local !== null) {
          record('skipped', field, 'local');
          pendingFields.set(field, Promise.resolve({ value: local, translated: true }));
          continue;
        }
        const key = translationCacheKey(field, text, profile, TARGET_LANG);
        const cached = cacheRepository.get(key);
        if (!options.fresh && cached?.status === 'success' && cached.value !== null) {
          record('cache_hit', field, 'cache');
          pendingFields.set(field, Promise.resolve({ value: cached.value, translated: true }));
        } else if (!options.ignoreCooldown && cached?.retryAfter && cached.retryAfter > now) {
          record('skipped', field, 'failure_cooldown');
          pendingFields.set(field, Promise.resolve({ value: text, translated: false }));
        } else if (this.inFlightTranslations.has(key)) {
          record('cache_hit', field, 'single_flight');
          pendingFields.set(field, this.inFlightTranslations.get(key)!);
        } else {
          // await 전에 필드의 Promise를 등록한다. 다른 호출은 이 소유자가 끝낼 결과에 합류한다.
          let resolve!: Deferred['resolve'];
          const promise = new Promise<FieldResult>((done) => {
            resolve = done;
          });
          const deferred = { promise, resolve };
          ownedFields.set(field, { key, deferred });
          this.inFlightTranslations.set(key, promise);
          pendingFields.set(field, promise);
        }
      }
    } catch (error) {
      // 필드 선택 도중 저장소·로그 오류가 나도 이미 합류한 요청이 무한히 기다리지 않게 원문으로 끝낸다.
      for (const [field, { key, deferred }] of ownedFields) {
        deferred.resolve({ value: item[field] ?? '', translated: false });
        this.inFlightTranslations.delete(key);
      }
      throw error;
    }
    if (ownedFields.size > 0) {
      await this.translateOwnedFields(item, ownedFields, now, options.jobId);
    }
    const resolved = new Map<TranslationField, FieldResult>();
    await Promise.all([...pendingFields].map(async ([field, result]) => {
      resolved.set(field, await result);
    }));
    return {
      title: resolved.get('title')?.value ?? item.title ?? '',
      summary: resolved.get('summary')?.value ?? item.summary ?? '',
      translated: fields.every((field) => resolved.get(field)?.translated === true),
      fields
    };
  }

  /** 이번 호출이 소유한 필드만 번역하며, 실패 시에도 함께 기다리는 요청에 원문을 돌려준다. */
  private async translateOwnedFields(
    item: TranslationItem,
    ownedFields: ReadonlyMap<TranslationField, OwnedField>,
    now: string,
    jobId?: number
  ): Promise<void> {
    const cacheRepository = this.options.repositories.translationCache;
    const input = {
      title: ownedFields.has('title') ? item.title ?? '' : '',
      summary: ownedFields.has('summary') ? item.summary ?? '' : '',
      itemId: item.id,
      jobId
    };
    try {
      const result = await this.options.translator.translate(input);
      for (const [field, { key, deferred }] of ownedFields) {
        cacheRepository.save({
          cacheKey: key,
          field,
          status: result.translated ? 'success' : 'failed',
          value: result.translated ? result[field] : null,
          lastError: result.translated ? null : 'translation_failed',
          retryAfter: result.translated ? null : new Date(Date.parse(now) + (this.options.failureCooldownMs ?? 300_000)).toISOString()
        }, now);
        deferred.resolve({ value: result.translated ? result[field] : item[field] ?? '', translated: result.translated });
      }
    } catch {
      let persistenceError: unknown;
      // 실패 캐시 저장이 다시 실패해도 모든 대기자를 먼저 해제하고 저장소 오류는 그 뒤 전파한다.
      for (const [field, { key, deferred }] of ownedFields) {
        try {
          cacheRepository.save({
            cacheKey: key,
            field,
            status: 'failed',
            value: null,
            lastError: 'translation_failed',
            retryAfter: new Date(Date.parse(now) + (this.options.failureCooldownMs ?? 300_000)).toISOString()
          }, now);
        } catch (error) {
          persistenceError = error;
        }
        deferred.resolve({ value: item[field] ?? '', translated: false });
      }
      if (persistenceError) throw persistenceError;
    } finally {
      for (const { key } of ownedFields.values()) this.inFlightTranslations.delete(key);
    }
  }
}
