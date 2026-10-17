import type { ItemRecord, SourceRecord, TranslationCacheRepository, ModelConfigRepository } from '../db/index.js';
import { nowIso } from '../db/time.js';
import { effectiveProfile } from '../domain/normalize/profile.js';
import { localTranslation, requiredTranslationFields, translationCacheKey, type TranslationField } from '../domain/translation/policy.js';
import type { ModelTranslator } from './translator.js';

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
  ignoreCooldown?: boolean;
  fresh?: boolean;
}

interface OwnedField {
  key: string;
  deferred: Deferred;
}

export interface TranslationCacheServiceOptions {
  repositories: {
    translationCache: TranslationCacheRepository;
    modelConfig: Pick<ModelConfigRepository, 'getByRole'>
  };
  translator: Pick<ModelTranslator, 'translate'>;
  failureCooldownMs?: number;
}

export class TranslationCacheService {
  // 같은 필드·본문·언어의 동시 요청은 하나의 번역 결과를 함께 기다린다.
  private readonly inFlightTranslations = new Map<string, Promise<FieldResult>>();
  constructor(private readonly options: TranslationCacheServiceOptions) { }

  async translate(item: TranslationItem, source: TranslationSource, options: CachedTranslationOptions = {}) {
    const now = options.now ?? nowIso();
    const cacheRepository = this.options.repositories.translationCache;
    const targetLang = this.options.repositories.modelConfig.getByRole('primary')?.targetLang ?? 'ko';
    const profile = effectiveProfile(source.profileSetting, source.detectedProfile);
    const fields = requiredTranslationFields(options.templateBody, source);
    // pendingFields는 기다릴 모든 필드, ownedFields는 이번 호출이 직접 번역해야 할 필드다.
    const pendingFields = new Map<TranslationField, Promise<FieldResult>>();
    const ownedFields = new Map<TranslationField, OwnedField>();
    try {
      for (const field of fields) {
        const text = item[field] ?? '';
        const local = localTranslation(text, targetLang);
        if (local !== null) {
          cacheRepository.event('local_skip', now, item.id, options.jobId);
          pendingFields.set(field, Promise.resolve({ value: local, translated: true }));
          continue;
        }
        const key = translationCacheKey(field, text, profile, targetLang);
        const cached = cacheRepository.get(key);
        if (!options.fresh && cached?.status === 'success' && cached.value !== null) {
          cacheRepository.event('cache_hit', now, item.id, options.jobId);
          pendingFields.set(field, Promise.resolve({ value: cached.value, translated: true }));
        } else if (!options.ignoreCooldown && cached?.retryAfter && cached.retryAfter > now) {
          cacheRepository.event('failure_cooldown', now, item.id, options.jobId);
          pendingFields.set(field, Promise.resolve({ value: text, translated: false }));
        } else if (this.inFlightTranslations.has(key)) {
          cacheRepository.event('single_flight', now, item.id, options.jobId);
          pendingFields.set(field, this.inFlightTranslations.get(key)!);
        } else {
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
