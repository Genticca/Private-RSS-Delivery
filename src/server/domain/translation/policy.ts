import { createHash } from 'node:crypto';
import Handlebars from 'handlebars';
import type { SourceRecord } from '../../db/source.repository.js';

export type TranslationField = 'title' | 'summary';
export const TRANSLATION_POLICY_VERSION = '2';

export function translationCacheKey(field: TranslationField, inputText: string, contextProfile: string, targetLang = 'ko'): string {
  // 정책이나 문맥이 달라지면 같은 원문이라도 이전 번역을 재사용하지 않는다.
  return createHash('sha256').update(JSON.stringify({
    policyVersion: TRANSLATION_POLICY_VERSION,
    targetLang,
    field,
    contextProfile,
    glossaryVersion: '1',
    inputText
  })).digest('hex');
}

export function requiredTranslationFields(templateBody: string | undefined, source: Pick<SourceRecord, 'threadId' | 'threadName' | 'appliedTags'>): TranslationField[] {
  if (templateBody === undefined) return ['title', 'summary'];
  const fields = new Set<TranslationField>();
  let uncertain = false;
  try {
    const ast = Handlebars.parse(templateBody);
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const value = node as Record<string, unknown>;
      if (value.type === 'PathExpression') {
        const parts = Array.isArray(value.parts) ? value.parts.map(String) : [];
        if (value.data === true && parts[0] === 'root') parts.shift();
        const path = parts.length > 0 ? parts.join('.') : String(value.original);
        if (path === 'item.title' || path.startsWith('item.title.')) fields.add('title');
        else if (path === 'item.summary' || path.startsWith('item.summary.')) fields.add('summary');
        else if (!/^(item\.|source\.|feed\.|json$|truncate$|formatDate$|default$|if$|unless$|each$|with$|eq$|and$|or$)/.test(path)) uncertain = true;
      }
      for (const [key, child] of Object.entries(value)) if (key !== 'loc') visit(child);
    };
    visit(ast);
  } catch {
    uncertain = true;
  }
  if (!source.threadId && !source.threadName && source.appliedTags.length > 0) fields.add('title');
  // 템플릿 참조를 확실히 해석하지 못하면 누락을 막기 위해 두 필드를 모두 번역한다.
  return uncertain ? ['title', 'summary'] : [...fields];
}

export function localTranslation(text: string, targetLang: string): string | null {
  if (text.trim() === '') return text;
  if (targetLang !== 'ko') return null;
  const stages: Record<string, string> = {
    Investigating: '조사 중',
    Identified: '원인 확인',
    Monitoring: '모니터링 중',
    Resolved: '해결됨',
    Update: '업데이트'
  };
  if (Object.hasOwn(stages, text)) return stages[text];
  return /[가-힣]/.test(text) && !/[A-Za-z]/.test(text) ? text : null;
}
