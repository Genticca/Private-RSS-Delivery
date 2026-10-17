import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { harness, BASE } from '../../mocks/runtime.js';
import { loadEnvironment } from '../../../src/server/runtime/environment.js';

describe('shared runtime environment', () => {
  it('passes .env-only model keys to status and translation without exposing them in config or DTOs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rss-env-test-'));
    const file = join(directory, '.env');
    writeFileSync(file, 'PRIMARY_MODEL_API_KEY=fixture-primary\n');
    try {
      const provider = { generate: vi.fn(async () => ({ text: '{"title":"제목","summary":"본문"}' })) };
      const h = await harness({ translate: true }, { envFilePath: file, translationProviders: { gemini: provider } });
      expect(h.container.services.model.getStatus().primary).toBe('ready');
      await h.baseline(); await h.poll([{ id: 'one' }], BASE); await h.run();
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.container.config)).not.toContain('fixture-primary');
      expect(JSON.stringify(h.container.services.model.getConfig())).not.toContain('fixture-primary');
      expect(JSON.stringify(h.r.modelUsage.list())).not.toContain('fixture-primary');
      expect(loadEnvironment({ PRIMARY_MODEL_API_KEY: 'process-value' }, { envFilePath: file }).PRIMARY_MODEL_API_KEY).toBe('process-value');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
