# 모듈 지도: 디렉터리 책임과 기능별 연결

> 검증 커밋 `6e53b7f` · 작성 2026-10-16 · 현재 동작 설명 문서(보호 대상 아님). 경로는 `rss-discord-bridge/` 기준이다.

## 1. 디렉터리별 책임

| 경로 | 책임 | 의존해도 되는 것 |
| --- | --- | --- |
| `src/server/main.ts` | 부팅, listen, 워커 시작, 시그널 처리 | app |
| `src/server/app.ts` | Fastify 구성: 파서·오류 처리·미들웨어·rate limit·뷰·라우트 등록, `/healthz`·`/ready` | runtime, controllers |
| `src/server/config.ts` | HOST·PORT·DB 경로 검증 | runtime/environment |
| `runtime/` | 환경 병합(`environment`), 실행 제한값(`options`), DI 조립(`container`), 마이그레이션(`migrator`, `delivery-backfill`), 종료 대기(`lifecycle`) | 전부 |
| `controllers/` | HTTP 어댑터. `web.ts`는 페이지, `api/*`는 JSON·htmx·SSE. 입력을 서비스에 넘기고 결과를 렌더 | services, contracts |
| `middleware/` | 들어오는 요청의 Host·Origin 검증 | — |
| `contracts/` | 프런트·백엔드 계약 타입: API DTO, view-model, 프리셋 render context | — |
| `services/` | 유스케이스. 관리 기능과 수집·발송 오케스트레이션 | domain, db, dispatcher, translator, security |
| `domain/` | **순수 함수**만. `envelope`(Stage 1), `normalize`(Stage 2·프로필), `delivery`(cutoff·보류·순서·재시도 간격), `translation`(필드 판정·캐시 키·로컬 처리), `text` | 없음 |
| `dispatcher/` | 프리셋 렌더, payload 검증, 웹훅 옵션 적용, 목적지 해석, Discord HTTP(`discord-client`), 빌트인 프리셋 시드 | security, contracts |
| `translator/` | 번역 캐시·single-flight(`translation-cache.service`), provider 순회·타임아웃(`translator`), 프롬프트, 키 해석, Gemini·NIM 어댑터 | domain, db |
| `security/` | 나가는 요청 보안: SSRF-safe fetch(크기·시간 제한, TLS 재시도, 리다이렉트), IP 검사, Agent 캐시, 웹훅 URL 검증 | — |
| `db/` | repository. SQL과 행 ↔ 레코드 매핑만, 비즈니스 규칙 없음 | — |
| `workers/` | 주기 실행과 동시성·진행 중 작업 추적(`TaskTracker`). 실제 일은 서비스에 위임 | services |
| `scheduler/` | 이전 경로 호환용 재수출 | — |
| `src/resources/migrations/` | 순번 SQL 마이그레이션 | |
| `src/resources/templates/` | 관리 화면 Handlebars(`layouts`·`pages`·`partials`)와 정적 자산(htmx, CodeMirror, app.js·css) | |
| `src/resources/presets/` | Discord 프리셋 4종 `.hbs` | |
| `Archive/` | 교체된 이전 구현과 테스트 보관본. 빌드·테스트 대상 아님 | |

## 2. 기능 × 계층 연결

