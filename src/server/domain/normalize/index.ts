import { normalizeGeneric } from './generic.js';
import { normalizeIncident } from './incident.js';
import type { FeedEnvelope, NormalizedItem, Profile } from './types.js';

export type {
  FeedEnvelope,
  IncidentStage,
  KnownIncidentStage,
  NormalizedItem,
  Profile,
  SourceProfile
} from './types.js';
export { INCIDENT_STAGES, PROFILES, SOURCE_PROFILE_OPTIONS } from './types.js';
export { computeGenericContentHash, computeIncidentContentHash, sha256Hex } from './content-hash.js';
export { detectProfile, effectiveProfile } from './profile.js';
export { normalizeGeneric } from './generic.js';
export { normalizeIncident } from './incident.js';
export { cleanSummary, cleanTitle, decodeHtmlEntities, htmlToText, truncateAtWordBoundary } from './html.js';

export function normalize(profile: Profile, env: FeedEnvelope): NormalizedItem {
  try {
    if (profile === 'incident-io' || profile === 'atlassian-statuspage') {
      return normalizeIncident(profile, env);
    }
    return normalizeGeneric(env);
  } catch {
    return normalizeGeneric(env);
  }
}
