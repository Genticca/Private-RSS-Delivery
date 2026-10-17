# 기능 개편 및 핵심 코드 리팩토링 완료 보고서

기준: [통합 개편 보고서](2026-10-16-consolidated-reorganization-report.md). 작성일: 2026-10-16.

## 적용 범위와 승인

Node.js·Fastify·TypeScript·SQLite 단일 프로세스·Handlebars·htmx·CodeMirror·SSE를 유지했다. Go 전환과 PostgreSQL·Docker·Cloudflare Access 구축은 별도 작업이다. 기존 서비스 파일은 새 실행 진입점과 종료 대기 시간에 맞게 조정했다.

사용자가 `Docs/Architecture/backend-spec.md` §4.2·4.4·4.6·4.7·4.9·4.11 및 Fetch/runtime, `frontend-spec.md` §4.3·4.4 및 모델 화면 수정을 명시 승인했다. 두 문서 상단의 D25 계약이 해당 항목의 이전 동작보다 우선한다. 기존 editInPlace 유지, 연결 첫 성공 수집 묵음 baseline, 불명확한 발송 자동 중단, PATCH 404 자동 POST 금지, 대량 신규 보류, 번역 파싱 실패 원문 발송 정책도 승인받았다.

## 핵심 구조

| 역할 | 현행 코드 |
| --- | --- |
| 부팅·listen·signal | [main.ts](../../../../src/server/main.ts) |
| HTTP 앱 구성 | [app.ts](../../../../src/server/app.ts) |
| 환경·조립·종료 대기 | [runtime](../../../../src/server/runtime/container.ts), environment.ts, lifecycle.ts, options.ts |
| 주기·동시성·중복 실행·진행 중 작업 추적 | [PollWorker](../../../../src/server/workers/poll-worker.ts), [DeliveryWorker](../../../../src/server/workers/delivery-worker.ts), TaskTracker |
| 수집·저장·발송 작업 계획 | [PollService](../../../../src/server/services/poll.service.ts), [DeliveryPlanService](../../../../src/server/services/delivery-plan.service.ts) |
| 연결 세대·설정 변경 | [DeliveryBindingService](../../../../src/server/services/delivery-binding.service.ts) |
| 발송 한 건 처리 | [DeliveryService](../../../../src/server/services/delivery.service.ts) |
| Discord HTTP | [DiscordClient](../../../../src/server/dispatcher/discord-client.ts) |
| 순수 판정 | domain/delivery, domain/translation, domain/text.ts |
| 입력·문서 검증 | services/source-input.ts, services/export-import.document.ts |
| 공유 번역 캐시 | [TranslationCacheService](../../../../src/server/translator/translation-cache.service.ts) |
| SQL 접근 | db/*repository.ts |

서비스는 런타임 컨테이너 전체 대신 필요한 repository 메서드를 받는다. Stage 1 Envelope / Stage 2 Normalize, `(source_id, atom_id)` 식별과 결정적 contentHash 계산은 유지했다. 이전 poller·webhook 구현과 대체된 테스트·재현 자료는 [Archive](../../../../Archive/README.md)에 보관하며 빌드·Vitest 입력에서 제외했다.

## 기능 변경

| 통합 보고서 항목 | 적용 내용 |
| --- | --- |
| A1·A2·A5~A8 | 항목×연결 세대별 영속 발송 기록과 job. 목적지 고정, 로그와 message ID 분리, revision으로 H1→H2→H1 처리 |
| A3 | 수동·예약 작업을 모두 추적. 신규 작업 차단→drain→DB/Agent 종료. drain timeout이면 사용 중 DB를 닫지 않음 |
| A4 | 본문 스트림까지 timeout 유지, 선언 길이와 실제 읽은 바이트 제한, 초과 시 취소 |
| A9·A10 | 대량 신규 held 및 관리자 검토, poll 커밋 시 설정 버전 재확인. feed URL·fetch 설정·그룹·전송 설정 변경 경합 방지 |
| A11·A12 | 같은 웹훅의 스레드들이 cooldown을 공유. 429는 일반 실패 횟수에서 제외. 날짜가 있으면 게시 시각 순, 없으면 관측 순으로 처리 |
| A13 | POST timeout·5xx·응답 ID 미상·성공 후 커밋 실패는 unknown. 재시작 시 시작된 POST를 자동 재POST하지 않음 |
| B1 | .env 병합 결과를 config·ModelTranslator·ModelService에 함께 주입. process 환경 우선, 키는 DTO/DB에 저장하지 않음 |
| B2~B5 | 실패 cooldown과 성공 캐시 분리. payload 고정. Gemini signal/schema 전달. AST 필드 선택, 입력별 공유 캐시, 미스 필드 묶음, single-flight |
| B7·B8 | 키 상태와 최근 요청 결과 구분. 요청 시도·cache hit·local skip·fallback·잘림·토큰·item/job 상관관계. Discord 없는 번역 진단 |
| D1·D2·D3 | 수집·발송 독립 실행과 동시성 제한. 식별자·해시를 남기는 본문 tombstone. 같은 generic 해시에서도 표시 내용 갱신 |
| F1·G1~G5 | 역방향 의존 제거, 입력/문서 검증 분리, 인증서 오류 재시도 방지, 자동 TLS pin 하루 후 재검사, 영구 redirect 반영, 실패 backoff/표시, 목적지 없는 소스 기아 방지, SSE 재연결 cursor, 테스트명 정리 |

추가로 웹훅 토큰을 소문자화하던 연결 식별을 고쳤다. 토큰 대소문자는 보존하고 Discord 호스트 별칭·마지막 slash만 정규화한다. HTTP 요청의 스레드 설정은 source 필드를 사용한다. 같은 토큰의 대소문자 변경은 새 세대가 되며, 호스트 별칭만 다른 동일 목적지는 중복 발송하지 않는다.

번역 실패 예외에 인증키가 포함되더라도 provider 예외 원문을 DB에 저장하지 않는다. 캐시 준비/저장 오류에서 대기 중 single-flight를 정리하고, 오래된 번역 응답은 최신 item 내용을 덮어쓰지 않는다. 번역 감사 이벤트와 오래된 실패 캐시는 정리하고 성공 캐시는 유지한다.

## DB와 운영 동작

- `0021_delivery_jobs.sql`: binding·receipt·job·cooldown, item revision/관측/본문 축소 상태, source 설정 버전/연속 실패. 기존 pending/failed는 legacy_unknown으로 격리한다.
- `0022_translation_cache.sql`: 성공/실패 번역 캐시, 번역 이벤트, 모델 요청 여부와 item/job 연결.
- `0023_source_fetch_revision.sql`: 기존 0021 파일을 바꾸지 않고 fetch 설정·poll 주기도 설정 변경 감지에 포함한다.
- 기존 0001~0020 마이그레이션은 수정하지 않았다. 이관과 데이터 보정은 migrator의 버전별 트랜잭션 안에서 수행하며 재실행은 새 작업을 만들지 않는다.
- 구형 source_groups에는 연결 생성 시각이 없어 세대 계보를 증명할 수 없다. 성공 로그에서 찾은 ID는 **종료된 이전 연결**에 보존하며 현재 연결로 자동 채택하지 않는다. 진행 중 장애의 기존 갱신 일부가 중단될 수 있다.
- 기존 historical·완료 건을 재큐하지 않는다. 새 활성 연결은 첫 성공 수집을 묵음 baseline으로 삼는다. 첫 스냅샷 전 새 글도 제외될 수 있다.
- 운영 반영은 앱 정지→일관된 DB 백업→사본에서 이관 확인→계획/실행 경로 함께 전환 순서다. 롤백은 이관 전 DB 백업과 이전 코드를 함께 복원해야 한다.

실행 진입점은 `src/server/main.ts` / `dist/server/main.js`다. npm dev/start, smoke와 기존 systemd 예시를 동기화했다. systemd의 종료 대기는 15초에서 90초로 늘렸다. 실제 서버 배포·서비스 재시작은 수행하지 않았다.

빌드 전에는 검증된 프로젝트 내부의 생성 산출물 `dist`만 정리한다. tsc+copyfiles 방식은 유지하고, 삭제한 구형 dispatcher/poller의 JS 산출물이 남지 않게 했다.

## 관리자 UI/API

| 경로 | 동작 |
| --- | --- |
| `/delivery-jobs` | 상태/소스 필터·페이지 이동, 목적지별 작업 검토 |
| `GET /api/delivery-jobs` | snapshot·payload·webhook 비밀 URL을 제외한 DTO |
| `POST /api/delivery-jobs/:id/review` | held는 send/historical, unknown은 메시지 ID 확인 또는 historical, legacy_unknown/uneditable은 보관 처리 |
| `POST /api/sources/:id/retry-failed` | 기존 유효 연결의 failed 작업만 재시도. 반환 건수는 작업 수이며 unknown/held는 제외 |
| `GET /api/model/diagnostics` | 키 존재 상태·최근 실제 요청 결과·요청/캐시 지표 |
| `POST /api/model/diagnose` | Discord 없이 번역 진단. 성공 캐시 대신 새 요청 옵션 지원 |

번역 진단의 htmx 응답은 부분 HTML과 상태 영역 OOB 갱신이다. 미리보기는 기존대로 원문 렌더다. 관리자 입력의 SSRF 검사와 production loopback 제약을 유지했다.

## 설정 기본값

| 환경 변수 | 기본값 |
| --- | --- |
| POLL_CONCURRENCY / DELIVERY_CONCURRENCY | 각각 2 |
| SHUTDOWN_TIMEOUT_MS | 30000 |
| FEED_MAX_BYTES | 5242880 (5 MiB) |
| NEW_ITEMS_HOLD_COUNT / NEW_ITEMS_HOLD_MIN / NEW_ITEMS_HOLD_RATIO | 50 / 10 / 0.8 |
| ITEM_CONTENT_RETENTION_DAYS | 180 |

초기 baseline을 제외하고 신규 50건 이상 또는 신규가 10건 이상이며 스냅샷의 80% 이상이면 held다. 값은 [default.env.example](../../../../default.env.example)에 기록했다. 감사 로그는 기존 90일 정책을 유지하며, 본문 축소는 진행 중·보류·실패·미확정 작업이 있는 항목을 제외한다.

## 검증

- 변경 전: 서버/테스트 타입 검사, 22파일·164개 Vitest 통과.
- 변경 후: 서버/테스트 타입 검사, **31파일·213개 Vitest 통과**, clean build와 리소스 복사 통과.
- 최종 `node scripts/smoke.mjs`: 실제 빌드 서버 부팅, health/ready, 정적 자산, API·import, SSE ping 통과. 임시 DB와 loopback 포트 사용.
- Edge/Playwright: 보류 항목 보관, 상태 필터, 번역 진단과 즉시 상태 갱신, desktop 1440px / mobile 390px. 페이지 오류 0, 페이지 가로 넘침 0. 시각 확인 완료.
- 신규/교체 통합 테스트: 웹훅·스레드 교체/추가·중복, 부분 성공/독립 재시도, 로그 정리, H1→H2→H1, PATCH 404, POST 불명/커밋 실패, 429, 순서, 번역/설정 경합, import/그룹 삭제, 본문 제한, 종료 drain, 환경 키 전달, Gemini 어댑터, legacy 이관, SSE resume, 본문 tombstone.
- Windows 테스트 환경의 누락된 OS 네이티브 바인딩을 복구했다. OS가 다른 환경은 각 플랫폼에 맞는 의존성을 설치해야 한다. 이 셸에는 npm 명령이 없어 `node node_modules/typescript/bin/tsc`, `node node_modules/vitest/vitest.mjs`, copyfiles CLI로 npm 스크립트와 같은 검사를 실행했다.

로컬 synthetic benchmark (`node scripts/benchmark.mjs`, Node v24.19.0 / Windows x64):

| 지표 | 결과 |
| --- | --- |
| 소스 / 초기 historical / 신규 발송 | 25 / 500 / 25 |
| 모의 모델 요청 | **1회** (동일 제목 공유, minimal) |
| baseline / 작업 계획 / 발송 | 281.55 / 168.31 / 389.09 ms |
| 합계 / CPU 시간 | 838.95 / 609 ms |
| RSS / heap | 114.22 / 32.42 MiB |
| event loop 지연 평균 / 최대 | 17.06 / 29.23 ms |

외부 API를 모의 처리한 로컬 검증이며 OCI Ampere 실측이나 실제 번역 품질·과금 절감률의 측정값이 아니다. 운영 DB 사본·실제 Discord/Gemini/NIM 호출은 검증하지 않았다. 현재 단일 프로세스 전제이며 다중 프로세스의 claim/lease 확장은 별도 작업이다.

## 별도 결정/실험

README_DEV.md 추적·위치·보호 목록 정비는 이번에 승인된 두 설계 문서 항목과 별개여서 유지했다. 본문 발췌·묶음 번역·비동기 Batch·context caching·thinking 조정은 보고서대로 품질/비용 비교 후 검토한다. Go/DBMS/외부 접근 전환과 실제 운영 이관은 후속 작업이다.
