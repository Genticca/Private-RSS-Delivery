import { describe } from 'vitest';
import { it } from 'vitest';
import { harness } from '../../mocks/runtime.js';
import { expect } from 'vitest';
import { WEBHOOK_B } from '../../mocks/runtime.js';
import { WEBHOOK_A } from '../../mocks/runtime.js';
import { addSecondsIso } from '../../../src/server/core/db.js';
import { BASE } from '../../mocks/runtime.js';

describe('destination-bound delivery jobs', () => {
  it('stores the first source snapshot as historical without POST', async () => {
    const h = await harness();
    await h.poll([{ id: 'old' }]); await h.run();
    expect(h.item('old').historical).toBe(true);
    expect(h.jobs()).toEqual([]); expect(h.post).not.toHaveBeenCalled();
  });

  it('sends a post-baseline item exactly once and persists its message ID with editInPlace off', async () => {
    const h = await harness({ editInPlace: false }); await h.baseline();
    await h.poll([{ id: 'one' }]); await h.run(); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0][0].captureMessageId).toBe(true);
    const binding = h.r.deliveryBindings.listActive(h.source().id)[0];
    expect(h.r.itemDeliveries.get(h.item().id, binding.id)?.messageId).toBeTruthy();
    expect(h.jobs()[0].state).toBe('succeeded');
    expect(h.r.eventLog.list({ kind: 'delivery' })[0]).toMatchObject({ status: 'success', itemId: h.item().id, sourceId: h.source().id });
  });

  it('does not transfer a pending job when webhook A changes to B', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    await h.container.services.groups.update(h.group.id, { webhookUrl: WEBHOOK_B }); await h.run();
    expect(h.post).not.toHaveBeenCalled(); expect(h.jobs()[0].state).toBe('cancelled');
    await h.poll([{ id: 'one', title: 'Changed old' }, { id: 'baseline-new' }]); await h.run();
    expect(h.post).not.toHaveBeenCalled();
    await h.poll([{ id: 'one', title: 'Changed old' }, { id: 'baseline-new' }, { id: 'future' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0][0].destination.webhookUrl).toBe(WEBHOOK_B);
  });

  it('updates old messages only on A after adding B, then sends future items to both', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    const b = await h.container.services.groups.create({ name: 'B', webhookUrl: WEBHOOK_B });
    await h.container.services.sources.update(h.source().id, { groupIds: [h.group.id, b.id] });
    await h.poll([{ id: 'one', title: 'Changed' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).toHaveBeenCalledTimes(1);
    expect(h.edit.mock.calls[0][0].destination.webhookUrl).toBe(WEBHOOK_A);
    await h.poll([{ id: 'one', title: 'Changed' }, { id: 'future' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it('creates a new generation for A to B to A and never revives the old queue', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    const first = h.r.deliveryBindings.listActive(h.source().id)[0].id;
    await h.container.services.groups.update(h.group.id, { webhookUrl: WEBHOOK_B });
    await h.container.services.groups.update(h.group.id, { webhookUrl: WEBHOOK_A });
    expect(h.r.deliveryBindings.listActive(h.source().id)[0].id).not.toBe(first);
    await h.run(); expect(h.post).not.toHaveBeenCalled();
  });

  it('closes the connection when only threadId changes', async () => {
    const h = await harness({ threadId: '444' }); await h.baseline(); await h.poll([{ id: 'one' }]);
    await h.container.services.sources.update(h.source().id, { threadId: '555' }); await h.run();
    expect(h.post).not.toHaveBeenCalled(); expect(h.jobs()[0].state).toBe('cancelled');
  });

  it('treats token case changes as a new connection instead of moving old pending work', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    await h.container.services.groups.update(h.group.id, { webhookUrl: WEBHOOK_A.replace('test-a', 'TEST-A') });
    await h.run(); expect(h.post).not.toHaveBeenCalled(); expect(h.jobs()[0].state).toBe('cancelled');
  });

  it('deduplicates discord.com and discordapp.com aliases for the same webhook', async () => {
    const h = await harness(); const alias = await h.container.services.groups.create({ name: 'Alias', webhookUrl: WEBHOOK_A.replace('discord.com', 'discordapp.com') });
    await h.container.services.sources.update(h.source().id, { groupIds: [h.group.id, alias.id] });
    await h.baseline(); await h.poll([{ id: 'one' }]); await h.run(); expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('deduplicates identical webhook groups and preserves the generation on a no-op membership save', async () => {
    const h = await harness(); await h.baseline();
    const first = h.r.deliveryBindings.listActive(h.source().id)[0].id;
    const duplicate = await h.container.services.groups.create({ name: 'Duplicate', webhookUrl: WEBHOOK_A });
    await h.container.services.sources.update(h.source().id, { groupIds: [h.group.id, duplicate.id] });
    expect(h.r.deliveryBindings.listActive(h.source().id).map((b) => b.id)).toEqual([first]);
    await h.poll([{ id: 'one' }]); await h.run(); expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('uses durable receipts after audit logs are pruned', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one', title: 'H1' }]); await h.run();
    h.container.db.prepare('DELETE FROM event_log').run();
    await h.poll([{ id: 'one', title: 'H2' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).toHaveBeenCalledTimes(1);
  });

  it('applies H1 to H2 to H1 as revisions one, two and three', async () => {
    const h = await harness(); await h.baseline();
    for (const title of ['H1', 'H2', 'H1']) { await h.poll([{ id: 'one', title }]); await h.run(); }
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).toHaveBeenCalledTimes(2);
    const binding = h.r.deliveryBindings.listActive(h.source().id)[0];
    expect(h.r.itemDeliveries.get(h.item().id, binding.id)?.appliedRevision).toBe(3);
  });

  it('uses update_post only on the original connection when editInPlace is off', async () => {
    const h = await harness({ editInPlace: false }); await h.baseline();
    await h.poll([{ id: 'one', title: 'H1' }]); await h.run();
    await h.poll([{ id: 'one', title: 'H2' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(2); expect(h.edit).not.toHaveBeenCalled();
    expect(h.jobs().map((j) => j.operation).sort()).toEqual(['initial_post', 'update_post']);
  });

  it('records PATCH 404 as uneditable without POST fallback', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    h.edit.mockResolvedValue({ statusCode: 404 });
    await h.poll([{ id: 'one', title: 'Changed' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.jobs()[0].state).toBe('uneditable');
  });

  it('does not POST when the original message ID is unknown', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    h.container.db.prepare('UPDATE item_deliveries SET message_id = NULL').run();
    await h.poll([{ id: 'one', title: 'Changed' }]); await h.run();
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.edit).not.toHaveBeenCalled();
    expect(h.jobs()[0].state).toBe('uneditable');
  });

  it.each([500, 502])('quarantines initial POST HTTP %s without automatic retry', async (statusCode) => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.post.mockResolvedValue({ statusCode }); await h.run(); await h.run(addSecondsIso(BASE, 1000));
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.jobs()[0].state).toBe('unknown');
  });

  it('quarantines POST timeout and excludes unknown from manual failed retry', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.post.mockRejectedValue(new Error('timeout')); await h.run();
    expect(h.container.services.sources.retryFailed(h.source().id)).toBe(0);
    await h.run(addSecondsIso(BASE, 1000)); expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('quarantines a successful POST response without a message ID', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.post.mockResolvedValue({ statusCode: 204 }); await h.run();
    expect(h.jobs()[0].state).toBe('unknown');
  });

  it('does not re-POST after an external success followed by a rolled-back DB commit', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    const append = h.r.eventLog.append.bind(h.r.eventLog);
    let fail = true;
    h.r.eventLog.append = (input) => { if (fail && input.kind === 'delivery') { fail = false; throw new Error('commit failed'); } return append(input); };
    await h.run(); await h.run(addSecondsIso(BASE, 1000));
    expect(h.post).toHaveBeenCalledTimes(1); expect(h.jobs()[0].state).toBe('unknown');
  });

  it('keeps a failed destination independent from successful destinations', async () => {
    const h = await harness();
    const b = await h.container.services.groups.create({ name: 'B', webhookUrl: WEBHOOK_B });
    await h.container.services.sources.update(h.source().id, { groupIds: [h.group.id, b.id] }); await h.baseline();
    h.post.mockImplementation(async (request) => request.destination.webhookUrl === WEBHOOK_A ? { statusCode: 200, messageId: '123' } : { statusCode: 400 });
    await h.poll([{ id: 'one' }]); await h.run();
    expect(h.jobs().map((j) => j.state).sort()).toEqual(['failed', 'succeeded']);
    expect(h.container.services.sources.retryFailed(h.source().id)).toBe(1);
    await h.run(new Date().toISOString());
    expect(h.post.mock.calls.filter(([request]) => request.destination.webhookUrl === WEBHOOK_A)).toHaveLength(1);
  });

  it('defers every subsequent request to a rate-limited destination without consuming failure attempts', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }, { id: 'two' }]);
    h.post.mockResolvedValueOnce({ statusCode: 429, retryAfterMs: 60_000 });
    await h.run(); expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.jobs().every((j) => j.attemptCount === 0)).toBe(true);
    await h.run(addSecondsIso(BASE, 60)); expect(h.post).toHaveBeenCalledTimes(3);
  });

  it('retries PATCH network failures five times without retrying the successful initial POST', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    h.edit.mockResolvedValue({ statusCode: 500 }); await h.poll([{ id: 'one', title: 'Changed' }]);
    for (let i = 0; i < 5; i++) await h.run(addSecondsIso(BASE, i * 1000));
    expect(h.edit).toHaveBeenCalledTimes(5); expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.jobs()[0]).toMatchObject({ state: 'failed', attemptCount: 5, error: 'max_retries' });
  });

  it('sends a snapshot in publishing order even if the feed is newest first', async () => {
    const h = await harness(); await h.baseline();
    await h.poll([{ id: 'third', publishedAt: addSecondsIso(BASE, 3) }, { id: 'first', publishedAt: addSecondsIso(BASE, 1) }, { id: 'second', publishedAt: addSecondsIso(BASE, 2) }]); await h.run();
    expect(h.post.mock.calls.map(([request]) => request.payload.embeds?.[0]?.title)).toEqual(['first', 'second', 'third']);
  });

  it('applies mentions, silence, source overrides and forum thread options', async () => {
    const h = await harness({ silent: true, mentionEveryone: true, mentionHere: true, mentionRoleIds: ['123'], mentionUserIds: ['456'], appliedTags: ['555'], webhookName: 'Source Bot' });
    await h.baseline(); await h.poll([{ id: 'one', title: 'Forum title' }]); await h.run();
    expect(h.post.mock.calls[0][0].payload).toMatchObject({ flags: 4096, username: 'Source Bot', thread_name: 'Forum title', applied_tags: ['555'],
      allowed_mentions: { parse: ['everyone'], roles: ['123'], users: ['456'] } });
    expect(h.post.mock.calls[0][0].payload.content).toContain('<@&123>');
  });

  it('keeps actual forum thread IDs and removes creation-only fields from PATCH', async () => {
    const h = await harness({ appliedTags: ['555'] }); await h.baseline();
    h.post.mockResolvedValue({ statusCode: 200, messageId: '123', channelId: '777', threadId: '777' });
    await h.poll([{ id: 'one', title: 'H1' }]); await h.run();
    await h.poll([{ id: 'one', title: 'H2' }]); await h.run();
    expect(h.edit.mock.calls[0][0].destination.threadId).toBe('777');
    expect(h.edit.mock.calls[0][0].payload.thread_name).toBeUndefined();
    expect(h.edit.mock.calls[0][0].payload.applied_tags).toBeUndefined();
  });

  it('cancels prepared work if its connection changes during translation', async () => {
    let release!: (value: { text: string }) => void;
    const h = await harness({ translate: true }, { env: { DATABASE_PATH: ':memory:', PRIMARY_MODEL_API_KEY: 'test' },
      translationProvider: { generate: () => new Promise((resolve) => { release = resolve; }) } });
    await h.baseline(); await h.poll([{ id: 'one' }]);
    const running = h.run();
    await new Promise((resolve) => setImmediate(resolve));
    await h.container.services.groups.update(h.group.id, { webhookUrl: WEBHOOK_B });
    release({ text: '{"title":"번역","summary":""}' }); await running;
    expect(h.post).not.toHaveBeenCalled(); expect(h.jobs()[0].state).toBe('cancelled');
  });

  it('recovers a started POST as unknown, and an unsent or PATCH job as pending', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    const job = h.r.deliveryJobs.claim(h.jobs()[0].id)!;
    h.r.deliveryJobs.markRequestStarted(job, BASE); h.r.deliveryJobs.recoverInterrupted(BASE);
    expect(h.jobs()[0].state).toBe('unknown'); await h.run(); expect(h.post).not.toHaveBeenCalled();
  });

  it('rejects invalid render payloads before any network call', async () => {
    const h = await harness(); const template = h.r.templates.create({ name: 'invalid-test', label: 'invalid', body: '{"content":12}', createdAt: BASE });
    await h.container.services.sources.update(h.source().id, { templateId: template.id }); await h.baseline();
    await h.poll([{ id: 'one' }]); await h.run();
    expect(h.post).not.toHaveBeenCalled(); expect(h.jobs()[0].state).toBe('failed');
  });

  it('does not include feed authentication headers in job snapshots', async () => {
    const h = await harness({ fetchOptions: { headers: { Authorization: 'private-test-token' } } }); await h.baseline();
    await h.poll([{ id: 'one' }]); expect(JSON.stringify(h.jobs())).not.toContain('private-test-token');
  });
});
