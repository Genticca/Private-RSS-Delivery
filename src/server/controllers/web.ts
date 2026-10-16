import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServiceRegistry } from '../runtime/container.js';
import { PRESET_VARIABLES } from '../contracts/render-context.js';
import { parseIdParam } from '../services/validation.js';

export async function registerWebRoutes(app: FastifyInstance, services: ServiceRegistry): Promise<void> {
  app.get('/', async (_request, reply) => render(reply, 'pages/dashboard.hbs', dashboardModel(services)));

  app.get('/sources', async (_request, reply) =>
    render(reply, 'pages/sources.hbs', {
      sources: services.sources.list(),
      groups: services.groups.list(),
      profiles: PROFILE_VIEW_OPTIONS
    })
  );

  app.get('/sources/new', async (_request, reply) =>
    render(reply, 'pages/source-form.hbs', {
      source: null,
      groups: withGroupSelection(services.groups.list(), []),
      templates: services.templates.list(),
      profiles: PROFILE_VIEW_OPTIONS
    })
  );

  app.get<{ Params: { id: string } }>('/sources/:id', async (request, reply) => {
    const groups = services.groups.list();
    const source = withDestinationStatus(services.sources.get(request.params.id), groups);
    return render(reply, 'pages/source-form.hbs', {
      source,
      // 편집 시 소속 그룹 체크 상태를 서버에서 직접 렌더(JS 타이밍에 의존하지 않도록).
      groups: withGroupSelection(groups, source.groupIds),
      templates: services.templates.list(),
      profiles: PROFILE_VIEW_OPTIONS
    });
  });

  app.get('/groups', async (_request, reply) => render(reply, 'pages/groups.hbs', { groups: services.groups.list() }));

  app.get('/templates', async (_request, reply) =>
    render(reply, 'pages/templates.hbs', { templates: services.templates.list() })
  );

  app.get<{ Params: { id: string } }>('/templates/:id', async (request, reply) =>
    render(reply, 'pages/template-editor.hbs', {
      template: services.templates.get(parseIdParam(request.params.id)),
      presetVars: presetVars(),
      sources: services.sources.list().map((source) => ({ id: source.id, name: source.name ?? source.feedUrl })),
      needsCodeMirror: true
    })
  );

  app.get('/logs', async (_request, reply) => render(reply, 'pages/logs.hbs', {}));
  app.get('/delivery-jobs', async (request, reply) => {
    const jobs = services.deliveryManagement.list(request.query);
    const query = request.query as { state?: string; sourceId?: string };
    return render(reply, 'pages/delivery-jobs.hbs', { jobs, state: query.state ?? '', sourceId: query.sourceId ?? '', nextBefore: jobs.length === 200 ? jobs.at(-1)?.id : null });
  });

  app.get('/model', async (_request, reply) => {
    const status = services.model.getStatus();
    return render(reply, 'pages/model.hbs', {
      config: services.model.getConfig(),
      status,
      diagnostics: services.model.getDiagnostics(),
      statusGuidance: modelStatusGuidance(status),
      usage: services.model.listUsage({ limit: 50 })
    });
  });
}

const PROFILE_VIEW_OPTIONS = ['auto', 'incident-io', 'atlassian-statuspage', 'generic'] as const;


function withDestinationStatus<T extends { groupIds: number[] }>(source: T, groups: Array<{ id: number; hasWebhook: boolean }>): T & { hasAnyDestination: boolean } {
  const groupWebhookIds = new Set(groups.filter((group) => group.hasWebhook).map((group) => group.id));
  return {
    ...source,
    hasAnyDestination: source.groupIds.some((groupId) => groupWebhookIds.has(groupId))
  };
}

/** 그룹 목록에 현재 소스의 소속 여부(selected)를 주입해 체크박스를 서버에서 직접 렌더하게 한다. */
function withGroupSelection<T extends { id: number }>(groups: readonly T[], selectedIds: readonly number[]): Array<T & { selected: boolean }> {
  const selected = new Set(selectedIds);
  return groups.map((group) => ({ ...group, selected: selected.has(group.id) }));
}

function dashboardModel(services: ServiceRegistry) {
  const sources = services.sources.list();
  return {
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name ?? source.feedUrl,
      enabled: source.enabled,
      lastOutcome: source.lastOutcome ?? null,
      profile: source.profile
    })),
    counts: {
      sources: sources.length,
      enabled: sources.filter((source) => source.enabled).length,
      errors: sources.filter((source) => source.lastOutcome === 'error').length
    }
  };
}

function presetVars(): Array<{ name: string; description: string }> {
  const descriptions: Record<string, string> = {
    'item.title': '정규화된 항목 제목',
    'item.link': '원문 링크',
    'item.summary': '정규화된 요약',
    'item.publishedAtFormatted': 'KST 표시용 시간',
    'item.author': '작성자',
    'source.name': '소스 표시 이름',
    'item.incidentStage': '상태 페이지 단계',
    'item.commentsUrl': '댓글 링크',
    'item.image': '대표 이미지 URL',
    'source.feedUrl': 'RSS URL',
    'source.profile': '적용 프로필'
  };
  return PRESET_VARIABLES.map((name) => ({ name, description: descriptions[name] ?? name }));
}

function modelStatusGuidance(status: { primary: string; fallback: string }): Array<{ role: string; message: string }> {
  const rows: Array<{ role: string; message: string }> = [];
  for (const role of ['primary', 'fallback'] as const) {
    const envName = role === 'primary' ? 'PRIMARY_MODEL_API_KEY' : 'FALLBACK_MODEL_API_KEY';
    const current = status[role];
    if (current === 'missing-key') rows.push({ role, message: `${envName} 환경 변수를 설정해야 ${role} 모델을 사용할 수 있습니다.` });
    if (current === 'invalid-key') rows.push({ role, message: `${envName} 값을 교체하거나 ${role} provider/model 설정을 확인하세요.` });
  }
  return rows;
}

function render(reply: FastifyReply, view: string, model: object): unknown {
  return reply.view(view, model);
}
