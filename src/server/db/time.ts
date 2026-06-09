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
