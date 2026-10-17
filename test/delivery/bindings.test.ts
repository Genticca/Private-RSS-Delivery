import { describe, it, expect } from 'vitest';
import { harness, WEBHOOK_B } from '../mocks/runtime.js';

describe('configuration mutations and binding consistency', () => {
  it('reconciles group URL replacement through import overwrite', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    const document = h.container.services.exportImport.export();
    document.groups[0].legacyWebhookUrl = WEBHOOK_B;
    await h.container.services.exportImport.commit(JSON.stringify(document), 'overwrite');
    await h.run(); expect(h.post).not.toHaveBeenCalled(); expect(h.jobs()[0].state).toBe('cancelled');
    expect(h.r.deliveryBindings.listActive(h.source().id)[0].baselineAt).toBeNull();
  });

  it('preserves a connection when one of its duplicate groups is deleted', async () => {
    const h = await harness(); const duplicate = await h.container.services.groups.create({ name: 'Duplicate', webhookUrl: 'https://discord.com/api/webhooks/111/test-a' });
    await h.container.services.sources.update(h.source().id, { groupIds: [h.group.id, duplicate.id] }); await h.baseline();
    const first = h.r.deliveryBindings.listActive(h.source().id)[0].id;
    h.container.services.groups.remove(duplicate.id);
    expect(h.r.deliveryBindings.listActive(h.source().id)[0].id).toBe(first);
    await h.poll([{ id: 'one' }]); await h.run(); expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('cancels work when its last destination group is deleted', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]);
    h.container.services.groups.remove(h.group.id); await h.run(); expect(h.post).not.toHaveBeenCalled();
    expect(h.r.deliveryBindings.listActive(h.source().id)).toEqual([]);
  });
});
