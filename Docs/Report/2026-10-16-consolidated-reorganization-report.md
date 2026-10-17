# rss-discord-bridge 통합 개편 보고서

작성일: 2026-10-16 (Asia/Seoul) · 통합 작성: Claude

2026-09-07 구조 조사와 2026-10-16 Codex 조사, 그리고 같은 날 Claude의 보완 조사를 **하나의 문제 목록과 하나의 구현 순서로 합친 문서**다. 각 항목의 상세 근거·재현·설계는 출처 문서에 있으며, 이 문서는 출처를 링크로 표시한다. 구현 완료 보고서나 보호 설계 문서를 대체하는 계약이 아니다.

> **범위: 기능·성능 수정만 다룬다.** 배포·인프라 항목(Node 런타임 버전, ARM64 빌드, 배포 문서, Docker, PostgreSQL 전환, SQLite 운영 백업, Cloudflare Access 등 외부 접근)은 이 문서에서 제외했다. 제외한 항목과 출처는 [부록](#부록-이-문서에서-제외한-배포인프라-항목)에 남겼다. DB는 현재의 SQLite·단일 프로세스 구성을 전제로 한다.

## 출처 문서

| 약칭 | 문서 | 작성 | 성격 |
| --- | --- | --- | --- |
| **[9월]** | [project-structure-review.md](Archive/2026-09-07/project-structure-review.md) (원래 워크스페이스 루트 `PROJECT_STRUCTURE_REVIEW.md`) | 2026-09-07 | 구조·장애 경로 조사 |
| **[9월-노트]** | [2026-09-07-structure-review-notes.md](Archive/2026-09-07/2026-09-07-structure-review-notes.md) | 2026-09-07 | 설계 문서 관련 발견 요약 |
| **[요약]** | [2026-10-16-reorganization-summary.md](Archive/2026-10-16/2026-10-16-reorganization-summary.md) | Codex | 개편 현황과 추진 방향 |
| **[원인]** | [2026-10-16-webhook-history-investigation.md](Archive/2026-10-16/2026-10-16-webhook-history-investigation.md) | Codex | 새 웹훅 과거 발송 원인·재현 |
| **[발송]** | [2026-10-16-webhook-delivery-improvement-plan.md](Archive/2026-10-16/2026-10-16-webhook-delivery-improvement-plan.md) | Codex | 목적지별 발송 모델·이관·테스트 |
| **[번역]** | [2026-10-16-translation-api-optimization.md](Archive/2026-10-16/2026-10-16-translation-api-optimization.md) | Codex | 번역 API 절감 |
| **[Access]** | [../Deploy/CLOUDFLARE_ACCESS_PLAN.md](../Deploy/CLOUDFLARE_ACCESS_PLAN.md) | Codex | Cloudflare Access + Tunnel 검토 (배포 항목 — 본문 제외, 부록 참조) |
| **[보완]** | [2026-10-16-additional-reorganization-findings.md](Archive/2026-10-16/2026-10-16-additional-reorganization-findings.md) | Claude | 누락 항목·추가 발견 |

출처 문서는 2026-10-16 문서 정리 때 `Docs/Report/Archive/`로 옮겼다. 이 통합 보고서와 [구현 보고서](2026-10-16-implementation-report.md)가 현재 기준이다.

재현 스크립트: [2026-10-16-webhook-history-repro.mjs](../../Archive/2026-10-16/Docs/Report/2026-10-16-webhook-history-repro.mjs), [2026-10-16-translation-usage-repro.mjs](../../Archive/2026-10-16/Docs/Report/2026-10-16-translation-usage-repro.mjs).

## 0. 결론

1. **프레임워크·언어를 바꾸지 않는다.** Fastify·TypeScript·Handlebars·htmx·SQLite 단일 프로세스와 Stage 1/2 분리, `(source_id, atom_id)` 식별, 첫 poll historical 처리, SSRF 방어는 유지한다. Go 전환과 별도 큐 서버는 선행 조건이 아니다. [9월] [요약]
2. **핵심 결함은 "발송 상태를 RSS 항목 하나에 두고, 발송 시점에 현재 그룹 전체로 다시 펼치는 구조"다.** 웹훅 교체·추가 후 과거 항목이 새 목적지로 POST되는 경로가 재현됐다. 해결책은 발송 단위를 **항목 × 목적지 연결(세대)** 로 옮기는 것이다. [9월] [원인] [발송]
3. **재전송·중복의 경로는 웹훅 교체 하나가 아니다.** 셧다운 경합, 대량 신규 판정, poll과 설정 변경의 경합, 로그 정리 후 message ID 소실, PATCH 404 자동 POST도 같은 증상을 만든다. 운영 사건의 원인은 아직 확정되지 않았다. [9월] [발송] [보완]
4. **번역은 설정 경로 버그(`.env` 키 미전달)부터 고치고**, 그다음 실패 캐시 분리·필드 선택·공유 캐시로 호출량을 줄인다. [9월] [번역] [보완]
5. **스키마 변경 없이 바로 고칠 수 있는 결함이 먼저다.** `.env` 키 전달, 셧다운 drain, 피드 본문 타임아웃·크기 상한은 발송 모델 재설계와 독립적으로 수정할 수 있다. [9월] [보완]
6. **현재 오류는 SQLite 때문이 아니다.** 제안한 발송 모델은 SQLite·단일 프로세스에서 구현할 수 있다. [요약] [발송]

## 1. 현재 상태

| 항목 | 상태 | 출처 |
| --- | --- | --- |
| 애플리케이션 | v0.4.0, Node.js·TypeScript(ESM)·Fastify 5, better-sqlite3(WAL), 단일 프로세스 | [요약] |
| 구현 범위 | controllers·services·domain·db·scheduler·dispatcher·translator·security·workers 구현 완료, 마이그레이션 0001~0020, 테스트 파일 22개 | [9월] [보완] |
| Git | `main`은 `342d9dd` 1커밋. `backup/original-with-claude-coauthor` 등 전체 ref로는 67커밋(내용 동일, 파일 모드 차이만) | [9월] |
| 처리 흐름 | `Poller → fetchFeed → parseFeed → normalize → items 저장/재큐 → WebhookDispatcher → 번역 → Handlebars 렌더 → Discord`. 목적지는 발송 시점에 `source_groups → groups.webhook_url`로 계산 | [9월] |
| 운영 데이터 | 로컬 기본 DB의 sources·items·delivery_log·model_usage가 비어 있음. 실제 운영 사건·비용은 미확인 | [9월] [원인] [번역] |
| 성능 목표 | 1 OCPU·RAM 6GB 소규모 서버에서 동작. 실제 부하 측정은 하지 않음 | [요약] |

복잡도가 몰린 파일: `dispatcher/webhook.ts`, `services/export-import.service.ts`, `scheduler/poller.ts`. 파일 길이보다 대상 결정·수정·네트워크·재시도·DB 커밋을 한 클래스가 함께 맡는 점이 위험 요인이다. [9월]

## 2. 통합 문제 목록

상태 표기:
- **재현**: 진단 스크립트 assertion으로 확인
- **코드 확인**: 코드와 설정으로 확인
- **정적 판단**: 코드 흐름으로만 판단, 실행 확인 없음

### 2.1 P0: 오발송·중복·정지를 직접 일으킴

| ID | 문제 | 상태 | 출처 |
| --- | --- | --- | --- |
| A1 | 발송 후 내용 해시가 바뀐 항목이 **현재** 그룹 웹훅으로 재전송됨. 새 웹훅 B에는 message ID가 없어 `editInPlace=true`여도 POST | 재현 | [9월] [원인] |
| A2 | 이미 pending인 항목은 내용 변경 없이도 웹훅 교체 후 새 웹훅으로 POST | 재현 | [원인] |
| A3 | 셧다운이 진행 중 tick을 기다리지 않고 DB를 닫음 → Discord 성공 후 기록 실패 → 재시작 후 재POST | 정적 판단 | [보완] |
| A4 | 피드 본문 읽기에 앱 타임아웃·크기 상한 없음(undici 기본 300초). 직렬 tick이라 피드 하나가 전체 수집·발송을 멈춤 | 코드 확인 | [보완] |
| B1 | `.env` 파일의 API 키가 번역기·ModelService에 전달되지 않음 → `missing-key` → 원문 발송. 프로세스 환경 변수로 직접 주입한 경우에만 동작 | 재현 | [9월] |

### 2.2 P1: 재전송·누락·비용의 주요 경로

| ID | 문제 | 상태 | 출처 |
| --- | --- | --- | --- |
| A5 | Discord message ID를 90일 후 삭제되는 `delivery_log`에서만 조회 → 로그 정리 후 같은 목적지에도 새 POST | 재현 | [9월] [발송] |
| A6 | PATCH 404면 자동 새 POST. `editInPlace` OFF로 발송한 항목은 ID 미수집 → 나중에 ON으로 바꿔도 POST | 코드 확인 | [9월] [발송] |
| A7 | 내용 H1→H2→H1 복귀 시 옛 H1 성공 로그 때문에 필요한 PATCH가 생략됨 | 재현 | [발송] |
| A8 | 재시도·실패 상태가 항목 하나에 저장됨. 한 목적지 실패가 다른 목적지에 영향을 주고, 재시도 중 그룹이 바뀌면 대상이 재계산됨 | 코드 확인 | [9월] [발송] |
| A9 | 초기화된 소스에서 한 poll에 대량 "신규" 판정을 막는 장치 없음(guid 체계 변경, 날짜 없는 항목, 오류 응답) | 정적 판단 | [보완] |
| A10 | 진행 중 poll과 feedUrl 변경의 경합 → 옛 피드 항목 신규 발송, 새 URL baseline 생략 | 정적 판단 | [보완] |
| A11 | 같은 웹훅의 429 이후에도 같은 tick에서 계속 요청. 429도 재시도 5회에 포함 → 버스트 시 알림 유실 | 코드 확인 | [보완] |
| A12 | 한 poll의 신규 항목이 최신 글부터 발송됨(피드 순서대로 삽입, `ORDER BY next_attempt_at, id`) | 코드 확인 | [보완] |
| A13 | 최초 POST의 timeout·5xx를 일반 재시도로 처리 → 실제로는 성공했을 때 중복 | 정적 판단 | [발송] |
| B2 | 번역 실패로 돌려받은 원문도 `translatedAt`과 함께 저장 → 키·서비스 복구 후에도 해당 항목은 재번역 안 됨. 기존 테스트가 이 동작을 기대함 | 재현 | [9월] [번역] |
| B3 | Gemini 어댑터가 AbortSignal을 SDK에 넘기지 않음 → timeout 후 주 요청이 계속되는 동안 fallback 시작 | 재현 | [9월] [번역] |
| B4 | `minimal` 프리셋은 본문을 표시하지 않는데 본문까지 번역 | 재현 | [번역] |
| B5 | 번역 캐시가 항목 ID별 → 다른 항목의 같은 원문을 중복 번역. 내용 변경 시 제목·본문 캐시를 모두 삭제 | 재현 | [번역] |
| C1 | 기존 테스트가 문제 동작(전체 재큐, OFF 시 ID 미수집, 404 자동 POST, 실패 원문 캐시)을 정상 계약으로 검증 | 코드 확인 | [9월] [발송] |
| C2 | 테스트를 실행할 수 없음. 원인은 Windows 자체가 아니라 **Linux(WSL)에서 설치한 `node_modules`를 Windows에서 사용**한 것(rolldown 바인딩은 linux용만 있음) | 코드 확인 | [원인] [보완] |
| C3 | 설계 통합본이 `Docs/README.md`가 아니라 앱 루트 `README_DEV.md`이며 **`.gitignore` 대상**. CLAUDE.md·AGENTS.md의 보호 문서 경로·참조가 실제와 다름 | 코드 확인 | [9월-노트] [보완] |

### 2.3 P2: 구조·운영 개선

| ID | 문제 | 상태 | 출처 |
| --- | --- | --- | --- |
| D1 | poller가 소스를 직렬로 수집하고 같은 tick에서 번역·Discord 발송까지 기다림 | 코드 확인 | [9월] [요약] |
| D2 | `items` 보존 정책 없음. 단순 삭제하면 피드에 남은 항목이 신규로 재판정됨 | 코드 확인 | [보완] |
| D3 | generic 해시(title+link)가 같으면 summary 변경도 저장 안 됨 → DB 본문이 오래된 상태로 남음 | 코드 확인 | [9월] |
| B6 | 번역 파싱 실패·출력 잘림은 fallback 없이 즉시 원문(backend-spec §4.7 기존 계약) | 코드 확인 | [9월] |
| B7 | ModelService `ready`는 키가 있다는 뜻일 뿐 최근 호출 성공을 뜻하지 않음 | 코드 확인 | [9월] |
| B8 | `model_usage`에 disabled/missing-key도 행으로 남아 실제 HTTP 호출 수와 다름. 항목·작업 ID 상관관계 없음 | 코드 확인 | [9월] [번역] |
| F1 | 계층 역방향 의존(`resolve-destinations` → `services/validation.blankToNull`), services·scheduler의 `RepositoryRegistry` 전체 의존 | 코드 확인 | [9월] |

### 2.4 P3: 정리 항목

| ID | 문제 | 출처 |
| --- | --- | --- |
| G1 | `isTlsHandshakeError`가 인증서 오류에도 TLS 1.2 재시도 유발. TLS 1.2 고정을 되돌리는 경로 없음. 영구 리다이렉트를 feedUrl에 반영 안 함 | [보완] |
| G2 | poll 실패 시 backoff·연속 실패 표시·관리자 알림 없음 | [보완] |
| G3 | 목적지 없는 소스가 `next_poll_at` NULL로 due 슬롯 맨 앞을 계속 차지(50개 이상이면 다른 소스 기아) | [보완] |
| G4 | SSE가 `Last-Event-ID`를 처리하지 않음(재연결 시 50건 재전송), 새 이벤트는 15초 주기 | [보완] |
| G5 | `turn10-api`·`turn11-web` 같은 작업 회차 기반 테스트 이름. export-import·source/group service·ssrf-fetch TLS/리다이렉트·셧다운 전용 테스트 공백 | [9월] [보완] |
| G6 | 조사 보고서·재현 스크립트가 git 미추적. 9월 리뷰는 저장소 밖에 있음. AGENTS.md의 "Git 히스토리 없음" 설명이 실제와 다름 | [9월] [보완] |

## 3. 영역별 개선 방향

### 3.1 발송: 항목 × 목적지 연결 모델 (A1~A13)

**목표 동작** [발송 §3] [9월 §4.3]

| 상황 | 동작 |
| --- | --- |
| 새 RSS 소스 첫 수집 | 현재대로 historical 저장, 전송 없음 |
| 새 웹훅/스레드 연결 | 그 연결의 baseline을 따로 확립. 과거 항목 작업을 만들지 않음 |
| 웹훅 A→B 교체 | A의 미실행 작업 취소. B로 복제·이전하지 않음 |
| A 유지 + B 추가 | A는 그대로. B에는 과거 항목의 수정/추가 알림 없음 |
| 기존 글 내용 변경 | 최초 발송 대상이었던 연결 중 현재도 유효한 연결에만 갱신 |
| message ID 미상, PATCH 404 | 수정 불가로 기록. 자동 새 POST 없음 |
| 로그 보존기간 만료 | message ID·마지막 반영 버전·발송 완료 여부 유지 |
| 연결 해제 후 같은 URL 재연결 | 새 연결 세대. 해제 전 대기열이 되살아나지 않음 |
| 최초 POST 결과 불명(timeout·5xx·커밋 실패) | `unknown`으로 분리하고 자동 재POST 중단. 운영자 확인 |

**저장 모델** (명칭은 예시) [발송 §4] [9월 §6]

| 데이터 | 책임 |
| --- | --- |
| `items` | RSS 식별자·정규화 내용·historical. `content_revision` 추가(해시가 바뀔 때마다 증가) |
| `delivery_bindings` 신규 | 설정에서 파생한 연결 세대(`source_id`, `destination_key`, 생성/종료, `baseline_item_id`). 설정 권한은 D24대로 그룹이 가짐 |
| `item_deliveries` 신규 | `(item_id, binding_id)`별 최초 발송, message·channel·thread ID, 마지막 반영 revision |
| `delivery_jobs` 신규 | 목적지·작업 종류·대상 revision·렌더 snapshot·목적지별 재시도 |
| `delivery_log` | 정리 가능한 감사 로그. 실행 판단의 근거로 쓰지 않음 |

**보완 요구사항** (이 모델 설계에 함께 넣는다)
- **발송 순서** (A12): 같은 소스·목적지 안에서는 게시 시각 순서대로 보낸다. 삽입 전에 정렬하거나 due 쿼리를 정렬한다. [보완]
- **목적지별 rate limit 버킷** (A11): `Retry-After`/`X-RateLimit-*`로 그 목적지의 후속 요청을 미룬다. 429는 재시도 횟수에서 빼거나 상한을 따로 둔다. [보완]
- **대량 신규 보류** (A9): 한 poll의 신규 판정이 임계값을 넘으면 `held`로 두고 관리자가 historical 처리 또는 발송을 선택한다. 날짜 없는 항목 규칙은 연결 baseline 논의와 함께 확정한다. [보완]
- **poll 커밋 시 설정 재검증** (A10): 커밋 트랜잭션 안에서 소스를 다시 읽고, `feed_url`이나 설정 버전이 다르면 결과를 버린다. [보완]
- **셧다운 drain** (A3): `Poller.stop()`이 진행 중 tick을 기다리고(상한 시간 포함), HTTP 직전에 종료 플래그를 확인하며, DB는 drain 이후에 닫는다. [보완]
- **Discord 처리**: 최초 발송부터 `wait=true`로 ID를 저장한다. 포럼 스레드의 실제 ID를 보관하고, PATCH에서는 `thread_name`·`applied_tags`를 뺀다. 다른 웹훅으로 옛 message ID를 옮기지 않는다. [발송 §6] [9월]

**신규 연결 baseline** [발송 §3]: 기본안은 새 연결의 첫 성공 스냅샷을 묵음 baseline으로 삼는 것이다(baseline 완료 시점의 `MAX(items.id)` 기록, 그 연결의 첫 poll은 조건부 GET 생략). 이렇게 하면 연결 직후 첫 수집 전까지 나온 진짜 새 글도 묵음이 될 수 있다. **사용자 확정이 필요하다.**

**기존 데이터 이관** [발송 §8]: 앱 정지 → 일관된 백업 → 새 마이그레이션(0021 이후 번호, 기존 파일 수정 금지) 순서로 진행한다.
- historical·완료 항목은 새 작업 대상이 아니다.
- 남은 성공 로그에서 확인할 수 있는 ID·버전만 옮긴다.
- 원래 목적지를 증명할 수 없는 pending/failed는 `legacy_unknown`으로 격리하고 자동 POST를 금지한다.
- 작업 계획과 실행을 함께 전환하기 전에는 기존 발송 경로와 섞어 배포하지 않는다.

**긴급 완화** [발송 §10]: 근본 수정 전에는 새 목적지에 대한 과거 항목 POST를 차단하고 기존 큐를 검토한다. 최종 수정으로 취급하지 않는다.

### 3.2 번역: 설정 경로 → 실패 상태 → 호출 절감 (B1~B8)

1. **설정 경로 단일화** (B1): `.env`를 프로세스 환경 우선으로 한 번 병합하는 로더를 두고, 그 결과를 `loadConfig`·`ModelTranslator`·`ModelService`에 함께 주입한다. 비밀값은 DB·화면 DTO·로그에 넣지 않는다. [9월 §5.1]
2. **실패와 성공 분리** (B2): `translation_status`·`last_error`·`retry_after`를 둔다. 이번 발송에서 원문으로 보내기로 했으면 그 payload를 고정하고, 재번역은 별도로 제어한다. 실패 cooldown이 끝났다고 이미 발송한 과거 항목을 다시 POST하지 않는다. [9월 §5.2] [번역 §5]
3. **Gemini 어댑터** (B3): `abortSignal`을 연결하고 `responseJsonSchema`로 필수 필드를 지정한다. timeout과 명확한 오류를 구분하고 fallback 호출 예산을 둔다. 늦게 온 응답이 최신 revision을 덮어쓰지 않게 한다. signal을 연결해도 이미 시작된 서버 생성 비용이 취소된다는 보장은 없다. [9월 §5.3] [번역 §6]
4. **필요한 필드만 번역** (B4): `minimal`은 제목만 번역한다. 사용자 템플릿은 Handlebars AST로 보수적으로 판정하고, 판정할 수 없으면 제목+본문을 번역한다. 포럼 `thread_name`이 번역 제목을 쓰는 점도 포함한다. [번역 §3]
5. **공유 캐시** (B5): `translation_cache`를 필드별 실제 입력 키로 둔다(`policyVersion`·`targetLang`·`field`·`contextProfile`·`glossaryVersion`·`inputText`). 항목·웹훅·job ID는 키에 넣지 않는다. 같은 항목에서 캐시 미스인 필드는 한 요청으로 묶고, 같은 키의 동시 요청은 single-flight로 합친다. **contentHash를 번역 키로 쓰지 않는다**(generic은 summary 미포함, incident는 title 미포함). 번역 캐시를 재사용했다고 Discord PATCH를 생략해도 된다는 근거는 아니다. [번역 §4] [9월 §5.2]
6. **로컬 처리**: 빈 문자열·확실한 한국어·고정 단계 라벨(`stageLabel`)은 로컬에서 처리한다. 불확실하면 번역한다. [번역 §5]
7. **관측** (B7, B8): 키 존재와 최근 호출 결과를 분리해 표시한다. 실제 요청·캐시 hit·로컬 skip·fallback·잘림·토큰을 따로 집계하고, 항목·job ID와 상관관계를 둔다. Discord로 보내지 않는 번역 진단 기능을 둔다. [9월] [번역 §8]
8. **후순위**: 뉴스 본문 발췌·짧은 동기 묶음 번역은 품질 비교 후에 도입한다. 비동기 Batch API(표준 비용의 50%, 24시간 목표)는 장애 공지 기본 경로에 쓰지 않는다. context caching과 thinking 조정은 실험 항목이다. 파싱 실패 시 fallback 정책(B6)은 계약 변경으로 따로 다룬다. [번역 §7] [9월]

번역은 원문 입력 키별 공유 작업이고, 발송은 항목 × 목적지 × 연결 세대별 작업이다. **목적지별 job으로 바꿔도 번역을 웹훅마다 반복하지 않는다.** [번역 §8]

### 3.3 수집 (A4, D1, G1~G3)

- **즉시**: 본문 읽기까지 타임아웃을 유지하고(또는 Agent `bodyTimeout` 지정), 스트림을 읽다가 최대 바이트를 넘으면 중단한다. [보완]
- **구조**: 수집과 발송의 실행 흐름을 분리하고, 동시 처리 수를 제한한다. 1 OCPU에서는 실측(지연·CPU·메모리·큐 적체)으로 동시성을 조정한다. 다중 프로세스로 갈 때는 메모리 Set 대신 DB claim/lease를 쓴다. [9월 §6] [요약 §4]
- **정리**: TLS 오류 분류 정밀화, TLS 1.2 고정 재검증, 영구 리다이렉트 반영, 실패 backoff와 연속 실패 표시, 목적지 없는 소스의 `next_poll_at` 갱신. [보완]
- Go 워커 분리는 실제 CPU/메모리 병목이 남을 때만 검토한다. 이식할 때는 정규화·contentHash가 완전히 호환되는지 검증해야 한다. 출력이 조금만 달라도 과거 항목이 대량으로 변경 판정된다. [요약 §4]

### 3.4 데이터 (D2, D3)

새 테이블·마이그레이션은 모두 현재 SQLite(better-sqlite3, 동기 트랜잭션)에 맞춰 설계한다. [요약 §5] [발송]

- **items 보존**: 피드에서 사라진 지 N일이 지난 항목만 정리하거나, 식별자·해시만 남기는 tombstone으로 줄인다. [보완]
- **generic 본문 갱신** (D3): 해시가 같아도 표시 필드는 갱신하되, 변경 판정과 재큐에는 영향을 주지 않게 한다. [9월]

### 3.5 코드 구조 (F1)

기존 계층은 유지하고, 상태와 정책만 분리한다. [9월 §6] [발송 §7]

```text
src/server/
├── runtime/environment.ts            # 공통 환경 로드 (B1)
├── domain/delivery/                  # 대상 판정·revision·상태 전이 (순수)
├── services/delivery-binding.service.ts
├── workers/delivery-worker.ts        # 영속 job 조회·실행
├── dispatcher/discord-client.ts      # POST/PATCH·응답 분류
├── translator/translation-cache.service.ts
└── db/{delivery-binding,item-delivery,delivery-job,translation-cache}.repository.ts
```

`blankToNull` 역방향 의존을 정리하고, 필요한 repository 인터페이스만 주입하도록 점진적으로 좁힌다. **파일 이동과 정책 변경을 한 번에 묶지 않는다.** [9월 §9]

### 3.6 문서·테스트·작업 환경 (C1~C3, G5, G6)

- **테스트 환경**: Linux로 설치한 `node_modules`는 WSL에서만 쓴다. Windows에서 실행하려면 OS별로 따로 설치한다. 개편 착수 전에 전체 Vitest 통과를 다시 확인한다(9월에는 Node 22에서 22파일·164테스트 통과). [9월 §8] [보완]
- **테스트 계약**: 정책을 확정한 뒤 문제 동작을 기대하는 기존 테스트를 새 계약으로 바꾼다. 기존 테스트 통과만으로 완료를 판단하지 않는다. [9월] [발송 §9]
- **설계 문서**: `README_DEV.md`(설계 통합본)의 추적 방식을 결정한다(비공개 저장소 추적 등). CLAUDE.md·AGENTS.md의 보호 경로, `stage2-normalize.md` 참조, "스캐폴딩 단계"·"Git 히스토리 없음" 설명, 스펙 안의 옛 README 섹션 참조를 정정한다. [9월-노트] [보완]
- **기록**: 보고서·재현 스크립트를 커밋하고, 9월 리뷰를 저장소 안 `Docs/Report/`로 옮긴다. [보완]

## 4. 사용자 결정이 필요한 사항

| ID | 결정 | 선택지 | 관련 |
| --- | --- | --- | --- |
| Q1 | 발송 정책 표현 | ① 소스 정책 `new_only`/`edit_existing` 신설 [9월] ② `editInPlace` 유지 + 내부 작업 종류 분리, `new_only`는 나중 UX [발송] | A1~A8 |
| Q2 | 새 연결 baseline | 첫 스냅샷 묵음(안전, 연결 직후 새 글 유실 가능) vs 날짜 기준 발송(날짜 없는 과거 글 구분 불가) | A1, A9 |
| Q3 | 이관 시 미확정 작업 | `legacy_unknown` 격리(오발송 방지, 진행 중 장애 갱신 일부 중단) vs 확인 가능한 목적지만 채택 | 3.1 이관 |
| Q4 | 최초 POST 결과 불명 처리 | `unknown`으로 멈춤(중복 방지, 운영자 확인 필요) vs 자동 재시도(누락 방지, 중복 가능) | A13 |
| Q5 | 대량 신규 임계값 | 건수·비율 기준과 보류 후 처리 UI | A9 |
| Q6 | 번역 파싱 실패 정책 | 즉시 원문(현행 §4.7) vs fallback 경유 | B6 |
| Q7 | 설계 통합본 관리 | `README_DEV.md` 추적 여부와 위치, 보호 목록 갱신 | C3 |

## 5. 통합 구현 순서

| 단계 | 내용 | 스키마 변경 | 완료 기준 |
| --- | --- | --- | --- |
| **0. 준비** | 테스트 환경 확정(C2). 운영 DB 사본으로 사건 당시 pending·해시 변경·delivery_log 대조. A1·A2·A3·A9 중 어느 경로였는지 확인 | 없음 | 전체 Vitest 통과, 사건 원인 후보 정리 |
| **1. 즉시 수정** | `.env` 키 전달(B1), 셧다운 drain(A3), 피드 본문 타임아웃·크기 상한(A4) | 없음 | 각 결함의 회귀 테스트 추가·통과 |
| **2. 긴급 완화** | 새 목적지 과거 POST 차단, 대량 신규 보류(A9), poll 커밋 시 설정 재검증(A10), 기존 큐 검토 | 최소 | 재현 스크립트의 A1·A2 시나리오에서 새 목적지 POST 0 |
| **3. 계약 확정** | Q1~Q6 결정. 보호 스펙 변경안을 파일·항목 단위로 승인(7장) | 없음 | 승인된 스펙 |
| **4. 발송 모델** | binding·item_delivery·job 테이블과 보수적 이관. source/group/import의 연결 갱신. poller는 job 계획만 하고 dispatcher는 job 기준으로 실행. 순서 보장(A12)·목적지별 rate limit(A11)·unknown(A13) 포함. **계획과 실행을 한 번에 전환** | 있음(0021~) | 6장 발송 테스트 통과, 운영 DB 사본 이관 시 소급 발송 0 |
| **5. 번역** | 실패 상태 분리(B2), Gemini signal·schema(B3), 필드 선택(B4), 공유 캐시·single-flight(B5), 관측 지표(B7·B8) | 있음 | 6장 번역 테스트 통과 |
| **6. 구조·수집** | 수집·발송 흐름 분리와 제한된 동시성, 책임 분리(F1), 수집 정리(G1~G3), items 보존(D2), generic 본문 갱신(D3) | 일부 | 발송 지연·큐 적체·CPU/메모리 측정 |
| **상시** | 문서 정비(C3), 보고서 커밋(G6), 테스트 이름 정리(G5) | 없음 | — |

1·2단계는 독립적인 작은 변경이다. 4·5단계는 서로 의존하므로(번역 결과를 job snapshot에 보관, revision 조건) 4단계 설계 때 5단계의 인터페이스를 함께 정한다.

## 6. 통합 회귀 테스트

**발송** [9월 §7] [발송 §9] [보완]
- 새 소스 첫 수집은 전부 historical이고 POST 0
- A→B 교체 후 과거 글 변경 시 B에 POST 0. 연결 이후 신규 항목은 B에 initial_post 정확히 1개
- A 유지 + B 추가 시 과거 글 변경은 A에만 갱신, B에 POST 0
- 기존 pending·부분 성공 중 연결이 바뀌어도 새 연결로 복제 0, 원래 실패 대상만 재시도
- 같은 웹훅에서 threadId만 변경, A→B→A, 같은 목적지를 가리키는 중복 그룹: 큐 부활 0, 중복 발송 0
- 로그 정리 후 글 변경: 영속 ID로 PATCH, 새 POST 0
- 내용 H1→H2→H1: 반영 revision 1→2→3, 마지막 수정 누락 0
- message ID 미상·PATCH 404: 자동 POST 0, 사유 기록
- 한 목적지 성공 + 다른 목적지 최종 실패: 독립 재시도
- 번역·HTTP 도중 내용·연결 변경: 옛 응답이 최신 상태를 덮어쓰지 않음
- import overwrite·그룹 삭제·웹훅 해제, 비활성화/재활성화, 수동 실패 재시도: 같은 규칙 적용
- 최초 POST 결과 불명·완료 직전 재시작: unknown, 무조건 재POST하지 않음
- 셧다운 중 진행 중인 발송: drain 후 기록 완료, 재시작 후 재POST 0
- guid 체계 변경으로 대량 신규 발생: 자동 발송 0, 보류 상태
- poll 중 feedUrl 변경: 옛 피드 항목 발송 0, 새 URL baseline 수행
- 한 poll의 신규 3건: 게시 시각 순서대로 발송
- 같은 웹훅 429: 그 목적지의 후속 요청 지연, rate limit만으로 failed 0
- 구버전 DB 이관: historical·완료 건 재큐 0, 대상 미상 pending 격리

**번역** [9월 §7] [번역 §9]
- `.env`만 있을 때 번역기와 ModelService가 같은 키를 인식, 프로세스 환경이 우선
- 같은 항목 재시도 시 추가 호출 0. 다른 항목의 같은 입력은 1회만 호출. 같은 키의 동시 요청 1회
- 제목은 그대로이고 본문만 바뀌면 제목 캐시 재사용. `minimal`은 본문을 보내지 않음
- 실패 cooldown과 성공 캐시를 구분하고, 키 복구 후 허용된 재번역. 번역 복구가 과거 항목 새 POST를 만들지 않음
- Gemini SDK 경계: schema·signal 전달, 빈 응답, JSON 오류, MAX_TOKENS, 429, timeout
- 오래된 응답이 최신 revision을 덮어쓰지 않음. 묶음 일부 실패 시 성공분은 다시 호출하지 않음. 취소된 job은 번역 0회

**수집·데이터** [보완]
- 본문을 느리게 흘리는 피드: 제한 시간 안에 중단되고 다른 소스 처리는 계속됨
- 최대 크기 초과 응답: 중단하고 오류 기록
- 새 마이그레이션: idempotency와 기대 스키마(CLAUDE.md 규칙)

## 7. 보호 문서 변경 제안 (미수정)

| 파일 | 항목 | 내용 | 출처 |
| --- | --- | --- | --- |
| `Docs/Architecture/backend-spec.md` | §4.2 | 항목 상태와 목적지별 발송 상태·작업·감사 로그의 역할, 새 repository, 마이그레이션·backfill 계약, translation cache | [발송] [번역] |
| 〃 | §4.4 #6~8 | 연결 baseline, 신규/갱신 작업 분리, 항목 전체 requeue 제거, 대량 신규 보류, poll 커밋 시 설정 재검증, 발송 순서 | [발송] [보완] |
| 〃 | §4.6 | 작업 대상 고정, 원래 목적지에만 갱신, 목적지별 재시도·rate limit, 영속 message/thread ID, PATCH 404·unknown 처리, 429 재시도 정책 | [9월] [발송] [보완] |
| 〃 | §4.7 | 필드 선택, 공유 캐시, 실패 상태, timeout·fallback 예산, revision 조건, 파싱 실패 정책 | [9월] [번역] |
| 〃 | §4.9·§4.11·API | 그룹/소스/import의 연결 변경, 기존 실패 작업만 재시도, D24 유지, `retry-failed` 건수 의미 | [발송] |
| 〃 | Fetch·runtime | 본문 타임아웃·크기 상한, 셧다운 drain, 환경 로더 단일화, items 보존 | [9월] [보완] |
| `Docs/Architecture/frontend-spec.md` | §4.3·§4.4 | 첫 연결 baseline 안내, 수정 토글의 실제 의미, 실패 재시도·unknown·수정 불가 표시, 보류된 대량 신규 검토, poll 연속 실패 표시 | [9월-노트] [발송] [보완] |
| 〃 | 모델 화면 | 키 존재와 최근 호출 성공 구분, 사용량(요청·캐시 hit·skip·fallback) 표시 | [9월-노트] [번역] |
| `README_DEV.md`(설계 통합본) | 위치·추적 | 보호 목록 반영 여부와 저장소 추적 방식 | [보완] |
| CLAUDE.md·AGENTS.md | 보호 목록·참조 | 실제 경로로 정정, 현재 단계 설명 갱신 | [9월-노트] [보완] |

CLAUDE.md 규칙에 따라 위 문서는 **파일·항목 단위의 명시 승인** 없이 수정하지 않는다. 이 통합 보고서 작성은 보호 문서 편집 승인이 아니다.

## 8. 검증 상태와 한계

| 출처 | 수행한 검증 | 하지 않은 것 |
| --- | --- | --- |
| [9월] | Node 22에서 `npm run typecheck` 통과, `npm test` 22파일·164테스트 통과. 메모리 SQLite + 모의 POST/PATCH 진단. `.env` 키 미인식 확인(값은 출력하지 않음) | 실제 Gemini·Discord 호출, 운영 DB·운영 환경 확인 |
| [원인] [발송] | 현재 source + 메모리 SQLite(Node 내장) + 모의 HTTP로 9개 시나리오 assertion 통과. 서버·테스트 typecheck 통과 | 기존 Vitest(네이티브 의존성), 제안 모델 구현, 실제 better-sqlite3 통합 테스트 |
| [번역] | 모의 번역기·모의 SDK HTTP로 6개 시나리오 assertion 통과 | 실제 API 과금 호출, 번역 품질, 절감률 측정 |
| [요약] | 공식 문서 확인(2026-10-16) | 실제 서버 부하 측정 |
| [보완] | 코드 정적 확인 | A3·A9·A10의 실행 재현(이번 셸에 Node 없음) |

공통 한계:
- 실제 운영에서 과거 항목 전체가 발송된 사건의 원인은 **확정되지 않았다**(0단계 필요).
- 줄 번호·파일 경로는 2026-10-16 작업 트리 기준이다.
- 이 통합 문서는 출처 문서를 요약했다. 상세 설계·재현 절차는 각 출처 문서를 따른다.

## 부록: 이 문서에서 제외한 배포·인프라 항목

기능·성능 수정 지시에서 빼기로 한 항목이다. 별도의 배포 작업에서 다룬다.

| 항목 | 내용 | 출처 |
| --- | --- | --- |
| Node 런타임 | Node 24 LTS 권장(Node 20 EOL). DEPLOY.md 설치 안내, `engines >=20`, `@types/node` 갱신 | [요약 §4] [보완 1.7] |
| ARM64 빌드 | OCI Ampere(ARM64)에서 better-sqlite3 네이티브 빌드 확인 | [보완 1.7] |
| 배포 문서 | DEPLOY.md의 systemd 파일 경로(`deploy/` → 실제 `Docs/Deploy/`), systemd `TimeoutStopSec`(셧다운 drain 시간 확보) | [보완 1.7, 2.1] |
| Docker | `default.env.example`의 Docker 안내(포트 매핑 + 내부 loopback)는 동작하지 않음. production loopback 제약과 컨테이너 네트워크 방식(`network_mode: host` 등), 비밀값 주입 방식 | [보완 1.7] |
| PostgreSQL 전환 | Docker Compose PostgreSQL, ARM64 이미지, 볼륨, `127.0.0.1:5432`, 연결 풀, 이관. 발송 모델 수정 이후 다중 워커가 필요할 때 판단 | [요약 §5] [보완 1.6] |
| SQLite 운영 백업 | 정기 백업과 복원 검증 | [보완 1.6] |
| 외부 접근 | Cloudflare Access + Tunnel(공개 origin, JWT 검증, 프록시 신뢰 범위, Access 뒤 rate limit 키, htmx·SSE 세션 만료), 대안 OAuth2 Proxy·Tailscale | [Access] [보완 1.7] |
| 결정 사항 | DB 전환 시점, 외부 접근 방식 | [요약 §7] |
