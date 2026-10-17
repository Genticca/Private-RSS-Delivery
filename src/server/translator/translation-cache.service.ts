import type { ItemRecord, SourceRecord, TranslationCacheRepository, ModelConfigRepository } from '../db/index.js';
import { nowIso } from '../db/time.js';
import { effectiveProfile } from '../domain/normalize/profile.js';
import { localTranslation, requiredTranslationFields, translationCacheKey, type TranslationField } from '../domain/translation/policy.js';
import type { ModelTranslator } from './translator.js';

interface FieldResult { value: string; translated: boolean; }
interface Deferred { promise: Promise<FieldResult>; resolve: (value: FieldResult) => void; }
export interface TranslationCacheServiceOptions {
  repositories: { translationCache: TranslationCacheRepository; modelConfig: Pick<ModelConfigRepository, 'getByRole'> };
  translator: Pick<ModelTranslator, 'translate'>;
  failureCooldownMs?: number;
}

export class TranslationCacheService {
  private readonly flights = new Map<string, Promise<FieldResult>>();
  constructor(private readonly options: TranslationCacheServiceOptions) {}

  async translate(item: Pick<ItemRecord, 'title' | 'summary'> & Partial<Pick<ItemRecord, 'id'>>, source: Pick<SourceRecord, 'profileSetting' | 'detectedProfile' | 'threadId' | 'threadName' | 'appliedTags'>, options: { templateBody?: string; jobId?: number; now?: string; ignoreCooldown?: boolean; fresh?: boolean } = {}) {
    const now = options.now ?? nowIso();
    const repo = this.options.repositories.translationCache;
    const targetLang = this.options.repositories.modelConfig.getByRole('primary')?.targetLang ?? 'ko';
    const profile = effectiveProfile(source.profileSetting, source.detectedProfile);
    const fields = requiredTranslationFields(options.templateBody, source);
    const pending = new Map<TranslationField, Promise<FieldResult>>();
    const owned = new Map<TranslationField, { key: string; deferred: Deferred }>();
    try {
      for (const field of fields) {
        const text = item[field] ?? '';
        const local = localTranslation(text, targetLang);
        if (local !== null) {
          repo.event('local_skip', now, item.id, options.jobId);
          pending.set(field, Promise.resolve({ value: local, translated: true }));
          continue;
        }
        const key = translationCacheKey(field, text, profile, targetLang);
        const cached = repo.get(key);
        if (!options.fresh && cached?.status === 'success' && cached.value !== null) {
          repo.event('cache_hit', now, item.id, options.jobId);
          pending.set(field, Promise.resolve({ value: cached.value, translated: true }));
        } else if (!options.ignoreCooldown && cached?.retryAfter && cached.retryAfter > now) {
          repo.event('failure_cooldown', now, item.id, options.jobId);
          pending.set(field, Promise.resolve({ value: text, translated: false }));
        } else if (this.flights.has(key)) {
          repo.event('single_flight', now, item.id, options.jobId);
          pending.set(field, this.flights.get(key)!);
        } else {
          let resolve!: Deferred['resolve'];
          const promise = new Promise<FieldResult>((done) => { resolve = done; });
          const deferred = { promise, resolve };
          owned.set(field, { key, deferred });
          this.flights.set(key, promise);
          pending.set(field, promise);
        }
      }
    } catch (error) {
      for (const [field, { key, deferred }] of owned) {
        deferred.resolve({ value: item[field] ?? '', translated: false });
        this.flights.delete(key);
      }
      throw error;
    }
    if (owned.size > 0) {
      const input = { title: owned.has('title') ? item.title ?? '' : '', summary: owned.has('summary') ? item.summary ?? '' : '', itemId: item.id, jobId: options.jobId };
      try {
        const result = await this.options.translator.translate(input);
        for (const [field, { key, deferred }] of owned) {
          repo.save({ cacheKey: key, field, status: result.translated ? 'success' : 'failed', value: result.translated ? result[field] : null,
            lastError: result.translated ? null : 'translation_failed', retryAfter: result.translated ? null : new Date(Date.parse(now) + (this.options.failureCooldownMs ?? 300_000)).toISOString() }, now);
          deferred.resolve({ value: result.translated ? result[field] : item[field] ?? '', translated: result.translated });
        }
      } catch {
        let persistenceError: unknown;
        for (const [field, { key, deferred }] of owned) {
          try {
            repo.save({ cacheKey: key, field, status: 'failed', value: null, lastError: 'translation_failed', retryAfter: new Date(Date.parse(now) + (this.options.failureCooldownMs ?? 300_000)).toISOString() }, now);
          } catch (error) { persistenceError = error; }
          deferred.resolve({ value: item[field] ?? '', translated: false });
        }
        if (persistenceError) throw persistenceError;
      } finally { for (const { key } of owned.values()) this.flights.delete(key); }
    }
    const resolved = new Map<TranslationField, FieldResult>();
    await Promise.all([...pending].map(async ([field, result]) => { resolved.set(field, await result); }));
    return { title: resolved.get('title')?.value ?? item.title ?? '', summary: resolved.get('summary')?.value ?? item.summary ?? '',
      translated: fields.every((field) => resolved.get(field)?.translated === true), fields };
  }
}
