/** DB 시각은 UTC ISO 문자열로 통일한다. KST 표시는 렌더 계층에서 변환한다. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function addSecondsIso(baseIso: string, seconds: number): string {
  const base = Date.parse(baseIso);
  if (!Number.isFinite(base)) {
    throw new Error('baseIso must be a valid ISO timestamp.');
  }
  return new Date(base + seconds * 1000).toISOString();
}

export function subtractDaysIso(baseIso: string, days: number): string {
  const base = Date.parse(baseIso);
  if (!Number.isFinite(base)) {
    throw new Error('baseIso must be a valid ISO timestamp.');
  }
  return new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
}
