import { describe, it, expect } from 'vitest';
import { harness, BASE } from '../mocks/runtime.js';
import { createApp } from '../../src/server/app.js';
import { parseSseCursor } from '../../src/server/logs/routes.js';

describe('SSE reconnect and shutdown', () => {
  it('resumes the log cursor without replaying previous events and closes open streams during app shutdown', async () => {
    const h = await harness(); await h.baseline(); await h.poll([{ id: 'one' }]); await h.run();
    const lastSeen = h.r.eventLog.list({ limit: 1 })[0].id;
    const added = h.r.eventLog.append({ kind: 'delivery', status: 'failed', itemId: h.item().id, detail: 'new-error', createdAt: BASE });
    const app = createApp({ container: h.container, logger: false });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(address + '/api/logs/stream', { headers: { 'last-event-id': String(lastSeen) }, signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const chunk = await reader.read(); const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain('event: delivery'); expect(text).toContain(`id: ${added}`); expect(text).toContain('new-error');
      expect(text).not.toContain(`"id":${lastSeen},`);
      await app.close();
      const end = await reader.read(); expect(end.done).toBe(true);
    } finally { controller.abort(); await app.close(); }
  });

  it('accepts only a single numeric cursor', () => {
    expect(parseSseCursor('42')).toBe(42);
    expect(parseSseCursor('1:2')).toBeNull();
    expect(parseSseCursor(undefined)).toBeNull();
  });
});
