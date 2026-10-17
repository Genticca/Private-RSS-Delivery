export interface TranslationPromptInput {
  title: string;
  summary: string;
  targetLang: string;
}

export interface ParsedTranslation {
  title: string;
  summary: string;
}

export const TRANSLATION_SYSTEM_PROMPT =
  'Translate RSS item title and summary into the requested target language. Return only JSON with string keys title and summary.';

export function buildTranslationPrompt(input: TranslationPromptInput): string {
  return JSON.stringify({
    instruction: `Translate title and summary to ${input.targetLang}. Translate each field independently without using the other field as context. Preserve URLs, CVE IDs, product names, versions, and incident stage labels.`,
    title: input.title,
    summary: input.summary
  });
}

export function parseTranslationResponse(value: string): ParsedTranslation {
  const parsed = JSON.parse(extractJsonObject(value)) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Translation response must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== 'string' || typeof record.summary !== 'string') {
    throw new Error('Translation response must include string title and summary.');
  }
  return { title: record.title, summary: record.summary };
}

export function buildPromptLog(input: TranslationPromptInput, output: string, maxBytes: number): string | null {
  if (maxBytes <= 0) return null;
  return truncateUtf8(`input:
${buildTranslationPrompt(input)}

output:
${output}`, maxBytes);
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '…';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes) return '';

  const bodyLimit = maxBytes - markerBytes;
  let end = bodyLimit;
  const buffer = Buffer.from(value, 'utf8');
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return `${buffer.subarray(0, end).toString('utf8')}${marker}`;
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error('Translation response did not contain a JSON object.');
}
