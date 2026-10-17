/** 번역 대상 언어는 한국어로 고정한다. */
export const TARGET_LANG = 'ko';

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

function extractJsonObject(value: string): string {
  // 모델이 코드 블록이나 설명을 덧붙여도 JSON 객체 부분을 추출해 검증한다.
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error('Translation response did not contain a JSON object.');
}
