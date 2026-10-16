import { describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/server/app.js';
import { harness, BASE } from '../../../mocks/runtime.js';

describe('SSE reconnect and shutdown', () => {
  it('resumes both log cursors without replaying previous events and closes open streams during app shutdown', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    h.r.deliveryLogs.append({ itemId: h.item().id, attemptNo: 2, status: 'failed', error: 'new-error', createdAt: BASE });
    const app = createApp({ container: h.container, logger: false });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(address + '/api/logs/stream', { headers: { 'last-event-id': '1:2' }, signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const chunk = await reader.read(); const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain('id: 2:2'); expect(text).toContain('new-error'); expect(text).not.toContain('"attemptNo":1');
      await app.close();
      const end = await reader.read(); expect(end.done).toBe(true);
    } finally { controller.abort(); await app.close(); }
  });
});
