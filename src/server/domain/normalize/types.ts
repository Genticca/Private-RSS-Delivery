export const PROFILES = ['generic', 'incident-io', 'atlassian-statuspage'] as const;

export type Profile = (typeof PROFILES)[number];

export const SOURCE_PROFILE_OPTIONS = ['auto', ...PROFILES] as const;

export type SourceProfile = (typeof SOURCE_PROFILE_OPTIONS)[number];

export const INCIDENT_STAGES = ['Investigating', 'Identified', 'Monitoring', 'Resolved', 'Update'] as const;

export type KnownIncidentStage = (typeof INCIDENT_STAGES)[number];

export type IncidentStage = KnownIncidentStage | (string & {});

export interface FeedEnvelope {
  atomId: string;
  title: string;
  link: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  commentsUrl?: string;
  image?: string;
  rawBody: string;
  categories: string[];
}

export interface NormalizedItem {
  atomId: string;
  title: string;
  link: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  commentsUrl?: string;
  image?: string;
  summary: string;
  incidentStage?: IncidentStage;
  contentHash: string;
}
