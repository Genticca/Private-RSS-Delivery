import type { FeedEnvelope, Profile, SourceProfile } from './types.js';

const INCIDENT_IO_GENERATOR_RE = /<generator\b[^>]*>\s*incident\.io\s*<\/generator>/i;
const ATLASSIAN_STATUSPAGE_MARKERS = [
  /statuspage\.io/i,
  /status\.io/i,
  /status\.atlassian\.com/i,
  /Statuspage/i
];
const INCIDENT_IO_STATUS_MARKER_RE = /<(?:b|strong)\b[^>]*>\s*Status:\s*[^<]+<\/(?:b|strong)>/i;
const ATLASSIAN_SEGMENT_MARKER_RE = /<p\b[^>]*>[\s\S]*?<strong\b[^>]*>\s*(?:Investigating|Identified|Monitoring|Resolved|Update)\s*<\/strong>[\s\S]*?<\/p>/i;

export function effectiveProfile(profileSetting: SourceProfile, detectedProfile?: Profile | null): Profile {
  // 관리자가 지정한 프로필은 자동 감지 결과보다 우선한다.
  if (profileSetting !== 'auto') return profileSetting;
  return detectedProfile ?? 'generic';
}

export function detectProfile(rawXml: string, envelopes: readonly FeedEnvelope[] = []): Profile {
  if (INCIDENT_IO_GENERATOR_RE.test(rawXml)) return 'incident-io';
  if (ATLASSIAN_STATUSPAGE_MARKERS.some((marker) => marker.test(rawXml))) return 'atlassian-statuspage';

  // XML과 본문에서 검사할 범위를 제한해 큰 피드에서도 탐지 비용을 제한한다.
  const bodySample = envelopes
    .slice(0, 200)
    .map((envelope) => `${envelope.title}\n${envelope.rawBody}`)
    .join('\n');
  const sample = `${rawXml.slice(0, 250_000)}\n${bodySample}`;

  if (INCIDENT_IO_STATUS_MARKER_RE.test(sample)) return 'incident-io';
  if (ATLASSIAN_SEGMENT_MARKER_RE.test(sample)) return 'atlassian-statuspage';
  return 'generic';
}
