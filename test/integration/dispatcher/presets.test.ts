import type { Container } from '../../../src/server/runtime/container.js';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { BUILTIN_PRESETS } from '../../../src/server/dispatcher/presets.js';
import { expect } from 'vitest';
import { renderDiscordPayload } from '../../../src/server/dispatcher/render.js';
import { buildPresetRenderContext } from '../../../src/server/dispatcher/render.js';
import { createContainer } from '../../../src/server/runtime/container.js';

const containers: Container[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.close();
  }
});

describe('builtin Discord presets', () => {
  it('seeds builtin presets on container creation', () => {
    const container = openContainer();

    for (const preset of BUILTIN_PRESETS) {
      const template = container.repositories.templates.findByName(preset.name);
      expect(template).toMatchObject({ name: preset.name, label: preset.label, isBuiltin: true });
      expect(template?.body.trim()).not.toBe('');
    }
  });

  it('renders a seeded minimal preset against stored rows', () => {
    const container = openContainer();
    const template = container.repositories.templates.findByName('minimal');
    expect(template).not.toBeNull();

    const source = container.repositories.sources.create({
      feedUrl: 'https://example.com/feed.xml',
      name: 'Example Feed',
      templateId: template?.id ?? null,
      detectedProfile: 'generic'
    });
    const item = container.repositories.items.insert({
      sourceId: source.id,
      atomId: 'atom-1',
      title: 'Seeded preset title',
      link: 'https://example.com/item',
      summary: 'Summary',
      contentHash: 'hash-1'
    });

    const payload = renderDiscordPayload(template?.body ?? '', buildPresetRenderContext(item, source));

    expect(payload.embeds?.[0]?.title).toBe('Seeded preset title');
    expect(payload.embeds?.[0]?.url).toBe('https://example.com/item');
  });
});

function openContainer(): Container {
  const container = createContainer({ env: { DATABASE_PATH: ':memory:' } });
  containers.push(container);
  return container;
}
