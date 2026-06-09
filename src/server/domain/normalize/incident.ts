import { computeIncidentContentHash } from './content-hash.js';
import { normalizeGeneric } from './generic.js';
import { cleanSummary, cleanTitle, htmlToText } from './html.js';
import { INCIDENT_STAGES, type FeedEnvelope, type IncidentStage, type NormalizedItem, type Profile } from './types.js';

type IncidentProfile = Extract<Profile, 'incident-io' | 'atlassian-statuspage'>;

const INCIDENT_IO_STATUS_RE = /<(?:b|strong)\b[^>]*>\s*Status:\s*([^<]+?)\s*<\/(?:b|strong)>/i;
const PARAGRAPH_RE = /<p\b[^>]*>[\s\S]*?<\/p>/i;
const STRONG_STAGE_RE = /<strong\b[^>]*>\s*([^<]+?)\s*<\/strong>/i;

export function normalizeIncident(profile: IncidentProfile, env: FeedEnvelope): NormalizedItem {
  const extracted = profile === 'incident-io' ? extractIncidentIo(env.rawBody) : extractAtlassianStatuspage(env.rawBody);
  if (!extracted) return normalizeGeneric(env);

  const title = cleanTitle(env.title);
  const item: NormalizedItem = {
    atomId: env.atomId,
    title,
    link: env.link,
    summary: extracted.summary,
    incidentStage: extracted.stage,
    contentHash: computeIncidentContentHash({ stage: extracted.stage, summary: extracted.summary })
  };

  assignOptional(item, 'publishedAt', env.publishedAt);
  assignOptional(item, 'updatedAt', env.updatedAt);
  assignOptional(item, 'author', env.author);
  assignOptional(item, 'commentsUrl', env.commentsUrl);
  assignOptional(item, 'image', env.image);
  return item;
}

function extractIncidentIo(rawBody: string): { stage: IncidentStage; summary: string } | undefined {
  const match = INCIDENT_IO_STATUS_RE.exec(rawBody);
  if (!match?.[1]) return undefined;

  const stage = normalizeIncidentStage(match[1]);
  if (!stage) return undefined;

  const afterMarker = rawBody.slice(match.index + match[0].length);
  const summary = cleanSummary(afterMarker || rawBody);
  if (!summary) return undefined;
  return { stage, summary };
}

function extractAtlassianStatuspage(rawBody: string): { stage: IncidentStage; summary: string } | undefined {
  const paragraph = PARAGRAPH_RE.exec(rawBody)?.[0];
  if (!paragraph) return undefined;

  const stageText = STRONG_STAGE_RE.exec(paragraph)?.[1];
  if (!stageText) return undefined;

  const stage = normalizeIncidentStage(stageText);
  const summary = cleanSummary(paragraph);
  if (!stage || !summary) return undefined;
  return { stage, summary };
}

function normalizeIncidentStage(value: string): IncidentStage | undefined {
  const normalized = htmlToText(value, { singleLine: true, maxChars: undefined });
  if (!normalized) return undefined;

  const known = INCIDENT_STAGES.find((stage) => stage.toLowerCase() === normalized.toLowerCase());
  return known ?? normalized;
}

function assignOptional<K extends keyof NormalizedItem>(
  item: NormalizedItem,
  key: K,
  value: NormalizedItem[K] | undefined
): void {
  if (value !== undefined && value !== '') {
    item[key] = value;
  }
}
