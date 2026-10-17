import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, vi, expect } from 'vitest';
import { harness, BASE } from '../mocks/runtime.js';
import { loadEnvironment } from '../../src/server/core/config.js';

describe('shared runtime environment', () => {
  it('uses a fallback-only key from .env for diagnostics and dispatch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rss-env-fallback-'));
    const file = join(directory, '.env');
    writeFileSync(file, 'FALLBACK_MODEL_API_KEY=fixture-fallback\n');
    try {
      const provider = { generate: vi.fn(async () => ({ text: '{"title":"제목","summary":"본문"}' })) };
      const h = await harness({ translate: true }, { envFilePath: file, translationProvider: provider });
      expect(h.container.services.model.getDiagnostics()).toMatchObject({ status: 'ready', keys: { activeKey: 'fallback' } });
      await h.baseline(); await h.poll([{ id: 'one' }], BASE); await h.run();
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(provider.generate.mock.calls[0]).toBeDefined();
      const publicData = JSON.stringify({ config: h.container.config, diagnostics: h.container.services.model.getDiagnostics(), logs: h.r.eventLog.list() });
      expect(publicData).not.toContain('fixture-fallback');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('passes .env-only model keys to status and translation without exposing them in config or DTOs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rss-env-test-'));
    const file = join(directory, '.env');
    writeFileSync(file, 'PRIMARY_MODEL_API_KEY=fixture-primary\n');
    try {
      const provider = { generate: vi.fn(async () => ({ text: '{"title":"제목","summary":"본문"}' })) };
      const h = await harness({ translate: true }, { envFilePath: file, translationProvider: provider });
      expect(h.container.services.model.getDiagnostics().status).toBe('ready');
      await h.baseline(); await h.poll([{ id: 'one' }], BASE); await h.run();
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.container.config)).not.toContain('fixture-primary');
      expect(JSON.stringify(h.container.services.model.getDiagnostics())).not.toContain('fixture-primary');
      expect(JSON.stringify(h.r.eventLog.list())).not.toContain('fixture-primary');
      expect(loadEnvironment({ PRIMARY_MODEL_API_KEY: 'process-value' }, { envFilePath: file }).PRIMARY_MODEL_API_KEY).toBe('process-value');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
