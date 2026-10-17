import { describe } from 'vitest';
import { it } from 'vitest';
import { harness } from '../mocks/runtime.js';
import { createApp } from '../../src/server/app.js';
import { expect } from 'vitest';
import { WEBHOOK_A } from '../mocks/runtime.js';
import { addSecondsIso } from '../../src/server/core/db.js';
import { BASE } from '../mocks/runtime.js';
import { vi } from 'vitest';
import { subtractDaysIso } from '../../src/server/core/db.js';

describe('administrator delivery review', () => {
  it('lists safe job DTOs and renders held work with review controls', async () => {
    const h = await harness(); await h.baseline(); await h.poll(Array.from({ length: 10 }, (_, i) => ({ id: 'item-' + i })));
    const app = createApp({ container: h.container, logger: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/delivery-jobs?state=held' });
      expect(response.statusCode).toBe(200); expect(response.json()).toHaveLength(10);
      expect(response.body).not.toContain(WEBHOOK_A); expect(response.body).not.toContain('itemSnapshot');
      const page = await app.inject('/delivery-jobs');
      expect(page.statusCode).toBe(200); expect(page.body).toContain('검토한 항목 발송'); expect(page.body).toContain('uneditable');
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

  it('archives an unknown POST without sending it again or editing it later', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.post.mockResolvedValueOnce({ statusCode: 500 }); await h.run();
    const job = h.jobs()[0]; expect(job.state).toBe('unknown');
    h.container.services.deliveryManagement.review(job.id, { decision: 'historical' });
    expect(h.r.deliveryJobs.getById(job.id)?.state).toBe('cancelled');
    await h.poll([{ id: 'one', title: 'Changed' }]); await h.run(addSecondsIso(BASE, 1000));
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).not.toHaveBeenCalled();
  });

  it('provides a translation diagnostic without Discord delivery and distinguishes key presence from actual calls', async () => {
    const provider = { generate: vi.fn(async () => ({ text: '{"title":"<script>alert(1)</script>","summary":"본문"}' })) };
    const h = await harness({}, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'test-only-key' }, translationProvider: provider });
    const app = createApp({ container: h.container, logger: false });
    try {
      const before = await app.inject('/api/model/diagnostics');
      expect(before.json()).toMatchObject({ status: 'ready', model: 'gemini-3.1-flash-lite', lastRequestAt: null });
      expect(before.json().counts.success).toBe(0);
      const diagnostic = await app.inject({ method: 'POST', url: '/api/model/diagnose', payload: { title: 'Title', summary: 'Body' }, headers: { 'hx-request': 'true' } });
      expect(diagnostic.statusCode).toBe(200); expect(diagnostic.body).toContain('&lt;script&gt;'); expect(diagnostic.body).not.toContain('<script>alert');
      expect(diagnostic.body.toLowerCase()).not.toContain('<!doctype');
      expect(diagnostic.body).toContain('hx-swap-oob="outerHTML"');
      expect(h.post).not.toHaveBeenCalled(); expect(provider.generate).toHaveBeenCalledTimes(1);
      const after = await app.inject('/api/model/diagnostics'); expect(after.json().counts.success).toBe(1);
      expect(after.json().lastRequestResult).toBe('success');
      const model = await app.inject('/model'); expect(model.body).toContain('최근 요청'); expect(model.body).not.toContain('test-only-key');
    } finally { await app.close(); }
  });

  it('retains failed cache and completed snapshots for 90 days when logs expire after 30 days', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]); await h.run();
    const job = h.jobs()[0];
    const createdAt = subtractDaysIso(BASE, 45);
    h.container.db.prepare('UPDATE delivery_jobs SET completed_at = ? WHERE id = ?').run(createdAt, job.id);
    h.r.eventLog.append({ kind: 'translation', status: 'failed', jobId: job.id, createdAt });
    h.r.translationCache.save({ cacheKey: 'failure', field: 'title', status: 'failed', value: null, lastError: 'failed', retryAfter: null }, createdAt);

    await h.container.workers.cleanup.runOnce(BASE);
    expect(h.r.eventLog.countByStatus('translation').failed).toBeUndefined();
    expect(h.r.translationCache.get('failure')).not.toBeNull();
    expect(h.r.deliveryJobs.getById(job.id)).toMatchObject({
      itemSnapshot: job.itemSnapshot, sourceSnapshot: job.sourceSnapshot, templateBody: job.templateBody, payload: job.payload
    });

    await h.container.workers.cleanup.runOnce(addSecondsIso(BASE, 46 * 24 * 60 * 60));
    expect(h.r.translationCache.get('failure')).toBeNull();
    expect(h.r.deliveryJobs.getById(job.id)).toMatchObject({ itemSnapshot: '{}', sourceSnapshot: '{}', templateBody: '', payload: null });
  });

  it('tombstones old completed content without losing identity or re-posting it when it reappears', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]); await h.run();
    h.container.db.prepare("UPDATE items SET last_seen_at = '2025-01-01T00:00:00.000Z'").run();
    h.r.eventLog.append({ kind: 'translation', status: 'cache_hit', createdAt: '2025-01-01T00:00:00.000Z' });
    h.r.translationCache.save({ cacheKey: 'old-failure', field: 'title', status: 'failed', value: null, lastError: 'failed', retryAfter: null }, '2025-01-01T00:00:00.000Z');
    h.r.translationCache.save({ cacheKey: 'old-success', field: 'title', status: 'success', value: '제목', lastError: null, retryAfter: null }, '2025-01-01T00:00:00.000Z');
    await h.container.workers.cleanup.runOnce(BASE);
    expect(h.item()).toMatchObject({ summary: null, contentPruned: true });
    expect(h.r.eventLog.countByStatus('translation').cache_hit).toBeUndefined();
    expect(h.r.translationCache.get('old-failure')).toBeNull();
    expect(h.r.translationCache.get('old-success')?.value).toBe('제목');
    await h.poll([{ id: 'one', title: 'Title', summary: 'Body' }]); await h.run();
    expect(h.item()).toMatchObject({ summary: 'Body', contentPruned: false, contentRevision: 1 });
    expect(h.post).toHaveBeenCalledTimes(1);
  });
});
