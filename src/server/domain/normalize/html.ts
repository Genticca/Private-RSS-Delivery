const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  copy: '(c)',
  reg: '(r)'
};

export const DEFAULT_SUMMARY_MAX_CHARS = 4000;

export function cleanTitle(value: string): string {
  return htmlToText(value, { singleLine: true, maxChars: undefined });
}

export function cleanSummary(value: string): string {
  return htmlToText(value, { singleLine: false, maxChars: DEFAULT_SUMMARY_MAX_CHARS });
}

export function htmlToText(
  value: string,
  options: { singleLine: boolean; maxChars?: number } = { singleLine: false }
): string {
  const withoutScripts = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  const withStructuralBreaks = withoutScripts
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n· ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|blockquote|pre|tr|table|thead|tbody|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(withStructuralBreaks).replace(/\u00a0/g, ' ');
  const normalized = options.singleLine ? normalizeSingleLine(decoded) : normalizeMultiline(decoded);
  return options.maxChars === undefined ? normalized : truncateAtWordBoundary(normalized, options.maxChars);
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

export function normalizeSingleLine(value: string): string {
  return tightenPunctuation(value.replace(/\s+/g, ' ').trim());
}

export function normalizeMultiline(value: string): string {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => tightenPunctuation(line.replace(/[ \t\f\v]+/g, ' ').trim()))
    .filter((line) => line.length > 0);
  return lines.join('\n').trim();
}

export function truncateAtWordBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…'.slice(0, maxChars);

  const sliceMax = maxChars - 1;
  const candidate = value.slice(0, sliceMax);
  const lastWhitespace = candidate.search(/\s+\S*$/);
  const cutAt = lastWhitespace > Math.floor(sliceMax * 0.6) ? lastWhitespace : sliceMax;
  return `${candidate.slice(0, cutAt).trimEnd()}…`;
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function tightenPunctuation(value: string): string {
  return value.replace(/\s+([,.;:!?])/g, '$1');
}