| 기능 | 화면 | API | 서비스 | 워커 | 테이블 | 테스트 |
| --- | --- | --- | --- | --- | --- | --- |
| 소스 관리 | `/sources`, `/sources/new`, `/sources/:id` (`sources.hbs`, `source-form.hbs`) | `GET·POST /api/sources`, `GET·PATCH·DELETE /api/sources/:id`, `PATCH …/enabled`, `POST …/poll`, `POST …/test`, `POST …/retry-failed`, `GET …/sample-item` | SourceService(`source-input`), SchedulerService, TestSendService, PreviewService | PollWorker(수동 수집) | `sources`, `source_groups` | api.routes, web.routes, configuration-bindings |
| 그룹·연결 세대 | `/groups` (`groups.hbs`) | `GET·POST /api/groups`, `PATCH·DELETE /api/groups/:id` | GroupService, DeliveryBindingService | — | `groups`, `source_groups`, `delivery_bindings` | configuration-bindings, resolve-destinations |
| 수집 | 대시보드 상태, 소스 행 연속 실패 | — | PollService, DeliveryPlanService | PollWorker | `sources`, `items`, `fetch_log` | poll-service, feed-limits, parser, normalize, security |
| 발송 | — | — | DeliveryService, DeliveryPlanService | DeliveryWorker | `delivery_jobs`, `item_deliveries`, `delivery_bindings`, `destination_cooldowns`, `delivery_log` | delivery-jobs, discord-client, render, validate |
| 발송 작업 검토 | `/delivery-jobs` (`delivery-jobs.hbs`) | `GET /api/delivery-jobs`, `POST /api/delivery-jobs/:id/review` | DeliveryManagementService | — | `delivery_jobs`, `item_deliveries` | delivery-management |
| 번역·모델 | `/model` (`model.hbs`, `model-diagnostics`, `translation-diagnostic`) | `GET·PATCH /api/model/config`, `GET /api/model/status`, `GET /api/model/diagnostics`, `POST /api/model/diagnose`, `GET /api/model/usage` | ModelService, TranslationCacheService, DispatchTranslationService, ModelTranslator | DeliveryWorker(발송 시) | `model_config`, `model_usage`, `translation_cache`, `translation_events` | translation-cache, translator, gemini-adapter |
| 템플릿·미리보기 | `/templates`, `/templates/:id` (`template-editor.hbs`) | `GET·POST /api/templates`, `GET·PATCH·DELETE /api/templates/:id`, `POST /api/preview` | TemplateService, PreviewService | — | `templates` | presets, render, frontend-contracts |
| 로그 | `/logs` (`logs.hbs`, `log-entry`) | `GET /api/logs`, `GET /api/logs/stream`(SSE) | LogService | — | `delivery_log`, `fetch_log` | log-stream |
| Export·Import | 소스 화면 | `GET /api/export`, `POST /api/import/dry-run`, `POST /api/import` | ExportImportService(`export-import.document`), DeliveryBindingService | — | `sources`, `groups`, `source_groups`, `templates` | api.routes |
| 정리 | — | — | CleanupService | CleanupWorker | 로그·캐시·`items` 본문·`delivery_jobs` snapshot | cleanup-worker |
| 런타임 | — | `/healthz`, `/ready` | — | 전체 | `schema_migrations` | environment, shutdown, migrator, delivery-migration, config, db-schema-doc |

테스트 이름은 `test/{unit,integration}/**/<이름>.test.ts`를 줄여 적었다.

## 3. 주요 호출 경로

### 소스 저장

```text
PATCH /api/sources/:id → SourceService.update()
  └ 트랜잭션: sources.update · source_groups.setGroups
      └ (트리거) sources.config_revision +1
      └ DeliveryBindingService.reconcile(feedUrl이 바뀌면 전체 재시작)
```

### 수집 한 번

```text
PollWorker.runDuePolls → PollService.poll
  ├ DeliveryBindingService.reconcile
  ├ security.fetchFeed
  └ 트랜잭션: domain.parseFeed → domain.normalize
              → items insert/update → DeliveryPlanService.planNew / planUpdate
              → DeliveryBindingService.completeBaselines → fetch_log
```

### 발송 한 건

```text
DeliveryWorker.runDueDeliveries → DeliveryService.processJob
  ├ delivery_jobs.claim
  ├ DispatchTranslationService → TranslationCacheService → ModelTranslator
  ├ dispatcher.render · validate → delivery_jobs.savePayload
  ├ dispatcher.discord-client (POST / PATCH)
  └ 트랜잭션: delivery_jobs.finish · item_deliveries.save · delivery_log · syncItemState
```

## 4. 계약 위치

| 계약 | 코드 | 문서 |
| --- | --- | --- |
| DB 스키마 | `src/resources/migrations/*.sql` | [Contracts/db-schema.md](../Contracts/db-schema.md) |
| JSON API | `src/server/contracts/api.ts` | 작성 예정(`Contracts/http-api.md`) |
| 페이지 view-model | `src/server/contracts/view-models.ts` | 작성 예정(`Contracts/view-models.md`) |
| 프리셋 render context | `src/server/contracts/render-context.ts` | 작성 예정(`Contracts/render-context.md`) |
| 환경 변수 | `config.ts`, `runtime/options.ts`, `translator/keys.ts` | [runtime.md §5](runtime.md#5-설정값) (계약 문서로 이관 예정) |
