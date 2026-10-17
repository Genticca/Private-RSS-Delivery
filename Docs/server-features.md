# 서버 기능·API 및 코드 점검

> 코드 점검 기준: `5e4b68c` · 작성 2026-10-18 · `src/server`의 TypeScript 100개 파일과 테스트를 대조한 현재 기능 정리다.

구성·수집/발송 내부 흐름·환경 변수는 [architecture.md](architecture.md), 정확한 테이블·컬럼·상태 값은 [db-schema.md](db-schema.md), 운영 절차는 [deploy.md](deploy.md)를 참고한다.

- [기능 요약](#1-현재-제공하는-기능)
- [기능별 화면·코드·테스트 연결](#2-기능별-연결)
- [관리 기능의 실제 동작](#3-관리-기능의-실제-동작)
- [HTTP 요청과 응답](#4-http-요청과-응답-목록)
- [요청 보안과 입력 범위](#5-요청-보안과-입력-범위)
- [현재 제약](#6-현재-동작-범위와-알려진-한계)
- [검증 방법과 범위](#7-검증-방법과-범위)

## 1. 현재 제공하는 기능

| 기능 | 관리자가 할 수 있는 일 | 처리 기준 |
| --- | --- | --- |
| 소스 관리 | RSS·Atom URL 등록, 이름·그룹·프로필·수집 주기·번역·메시지 옵션 수정, 활성 전환, 삭제 | 그룹 최소 1개, URL 중복·외부 접속 안전성 검사, 기본 수집 주기 300초 |
| 피드 수집 | 예약 수집과 수동 "지금 수집" | 조건부 GET, 프로필별 정규화, 첫 수집·새 연결의 과거 항목 발송 방지 |
| 그룹 관리 | 여러 소스가 공유하는 Discord 웹훅과 발신 이름·아바타 설정 | 웹훅 원문은 그룹만 보관하며 조회에는 마스킹한 주소를 반환 |
| Discord 발송 | 신규 공지, 같은 연결의 변경 알림, 기존 메시지 수정 | 항목×연결×버전별 작업, 웹훅별 순차 발송, rate limit 대기 |
| 메시지 옵션 | 조용한 발송, everyone·here·역할·사용자 멘션, 기존 스레드, 포럼 새 스레드·태그 | 소스 옵션을 렌더 결과에 적용한 뒤 payload 검증 |
| 프리셋 편집 | 내장 4종 사용, 사용자 템플릿 생성·복제·수정·삭제 | Handlebars로 JSON 생성. 내장 본문은 직접 변경할 수 없고 복제 후 편집 |
| 미리보기·테스트 | 저장된 항목 또는 실시간 피드로 미리보기, 실제 테스트 메시지 발송 | 미리보기는 전송·저장하지 않음. 테스트 발송은 첫 목적지 한 곳에 실제 전송 |
| 한국어 번역 | 소스별 번역 활성화, Gemini 상태 조회, 제목·본문 번역 진단 | 필요한 필드만 번역, 공유 캐시, 실패 시 원문 사용. 모델·키는 환경 변수 |
| 발송 작업 검토 | 보류 건 발송·보관, 결과 불명 건의 메시지 ID 확인, 수정 불가 건 보관 | 상태별로 허용된 조치만 수행. 결과 불명 POST의 강제 재발송 기능은 없음 |
| 통합 로그 | 수집·발송·번역 탭 조회와 실시간 수신 | `event_log` 한 테이블, 단일 SSE 커서, 기본 30일 보존 |
| 설정 이전 | 소스·그룹 JSON 내보내기, 가져오기 미리보기, 건너뛰기·덮어쓰기 적용 | 비밀값·항목·발송 이력은 내보내지 않음. 새 소스는 다시 baseline 수집 |
| 실행·정리 | 상태 점검, 안전한 종료, 오래된 로그·본문·작업 payload 정리 | 단일 Node 프로세스와 SQLite, 진행 중 작업 완료 후 DB 종료 |

## 2. 기능별 연결

| 기능 | 화면 | API | 서비스 | 워커 | 테이블 | 테스트 |
| --- | --- | --- | --- | --- | --- | --- |
| 대시보드 | `/` (`dashboard.hbs`) | `GET /api/sources` | SourceService | — | `sources`, `event_log` | web.routes |
| 소스 관리 | `/sources`, `/sources/new`, `/sources/:id` (`sources.hbs`, `source-form.hbs`) | `GET·POST /api/sources`, `GET·PATCH·DELETE /api/sources/:id`, `PATCH …/enabled`, `POST …/poll`, `POST …/test`, `POST …/retry-failed`, `GET …/sample-item` | SourceService(`source-input`), SchedulerService, TestSendService, PreviewService | PollWorker(수동 수집) | `sources`, `source_groups` | api.routes, web.routes, configuration-bindings |
| 그룹·연결 세대 | `/groups` (`groups.hbs`) | `GET·POST /api/groups`, `PATCH·DELETE /api/groups/:id` | GroupService, DeliveryBindingService | — | `groups`, `source_groups`, `delivery_bindings` | configuration-bindings, resolve-destinations |
| 수집 | 대시보드 상태, 소스 행 연속 실패 | — | PollService, DeliveryPlanService | PollWorker | `sources`, `items`, `event_log` | poll-service, feed-limits, parser, normalize, security |
| 발송 | — | — | DeliveryService, DeliveryPlanService | DeliveryWorker | `delivery_jobs`, `item_deliveries`, `delivery_bindings`, `destination_cooldowns`, `event_log` | delivery-jobs, discord-client, render, validate |
| 발송 작업 검토 | `/delivery-jobs` (`delivery-jobs.hbs`) | `GET /api/delivery-jobs`, `POST /api/delivery-jobs/:id/review` | DeliveryManagementService | — | `delivery_jobs`, `item_deliveries` | delivery-management |
| 번역 | `/model` (`model.hbs`, `model-diagnostics`, `translation-diagnostic`) — 상태·진단만, 설정은 env | `GET /api/model/diagnostics`, `POST /api/model/diagnose` | ModelService, TranslationCacheService, DispatchTranslationService, ModelTranslator | DeliveryWorker(발송 시) | `translation_cache`, `event_log` | translation-cache, translator, gemini-adapter |
| 템플릿·미리보기 | `/templates`, `/templates/:id` (`template-editor.hbs`) | `GET·POST /api/templates`, `GET·PATCH·DELETE /api/templates/:id`, `POST /api/preview` | TemplateService, PreviewService | — | `templates` | presets, render, frontend-contracts |
| 로그 | `/logs` (`logs.hbs`) — 전송·수집·번역 탭 | `GET /api/logs?type=`(`delivery`·`fetch`·`translation`), `GET /api/logs/stream`(SSE, 단일 cursor) | LogService | — | `event_log` | log-stream |
| Export·Import | 소스 화면 | `GET /api/export`, `POST /api/import/dry-run`, `POST /api/import` | ExportImportService(`export-import.document`), DeliveryBindingService | — | `sources`, `groups`, `source_groups`, `templates` | api.routes |
| 정리 | — | — | CleanupService | CleanupWorker | `event_log`·캐시·`items` 본문·`delivery_jobs` snapshot | cleanup-worker |
| 런타임 | — | `/healthz`, `/ready` | — | 전체 | `schema_migrations` | environment, shutdown, migrator, config, db-schema-doc |

테스트 이름은 `test/{unit,integration}/**/<이름>.test.ts`를 줄여 적었다.

## 3. 관리 기능의 실제 동작

**관리 화면** — 밝은 바탕과 녹색 강조색의 공통 레이아웃을 사용한다. 사이드바에서 운영 개요·수집 소스·발신 그룹·발송 검토·템플릿·AI 번역·로그로 바로 이동한다. 좁은 화면에서는 접이식 메뉴를 사용하고, 넓은 표는 해당 영역 안에서 가로로 스크롤한다. 소스와 발신 그룹의 추가·수정은 팝업에서 처리하며 키보드 포커스 관리와 Escape 닫기를 제공한다. 발신 그룹 목록은 설정을 요약해서 표시하고, 그룹 이름 또는 작업 메뉴로 편집 팝업을 연다. 웹훅 원문은 팝업에 채우지 않으며, 빈 입력은 유지·연결 해제 체크는 제거로 처리한다.

운영 개요는 실제 소스 수·활성 소스 수·최근 수집 오류 소스 수·웹훅이 설정된 그룹 수와 최신 운영 로그 6개를 표시하며 30초마다 갱신한다. 별도의 그룹 연결·발송 검토 바로가기 카드는 두지 않는다. 소스 목록의 이름·URL·그룹 검색과 활성·중지·오류 필터는 브라우저에서 처리한다. 소스 폼은 기본 연결·그룹·메시지 설정을 먼저 보여주며, 발신 프로필·멘션·스레드 옵션은 펼쳐서 편집한다. 채널 유형 변경 시 이전 유형의 스레드·포럼 값은 명시적으로 비운다. 템플릿 편집기와 Discord 미리보기는 나란히 표시하고 좁은 화면에서는 세로로 배치한다. 로그는 실시간 연결 상태, 오류 필터, 일시정지·재개와 이전 기록 조회를 제공한다.

**소스·그룹** — 소스 URL은 중복 등록할 수 없고, 생성·수정 시 그룹을 최소 1개 선택해야 한다. 그룹에 웹훅이 없어도 설정은 저장할 수 있지만, 해석된 목적지가 0개인 소스는 수집을 건너뛴다. 수집 주기는 API 입력에서 60~86400초, 기본 300초다. 소스의 `fetchOptions` 입력으로 인코딩·User-Agent·추가 헤더·1~120초 타임아웃·TLS 최대 버전을 지정할 수 있다([source-input.ts](../src/server/services/source-input.ts), [validation.ts](../src/server/services/validation.ts)).

그룹 웹훅의 빈 입력은 기존 값을 유지하고, `clearWebhook=true`를 보내야 제거된다. 이름은 대소문자를 구분하지 않고 중복 검사한다. 여러 그룹이 같은 웹훅과 `threadId`를 가리키면 목적지를 하나로 합친다. 발신 이름·아바타는 소스 값이 그룹 값보다 우선한다([group.service.ts](../src/server/services/group.service.ts), [resolve-destinations.ts](../src/server/dispatcher/resolve-destinations.ts)).

**수동 수집·실패 재시도** — "지금 수집"은 별도 큐에 접수만 하는 API가 아니라 같은 PollWorker를 통해 수집 완료까지 기다리는 요청이다. 이미 수집 중이거나 종료 중이면 건너뛴다. 비활성 소스와 목적지 없는 소스도 수집하지 않는다. "실패 재시도"는 활성 연결의 `failed` 작업을 `pending`으로 바꾸고 횟수를 초기화한다. 응답 건수는 실제 전송 건수가 아니라 다시 대기시킨 작업 수다([scheduler.service.ts](../src/server/services/scheduler.service.ts), [delivery-job.repository.ts](../src/server/db/delivery-job.repository.ts)).

**템플릿** — 내장 프리셋은 `incident-active`, `news-article`, `link-discussion`, `minimal` 네 종류이며 부팅 때 이름을 키로 시드한다. 사용자 템플릿은 표시 이름과 본문으로 생성하거나 `cloneFrom`으로 복제한다. 내부 이름은 서버가 슬러그로 만들고 충돌 시 번호를 붙인다. 내장 템플릿은 표시 이름 변경은 가능하지만 본문 변경·삭제는 막는다. 템플릿 저장 자체는 입력 길이·필수 값 검사이며, 실제 Handlebars 렌더·JSON 파싱·Discord 제한 검증은 미리보기와 발송에서 수행한다([template.service.ts](../src/server/services/template.service.ts), [presets.ts](../src/server/dispatcher/presets.ts)).

프리셋 입력은 `item`·`source`이고, 제목·본문·링크·작성자·이미지·댓글·장애 단계·KST 표시 시각 등을 사용할 수 있다. 헬퍼는 `json`, `truncate`, `stageColor`, `stageLabel`, `eq`다. Discord 제한은 content 2000자, embed 최대 10개, embed 텍스트 합계 6000자 등을 검사한다. 정확한 입력 이름과 제한은 [render-context.ts](../src/server/contracts/render-context.ts), [validate.ts](../src/server/dispatcher/validate.ts)가 기준이다.

**미리보기와 테스트 발송** — 다음 세 동작을 구분한다.

| 동작 | 입력 항목 | 외부 통신·저장 |
| --- | --- | --- |
| `POST /api/preview`, `mode=sample`(기본) | 선택 소스의 최근 저장 항목. 없거나 소스를 선택하지 않으면 합성 샘플 | Discord·번역 호출과 항목 저장 없음 |
| `POST /api/preview`, `mode=live` | 선택 소스의 피드를 받아 첫 항목을 정규화. `sourceId` 필요 | 피드 GET만 수행. 304·빈 피드는 오류 결과이며 샘플로 대체하지 않음 |
| `POST /api/sources/:id/test` | 최근 저장 항목 또는 합성 샘플로 현재 프리셋 렌더 | 해석된 **첫 목적지 한 곳**에 실제 POST. 번역·발송 작업·발송 이력·운영 로그 저장 없음 |

미리보기는 `ok`와 `payload` 또는 `errors[{stage,message,path?}]`를 JSON으로 반환하며 오류 단계는 `fetch`·`render`·`validate`다. 테스트 메시지는 `🧪 [테스트 전송]` 표시를 붙이고 소스×목적지별 최소 5초 간격을 적용한다([preview.service.ts](../src/server/services/preview.service.ts), [test-send.service.ts](../src/server/services/test-send.service.ts)).

**번역 진단** — `/model`과 `GET /api/model/diagnostics`는 모델명, 상태(`ready`·`missing-key`·`invalid-key`·`cooldown`), 마지막 요청 시각·결과, 성공·실패·캐시·건너뛰기 건수를 보여준다. `keys.primary`·`keys.fallback`은 슬롯별 `state`(`missing`·`ready`·`cooldown`)와 재시도 시각 `retryAt`을, `keys.activeKey`는 다음 요청에 사용할 슬롯(`primary`·`fallback`·null)을 반환한다. 조회 자체로 Gemini를 호출하지 않으며 `ready`는 외부 API의 실시간 정상 응답을 보장하지 않는다. 집계는 보존 중인 `event_log` 행 기준이고 토큰 수·요금 집계는 제공하지 않는다. 기본·대체 두 번을 시도했다면 요청 결과도 두 건 기록한다.

번역은 환경 변수의 `PRIMARY_MODEL_API_KEY` → `FALLBACK_MODEL_API_KEY` 순서로 같은 Gemini 모델을 사용한다. 한도·인증·통신 오류가 난 키는 5분간 대기하고 다른 입력에도 재사용하지 않는다. 키별 한 번만 요청하며 모두 실패하면 원문을 발송한다. 빈 키와 중복 키는 제외하고, 대체 키만 있어도 동작한다. 일반 요청 오류(400·404), 생성 결과의 JSON 오류·출력 잘림에는 키를 바꿔 재요청하지 않는다. 대체 요청은 로그 detail에 `fallback:` 접두사, 모든 키 대기는 `keys-cooldown`을 남긴다. 진단과 로그에는 키 원문·공급자 예외 원문을 반환하지 않는다.

`POST /api/model/diagnose`는 제목(최대 1000자) 또는 본문(최대 3500자)을 받아 일반 피드 문맥으로 번역한다. 입력별 실패 캐시의 cooldown은 무시하고, `fresh=true`이면 성공 캐시도 우회한다. 키별 대기 시간은 진단에서도 유지한다. 동일 입력의 진행 중 요청은 여전히 공유하고, 한국어·빈 값 등의 로컬 처리도 유지한다. 진단은 공유 캐시와 번역 로그를 갱신하지만 항목·발송 작업을 만들지 않는다([model.service.ts](../src/server/services/model.service.ts), [translation-cache.service.ts](../src/server/translator/translation-cache.service.ts)).

**발송 검토** — 발송 작업의 현재 상태를 조회하고 보류 해제·발송 완료 확인·보관을 처리하는 화면이다. 시스템 로그의 전송 탭은 결과 이력을 보여주는 별도 화면이며, 로그를 지워도 발송 판단이나 검토 상태가 바뀌지 않는다. `state`·`sourceId`·`before`로 최신 작업을 최대 200개씩 조회한다. 검토 요청의 `decision`은 다음과 같다([delivery-management.service.ts](../src/server/services/delivery-management.service.ts)).

| 현재 상태 | `decision` | 결과 |
| --- | --- | --- |
| `held` | `send` | 연결이 활성일 때 `pending`으로 바꿔 워커가 발송 |
| `held`·`unknown`·`uneditable` | `historical` | 작업을 `cancelled`로 보관. `items.historical`을 바꾸는 요청은 아님 |
| `unknown` | `confirm_delivered` + `messageId` 필수 | 원본 발송 기록을 등록하고 `succeeded` 처리. `threadId`·`channelId`는 선택이며 더 최신 내용이 있으면 수정 재계획 |

**로그·실시간 스트림** — 목록은 기본 `type=delivery`이고 `fetch`·`translation`도 선택할 수 있다. 최신 ID부터 조회하며 `before`와 `nextBefore`로 이전 페이지를 읽는다. 기본 100개, 최대 500개다. SSE는 세 종류를 모두 전송하며 이벤트 이름은 `delivery`·`fetch`·`translation`, `id`는 단일 `event_log.id`다. 처음에는 전체 종류를 합친 최근 50개를 오래된 순으로 보내고, 재연결은 숫자 `Last-Event-ID` 이후부터 최대 100개씩 읽는다. 1초마다 추가 조회, 15초마다 ping, 동시 연결은 기본 5개이며 초과 시 503이다([logs.ts](../src/server/controllers/api/logs.ts), [log.service.ts](../src/server/services/log.service.ts)).

**내보내기·가져오기** — 내보내기는 `kind=rss-discord-bridge/export`, `version=1`인 JSON 파일이다. 소스·그룹 설정과 템플릿 이름 참조를 담고, 템플릿 본문·항목·발송 이력·로그·번역 캐시·API 키·웹훅 URL·추가 요청 헤더는 제외한다. 자동 TLS 호환 모드 고정값도 제외한다. 설정 이전 후 웹훅은 다시 입력하고, 사용자 템플릿 본문은 별도로 이전해야 한다.

가져오기는 파일 또는 `content` 문자열을 최대 1MiB까지 받는다. `skip`(기본)은 기존 소스를 피드 URL로, 그룹을 대소문자 무시 이름으로 찾아 건너뛰고, `overwrite`는 해당 설정을 갱신한다. 미리보기는 DB 변경 없이 예상 건수·미해결 참조·웹훅 재입력·차단 사유를 보여준다. 적용 시 문서·DNS·웹훅을 다시 검사한 뒤 한 트랜잭션으로 반영한다. 차단된 소스는 제외하고, 새 소스는 `initialized=false`와 현재 cutoff로 시작한다([export-import.service.ts](../src/server/services/export-import.service.ts), [export-import.document.ts](../src/server/services/export-import.document.ts)).

## 4. HTTP 요청과 응답 목록

명시적으로 등록된 경로는 관리 페이지 10개, 관리 API 29개, 상태 점검 2개다. Fastify의 자동 HEAD와 `/assets/*` 정적 자산 경로는 이 수에서 제외한다. 관리 페이지 경로는 §2의 기능별 표에 있고, 아래 표는 API와 상태 점검의 **정상 응답**이다. `/api`가 붙어 있어도 모든 변경 요청이 JSON을 반환하는 것은 아니다.

`HX-Request: true`를 보낸 요청을 htmx 요청으로 판단한다. "HX 이동"은 본문 없는 204와 `HX-Redirect` 헤더이며 일반 HTTP 3xx 리다이렉트가 아니다.

| 메서드 | 경로 | 정상 응답 |
| --- | --- | --- |
| GET | `/api/sources` | 소스 목록 JSON |
| GET | `/api/sources/:id` | 소스 JSON |
| POST | `/api/sources` | htmx: `/sources`로 HX 이동 / 그 외: 소스 행 HTML |
| PATCH | `/api/sources/:id` | htmx: `/sources`로 HX 이동 / 그 외: 소스 행 HTML |
| DELETE | `/api/sources/:id` | 본문 없는 204 |
| PATCH | `/api/sources/:id/enabled` | 소스 행 HTML |
| POST | `/api/sources/:id/poll` | 수집 처리 후 안내 HTML |
| POST | `/api/sources/:id/test` | 테스트 전송 성공 안내 HTML |
| POST | `/api/sources/:id/retry-failed` | 다시 대기시킨 작업 수 안내 HTML |
| GET | `/api/sources/:id/sample-item` | 저장된 항목 또는 샘플 JSON |
| GET | `/api/groups` | 그룹 목록 JSON(웹훅 마스킹) |
| POST | `/api/groups` | 그룹 행 HTML |
| PATCH | `/api/groups/:id` | 그룹 행 HTML |
| DELETE | `/api/groups/:id` | 본문 없는 204 |
| GET | `/api/templates` | 템플릿 목록 JSON |
| GET | `/api/templates/:id` | 템플릿 JSON |
| POST | `/api/templates` | 템플릿 행 HTML |
| PATCH | `/api/templates/:id` | 저장 안내와 템플릿 행 HTML |
| DELETE | `/api/templates/:id` | 본문 없는 204 |
| POST | `/api/preview` | `ok`·`payload` 또는 단계별 오류 JSON |
| GET | `/api/model/diagnostics` | 모델 상태·최근 요청·건수 JSON |
| POST | `/api/model/diagnose` | htmx: 진단·상태 HTML / 그 외: 진단 JSON |
| GET | `/api/delivery-jobs` | 작업 목록 JSON |
| POST | `/api/delivery-jobs/:id/review` | htmx: `/delivery-jobs`로 HX 이동 / 그 외: 갱신된 작업 JSON |
| GET | `/api/logs` | 로그 목록과 `nextBefore` JSON |
| GET | `/api/logs/stream` | `text/event-stream` |
| GET | `/api/export` | 날짜가 포함된 파일명의 JSON 다운로드 |
| POST | `/api/import/dry-run` | 예상 결과 HTML |
| POST | `/api/import` | 적용 후 `/sources`로 HX 이동 |
| GET | `/healthz` | `{"status":"ok"}` JSON |
| GET | `/ready` | DB `SELECT 1` 성공 시 `{"status":"ready"}` JSON |

HTML 변경 응답을 만드는 공통 헬퍼는 `AppError`를 필드 오류 HTML로 변환한다. 그 외 경로의 오류는 전역 처리기가 `{error:{code,message,fields?}}` JSON으로 응답한다. 주요 상태는 검증·보안 오류 400, 없는 리소스 404, 충돌 409, rate limit 429, 예상하지 못한 내부 오류 500이다. 미리보기의 렌더·검증 실패는 위 `ok=false` 결과로도 반환된다([helpers.ts](../src/server/controllers/api/helpers.ts), [app.ts](../src/server/app.ts)).

## 5. 요청 보안과 입력 범위

- 관리 페이지·API는 Host를 검사하고, GET·HEAD·OPTIONS 외 브라우저 요청은 Origin 또는 Referer도 검사한다. 두 출처 헤더가 없는 CLI 요청은 허용된 Host라면 통과한다. 로그인 인증을 대신하는 구조는 아니며 운영 접속은 SSH 터널을 전제로 한다.
- `/assets/*`는 Host·Origin 검사에서 제외된다. 루트에 등록한 `/healthz`·`/ready`에도 관리 라우트의 Host·Origin 훅이 적용되지 않는다.
- HTTP rate limit은 기본 분당 120회다. `/assets/`, `/api/logs/stream`, `/healthz`, `/ready` 접두 경로는 제외하고 SSE는 별도 동시 연결 수로 제한한다.
- 피드는 HTTP·HTTPS만 허용하고, 사용자 정보가 붙은 URL·내부 IP·loopback·사설망·link-local 등은 차단한다. DNS의 모든 반환 주소를 검사하고 실제 연결 시 DNS 조회에도 적용한다. 리다이렉트는 수동 처리하며 새 주소를 다시 검사한다.
- Discord 웹훅은 HTTPS와 허용 호스트(`discord.com`, `discordapp.com`)·경로만 허용한다. 토큰 대소문자를 유지한 canonical URL과 `threadId`로 목적지를 식별한다.
- 폼·JSON·multipart 본문을 받는다. 가져오기 업로드는 파일 1개, 1MiB이며 multipart 필드는 최대 4개다. Discord ID는 정수 정밀도 손실을 막기 위해 숫자 문자열로 다룬다.

근거: [admin-origin.ts](../src/server/middleware/admin-origin.ts), [ip.ts](../src/server/security/ip.ts), [webhook-guard.ts](../src/server/security/webhook-guard.ts), [app.ts](../src/server/app.ts).

## 6. 현재 동작 범위와 알려진 한계

2026-10-18 코드 점검 기준이다. 아래 동작을 구현된 기능으로 오해하지 않도록 구분한다.

| 위치 | 현재 동작·제약 |
| --- | --- |
| 발송 예외 → POST → `unknown` | DNS 실패·연결 거부처럼 요청이 나가지 않은 경우도 `unknown`이 된다. `unknown`에는 재발송 조치가 없다 |
| 작업 검토 `held`·`unknown` | 건수 알림이 없어 `/delivery-jobs`에 들어가야 보인다 |
| 발송 순서 | 같은 poll의 날짜 없는 신규 항목은 피드 순서(보통 최신 글 먼저)대로 발송된다 |
| 수집 항목별 처리 | poll마다 모든 항목의 `last_seen_at`을 개별 UPDATE한다 |
| 정리 | 성공 번역 캐시는 정리하지 않는다 |
| 실시간 미리보기 | `createContainer()`는 `FEED_MAX_BYTES`를 PollService에만 전달한다. PreviewService는 fetch 옵션을 주입받지 않아 기본 5MiB 제한을 쓴다. 소스별 타임아웃 등 `fetchOptions`는 미리보기에도 사용한다([container.ts](../src/server/runtime/container.ts), [preview.service.ts](../src/server/services/preview.service.ts)) |
| 잘못된 payload 자료형 | `{ "embeds": {} }`처럼 자료형이 틀리면 AJV 오류를 모은 뒤 길이 합산에서 `TypeError`가 먼저 발생한다. 미리보기는 `render` 오류로, 발송은 일반 준비 실패로 표시될 수 있어 검증 단계·필드 경로가 정확하지 않다([validate.ts](../src/server/dispatcher/validate.ts)) |
| 프리셋 저장 | 저장 성공이 Discord로 보낼 수 있는 JSON이라는 뜻은 아니다. 저장된 본문은 미리보기·발송 단계에서 렌더·payload 검증을 받는다 |
| 설정 이전 | Export는 DB 전체 백업이 아니다. 사용자 템플릿 본문·웹훅·추가 요청 헤더·항목·발송 이력·로그·번역 캐시는 복구하지 않는다 |
| 기존 DB | 이전 내용의 같은 `0001_init`은 자동 변환하거나 거부하지 않는다. 현재 초기 스키마로 만든 DB가 필요하다([부팅·DB 호환 범위](architecture.md#4-런타임-부팅--워커--종료)) |

### 현재 제공하지 않는 기능

- 앱 내 로그인·다중 사용자·역할별 권한, 원격 공개용 인증.
- Gemini 이외 번역 공급자·대체 모델, 관리 API를 통한 모델·키 변경, 한국어 이외 대상 언어.
- 번역 토큰 수·요금·프롬프트 원문 사용량 기록. 현재는 결과 상태와 소요 시간·건수만 남긴다.
- `unknown` 작업의 자동 또는 관리자 강제 재POST, PATCH 404를 새 POST로 대체하는 처리.
- 웹소켓, 별도 프런트엔드 SPA, 다중 프로세스 수집·발송, 외부 작업 큐.

## 7. 검증 방법과 범위

점검 기준 `5e4b68c`의 서버 100개 파일을 목록·구문·경로로 확인하고, HTTP → 서비스 → 저장소와 수집·발송·번역·종료의 호출 흐름을 대조했다. 코드에서 추출한 41개 명시 HTTP 경로와 §2·§4의 페이지·API 목록을 맞췄다. 보호된 스키마 계약의 정확한 테이블·컬럼·인덱스·트리거는 기존 문서 검증 테스트로 확인한다.

현재 서버 파일 수는 진입부 3개, `contracts` 4개, `controllers` 11개, `db` 13개, `dispatcher` 7개, `domain` 14개, `middleware` 2개, `runtime` 5개, `scheduler` 1개, `security` 7개, `services` 21개, `translator` 7개, `workers` 5개다. `index.ts`의 재수출과 타입 전용 파일을 포함하며 `.gitkeep`은 제외한다.

| 검증 | 명령·근거 | 확인 범위 |
| --- | --- | --- |
| 타입 | `npm run typecheck` | 서버·테스트 양쪽 tsconfig의 타입·import 정합성 |
| 전체 테스트 | `npm test` | 31개 파일·228개 테스트: 파싱·정규화·저장소·스키마 문서·라우트·연결 세대·발송 복구·번역 캐시·수집 제한·종료 |
| 서버 컴파일 | `npm run build:server` | `src/server` → `dist/server` TypeScript 컴파일 |
| 배포용 빌드 | `npm run build` | `dist` 정리·서버 컴파일·리소스 복사. 이전 마이그레이션이나 자산을 남기지 않으려면 전체 빌드 사용 |
| 재현 확인 | `{ "embeds": {} }`를 `validateDiscordPayload()`에 전달 | §6의 payload 자료형 오류를 실제 실행으로 확인 |

테스트는 fixture·주입된 통신 함수와 일부 로컬 HTTP 서버를 사용한다. 실제 외부 피드의 가용성, Gemini 계정의 권한·과금, 실제 Discord 웹훅 응답은 별도의 운영 환경 확인 대상이다. `/ready` 역시 현재 DB의 `SELECT 1` 성공 여부이며 외부 서비스 상태를 검사하지 않는다.
