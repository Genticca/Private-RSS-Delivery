/**
 * 템플릿 관리 정책. 사용자 템플릿 생성·복제와 내장 템플릿의 변경 가능 범위를 제어한다.
 */
import { validationError, conflict, notFound } from '../core/errors.js';
import { nowIso } from '../core/db.js';
import { requireObject, optionalString, parseIdParam } from '../core/input.js';
import type { TemplateRecord, TemplateRepository } from './repository.js';

export type TemplateId = number;

export interface TemplateDto {
  id: TemplateId;
  name: string;
  label: string;
  body: string;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateRequest {
  // 식별자(name 슬러그)는 사용자 입력이 아니라 서버가 label에서 자동 생성한다(TemplateService.create). 폼도 label/body/cloneFrom만 전송.
  label: string;
  body: string;
  cloneFrom?: TemplateId;
}

export interface UpdateTemplateRequest {
  label?: string;
  body?: string;
}

export function toTemplateDto(template: TemplateRecord): TemplateDto {
  return {
    id: template.id,
    name: template.name,
    label: template.label,
    body: template.body,
    isBuiltin: template.isBuiltin,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
  };
}

export interface TemplateServiceOptions {
  repositories: {
    templates: Pick<TemplateRepository, 'list' | 'create' | 'update' | 'delete' | 'findByName' | 'getById'>;
  };
  now?: () => string;
}

export class TemplateService {
  constructor(private readonly options: TemplateServiceOptions) { }

  list(): TemplateDto[] {
    return this.options.repositories.templates.list().map(toTemplateDto);
  }

  get(id: number): TemplateDto {
    return toTemplateDto(this.requireTemplate(id));
  }

  /** 복제할 템플릿 또는 새 입력에서 사용자 템플릿을 만들고 이름 충돌을 피한다. */
  create(value: unknown): TemplateDto {
    const input = normalizeTemplateCreate(value);
    const clone = input.cloneFrom ? this.requireTemplate(input.cloneFrom) : null;
    const label = input.label ?? (clone ? `${clone.label} 사본` : undefined);
    if (!label) throw validationError('템플릿 표시 이름이 필요합니다.', { label: '필수 값입니다.' });
    const body = input.body ?? clone?.body;
    if (!body) throw validationError('템플릿 body가 필요합니다.', { body: '필수 값입니다.' });
    // 식별자(name)는 시스템이 라벨에서 자동 생성한다(사용자 입력 아님). 슬러그가 비면(예: 한글 라벨) 'custom' 기반.
    const name = this.uniqueName(slugify(label) || (clone ? `${clone.name}-copy` : 'custom'));
    return toTemplateDto(this.options.repositories.templates.create({
      name,
      label,
      body,
      createdAt: this.now(),
      updatedAt: this.now()
    }));
  }

  /** 내장 템플릿은 표시 이름 변경만 허용하고 본문 보호 규칙을 유지한다. */
  update(id: number, value: unknown): TemplateDto {
    const current = this.requireTemplate(id);
    const input = normalizeTemplateUpdate(value);
    if (current.isBuiltin && input.body !== undefined && input.body !== current.body) {
      throw conflict('내장 템플릿은 직접 수정할 수 없습니다. 복제 후 수정하세요.');
    }
    return toTemplateDto(this.options.repositories.templates.update(id, { ...input, updatedAt: this.now() }));
  }

  /** 내장 프리셋 삭제를 막고 존재하는 사용자 템플릿만 삭제한다. */
  remove(id: number): void {
    const current = this.requireTemplate(id);
    if (current.isBuiltin) throw conflict('내장 템플릿은 삭제할 수 없습니다.');
    if (!this.options.repositories.templates.delete(id)) throw notFound('템플릿을 찾을 수 없습니다.');
  }

  /** 생성할 내부 이름이 이미 쓰이면 순번을 붙여 고유하게 만든다. */
  private uniqueName(base: string): string {
    let candidate = slugify(base);
    if (!candidate) candidate = 'template-copy';
    if (!this.options.repositories.templates.findByName(candidate)) return candidate;
    for (let index = 2; index < 1000; index += 1) {
      const next = `${candidate}-${index}`;
      if (!this.options.repositories.templates.findByName(next)) return next;
    }
    throw conflict('사용 가능한 템플릿 이름을 만들 수 없습니다.');
  }

  private requireTemplate(id: number) {
    const template = this.options.repositories.templates.getById(id);
    if (!template) throw notFound('템플릿을 찾을 수 없습니다.');
    return template;
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

function normalizeTemplateCreate(value: unknown): Partial<CreateTemplateRequest> {
  const body = requireObject(value);
  return {
    // name(식별자)은 사용자 입력을 받지 않는다 — 시스템이 자동 생성한다.
    label: optionalString(body.label, 'label', 200) ?? undefined,
    body: optionalString(body.body, 'body', 20000) ?? undefined,
    cloneFrom: body.cloneFrom === undefined || body.cloneFrom === '' ? undefined : parseIdParam(body.cloneFrom, 'cloneFrom')
  };
}

function normalizeTemplateUpdate(value: unknown): UpdateTemplateRequest {
  const body = requireObject(value);
  return {
    label: optionalString(body.label, 'label', 200) ?? undefined,
    body: optionalString(body.body, 'body', 20000) ?? undefined
  };
}

/** 표시 이름에서 내부 식별용 슬러그를 만든다. 표시 이름 자체는 별도로 보존한다. */
function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}
