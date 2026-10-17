import { describe } from 'vitest';
import { it } from 'vitest';
import { readAllFeedFixtures } from '../mocks/fixtures.js';
import { expect } from 'vitest';
import { FEED_FIXTURE_NAMES } from '../mocks/fixtures.js';
import { getFeedFixturePath } from '../mocks/fixtures.js';

describe('Turn 0 feed fixture helper', () => {
  it('exposes every bundled feed fixture by stable name', async () => {
    const fixtures = await readAllFeedFixtures();

    expect(Object.keys(fixtures).sort()).toEqual([...FEED_FIXTURE_NAMES].sort());
    for (const name of FEED_FIXTURE_NAMES) {
      expect(getFeedFixturePath(name)).toContain(name);
      expect(fixtures[name].trim().length).toBeGreaterThan(0);
      expect(fixtures[name]).toMatch(/<rss|<feed/i);
    }
  });
});
