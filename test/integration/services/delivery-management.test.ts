import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/server/app.js';
import { harness, BASE, WEBHOOK_A } from '../../mocks/runtime.js';

describe('administrator delivery review', () => {
  it('lists safe job DTOs and renders held work with review controls', async () => {
    const h = await harness(); await h.baseline(); await h.poll(Array.from({ length: 10 }, (_, i) => ({ id: 'item-' + i })));
    const app = createApp({ container: h.container, logger: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/delivery-jobs?state=held' });
      expect(response.statusCode).toBe(200); expect(response.json()).toHaveLength(10);
      expect(response.body).not.toContain(WEBHOOK_A); expect(response.body).not.toContain('itemSnapshot');
      const page = await app.inject('/delivery-jobs');
      expect(page.statusCode).toBe(200); expect(page.body).toContain('검토한 항목 발송'); expect(page.body).toContain('legacy_unknown');
      const job = h.jobs()[0];
      const reviewed = await app.inject({ method: 'POST', url: '/api/delivery-jobs/' + job.id + '/review', payload: { decision: 'send' } });
      expect(reviewed.statusCode).toBe(200); await h.run(new Date().toISOString()); expect(h.post).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it('confirms an unknown POST by message ID and enables later PATCH without another initial POST', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.post.mockResolvedValue({ statusCode: 500 }); await h.run();
    const job = h.jobs()[0];
    expect(() => h.container.services.deliveryManagement.review(job.id, { decision: 'send' })).toThrow();
    h.container.services.deliveryManagement.review(job.id, { decision: 'confirm_delivered', messageId: '123', threadId: '456' });
    await h.poll([{ id: 'one', title: 'Changed' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).toHaveBeenCalledTimes(1);
    expect(h.edit.mock.calls[0][0].destination.threadId).toBe('456');
  });

  it('archives a legacy_unknown row without assigning it to the current connection', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.container.db.prepare("UPDATE delivery_jobs SET state = 'cancelled'").run();
    const inserted = h.container.db.prepare(`INSERT INTO delivery_jobs(item_id, operation, revision, state, item_snapshot, source_snapshot, template_body, created_at)
      VALUES (?, 'initial_post', 1, 'legacy_unknown', '{}', '{}', '', ?)`).run(h.item().id, BASE);
    h.container.services.deliveryManagement.review(Number(inserted.lastInsertRowid), { decision: 'historical' });
    await h.run(); expect(h.post).not.toHaveBeenCalled(); expect(h.item().deliveryStatus).toBe('historical');
  });

  it('provides a translation diagnostic without Discord delivery and distinguishes key presence from actual calls', async () => {
    const provider = { generate: vi.fn(async () => ({ text: '{"title":"<script>alert(1)</script>","summary":"본문"}' })) };
    const h = await harness({}, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'test-only-key' }, translationProviders: { gemini: provider } });
    const app = createApp({ container: h.container, logger: false });
    try {
      const before = await app.inject('/api/model/diagnostics'); expect(before.json().requests.requests).toBe(0);
      const diagnostic = await app.inject({ method: 'POST', url: '/api/model/diagnose', payload: { title: 'Title', summary: 'Body' }, headers: { 'hx-request': 'true' } });
      expect(diagnostic.statusCode).toBe(200); expect(diagnostic.body).toContain('&lt;script&gt;'); expect(diagnostic.body).not.toContain('<script>alert');
      expect(diagnostic.body.toLowerCase()).not.toContain('<!doctype');
      expect(diagnostic.body).toContain('hx-swap-oob="outerHTML"');
      expect(h.post).not.toHaveBeenCalled(); expect(provider.generate).toHaveBeenCalledTimes(1);
      const after = await app.inject('/api/model/diagnostics'); expect(after.json().requests.requests).toBe(1);
      const model = await app.inject('/model'); expect(model.body).toContain('최근 요청'); expect(model.body).not.toContain('test-only-key');
    } finally { await app.close(); }
  });

  it('tombstones old completed content without losing identity or re-posting it when it reappears', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]); await h.run();
    h.container.db.prepare("UPDATE items SET last_seen_at = '2025-01-01T00:00:00.000Z'").run();
    h.r.translationCache.event('cache_hit', '2025-01-01T00:00:00.000Z');
    h.r.translationCache.save({ cacheKey: 'old-failure', field: 'title', status: 'failed', value: null, lastError: 'failed', retryAfter: null }, '2025-01-01T00:00:00.000Z');
    h.r.translationCache.save({ cacheKey: 'old-success', field: 'title', status: 'success', value: '제목', lastError: null, retryAfter: null }, '2025-01-01T00:00:00.000Z');
    await h.container.workers.cleanup.runOnce(BASE);
    expect(h.item()).toMatchObject({ summary: null, contentPruned: true });
    expect(h.r.translationCache.statistics().cache_hit).toBeUndefined();
    expect(h.r.translationCache.get('old-failure')).toBeNull();
    expect(h.r.translationCache.get('old-success')?.value).toBe('제목');
    await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]); await h.run();
    expect(h.item()).toMatchObject({ summary: 'Body', contentPruned: false, contentRevision: 1 });
    expect(h.post).toHaveBeenCalledTimes(1);
  });
});
