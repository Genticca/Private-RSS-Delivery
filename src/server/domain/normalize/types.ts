export const PROFILES = ['generic', 'incident-io', 'atlassian-statuspage'] as const;

export type Profile = (typeof PROFILES)[number];

export const SOURCE_PROFILE_OPTIONS = ['auto', ...PROFILES] as const;

export type SourceProfile = (typeof SOURCE_PROFILE_OPTIONS)[number];

export const INCIDENT_STAGES = ['Investigating', 'Identified', 'Monitoring', 'Resolved', 'Update'] as const;

export type KnownIncidentStage = (typeof INCIDENT_STAGES)[number];

export type IncidentStage = KnownIncidentStage | (string & {});

export interface FeedEnvelope {
  /** 피드 원본에서 추출한 식별자. 내용이 바뀌어도 동일 항목을 찾는 기준이다. */
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
  /** 프로필별 변경 감지 기준으로 계산하며 항목 ID와는 별도로 사용한다. */
  contentHash: string;
}
