import type { FastifyInstance } from 'fastify';
import type { ServiceRegistry } from '../container.js';
import { parseIdParam } from '../core/input.js';
import type { DashboardViewModel } from '../contracts/view-models.js';
import { PRESET_VARIABLES } from '../contracts/render-context.js';
import type { FastifyReply } from 'fastify';

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

  app.get<{
    Params: {
      id: string
    }
  }>('/sources/:id', async (request, reply) => {
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

  app.get<{
    Params: {
      id: string
    }
  }>('/templates/:id', async (request, reply) =>
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
    const query = request.query as {
      state?: string;
      sourceId?: string
    };
    return render(reply, 'pages/delivery-jobs.hbs', {
      jobs,
      state: query.state ?? '',
      sourceId: query.sourceId ?? '',
      nextBefore: jobs.length === 200 ? jobs.at(-1)?.id : null
    });
  });

  app.get('/model', async (_request, reply) => {
    const diagnostics = services.model.getDiagnostics();
    return render(reply, 'pages/model.hbs', { diagnostics, statusGuidance: modelStatusGuidance(diagnostics.status) });
  });
}

const PROFILE_VIEW_OPTIONS = ['auto', 'incident-io', 'atlassian-statuspage', 'generic'] as const;

function withDestinationStatus<T extends {
  groupIds: number[]
}>(source: T, groups: Array<{
  id: number;
  hasWebhook: boolean
}>): T & {
  hasAnyDestination: boolean
} {
  const groupWebhookIds = new Set(groups.filter((group) => group.hasWebhook).map((group) => group.id));
  return {
    ...source,
    hasAnyDestination: source.groupIds.some((groupId) => groupWebhookIds.has(groupId))
  };
}

/** 그룹 목록에 현재 소스의 소속 여부(selected)를 주입해 체크박스를 서버에서 직접 렌더하게 한다. */
function withGroupSelection<T extends {
  id: number
}>(groups: readonly T[], selectedIds: readonly number[]): Array<T & {
  selected: boolean
}> {
  const selected = new Set(selectedIds);
  return groups.map((group) => ({ ...group, selected: selected.has(group.id) }));
}

function dashboardModel(services: ServiceRegistry): DashboardViewModel {
  const sources = services.sources.list();
  const outcomes: Record<string, string> = { ok: '수집 완료', not_modified: '변경 없음', error: '수집 오류' };
  const eventLabels: Record<string, string> = {
    'fetch:ok': '피드 수집 완료', 'fetch:not_modified': '피드 변경 없음', 'fetch:error': '피드 수집 실패',
    'delivery:success': 'Discord 전송 완료', 'delivery:failed': 'Discord 전송 확인 필요',
    'translation:success': '한국어 번역 완료', 'translation:failed': '번역 실패 · 원문 사용',
    'translation:cache_hit': '번역 캐시 사용', 'translation:skipped': '번역 건너뜀'
  };
  return {
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name ?? source.feedUrl,
      enabled: source.enabled,
      lastOutcome: source.lastOutcome ?? null,
      profile: source.profile,
      feedUrl: source.feedUrl,
      hasError: source.lastOutcome === 'error',
      outcomeLabel: outcomes[source.lastOutcome ?? ''] ?? '첫 수집 대기'
    })),
    recentEvents: services.logs.backfill(6).reverse().map(({ data }) => ({
      ...data,
      icon: data.kind === 'fetch' ? 'rss' : data.kind === 'translation' ? 'sparkles' : 'send',
      label: eventLabels[`${data.kind}:${data.status}`] ?? data.status,
      failed: data.status === 'failed' || data.status === 'error',
      timeLabel: new Date(data.createdAt).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      })
    })),
    counts: {
      sources: sources.length,
      enabled: sources.filter((source) => source.enabled).length,
      errors: sources.filter((source) => source.lastOutcome === 'error').length,
      connectedGroups: services.groups.list().filter((group) => group.hasWebhook).length
    }
  };
}

function presetVars(): Array<{
  name: string;
  description: string
}> {
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

function modelStatusGuidance(status: string): string | null {
  if (status === 'missing-key') return 'PRIMARY_MODEL_API_KEY 환경 변수를 설정해야 Gemini 번역을 사용할 수 있습니다. FALLBACK_MODEL_API_KEY만 설정한 경우에는 대체 키로 동작합니다.';
  if (status === 'invalid-key') return '설정한 Gemini API 키의 값과 접근 권한을 확인하세요. 대체 키는 FALLBACK_MODEL_API_KEY로 등록합니다.';
  if (status === 'cooldown') return '설정한 번역 키가 모두 일시 대기 중입니다. 대기 종료 후 자동으로 다시 시도하며, 그동안은 원문으로 발송합니다.';
  return null;
}

function render(reply: FastifyReply, view: string, model: object): unknown {
  return reply.view(view, model);
}
