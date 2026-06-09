import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEED_FIXTURE_NAMES = [
  'CISA.xml',
  'Claude.atom',
  'CVEFeed.xml',
  'GeekNews.xml',
  'OpenAI.atom',
  'TheHackersNews.xml'
] as const;

export type FeedFixtureName = (typeof FEED_FIXTURE_NAMES)[number];

export const feedFixtureDir = fileURLToPath(new URL('./feeds/', import.meta.url));

export function getFeedFixturePath(name: FeedFixtureName): string {
  const fullPath = join(feedFixtureDir, name);
  if (!existsSync(fullPath)) {
    throw new Error(`Feed fixture is missing: ${name}`);
  }
  return fullPath;
}

export async function readFeedFixture(name: FeedFixtureName): Promise<string> {
  return readFile(getFeedFixturePath(name), 'utf8');
}

export async function readAllFeedFixtures(): Promise<Record<FeedFixtureName, string>> {
  const entries = await Promise.all(
    FEED_FIXTURE_NAMES.map(async (name) => [name, await readFeedFixture(name)] as const)
  );
  return Object.fromEntries(entries) as Record<FeedFixtureName, string>;
}
