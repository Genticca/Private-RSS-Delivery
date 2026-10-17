# 개편 검토 보완: 누락 항목과 추가 발견

작성일: 2026-10-16 (Asia/Seoul) · 작성: Claude

이 문서는 [프로젝트 개편 요약](2026-10-16-reorganization-summary.md)과 그 상세 문서, 2026-09-07 루트 `PROJECT_STRUCTURE_REVIEW.md`를 읽고 현재 코드와 대조한 결과다. 기존 문서가 **빠뜨린 항목**(1장)과 기존 문서 범위 밖에서 **새로 찾은 문제**(2장)를 기록한다. 구현 완료 보고서나 보호 설계 문서를 대체하는 계약이 아니다.

애플리케이션 코드·테스트·마이그레이션·보호 설계 문서는 수정하지 않았다. 이 문서 1개만 추가했다.

## 0. 요약

| 우선순위 | 항목 | 구분 | 장 |
| --- | --- | --- | --- |
| P0 | `.env` API 키가 번역기/ModelService에 전달되지 않음 (9/7 P0, 10/16 요약에서 누락, 코드 미수정) | 누락 | 1.1 |
| P0 | 셧다운 시 진행 중 발송이 DB 종료와 경합 → Discord 성공 후 기록 유실 → 재시작 후 중복 발송 | 신규 | 2.1 |
| P0 | 피드 본문 읽기에 앱 타임아웃·크기 상한 없음 → 직렬 tick 전체 정지 가능 | 신규 | 2.2 |
| P1 | 한 poll에 대량 "신규" 판정 시 차단 장치 없음 (atom_id 체계 변경·날짜 없는 항목) | 신규 | 2.3 |
| P1 | 진행 중 poll과 feedUrl 변경 경합 → 옛 피드 항목이 신규로 발송, 새 URL baseline 생략 | 신규 | 2.4 |
| P1 | 한 poll의 여러 신규 항목이 최신 글부터 발송됨 (역순) | 신규 | 2.5 |
| P1 | 같은 웹훅에 429가 나도 같은 tick에서 계속 요청, 429도 재시도 횟수 소진 → 알림 유실 | 신규 | 2.6 |
| P1 | 설계 통합본이 `README_DEV.md`로 이름이 바뀌어 **gitignore 대상**. 보호 문서 경로가 실제와 불일치 | 누락 | 1.2 |
| P1 | 테스트 실행 불가 원인은 Windows 문제가 아니라 **Linux에서 설치한 node_modules 공유** | 누락·정정 | 1.3 |
| P2 | items 테이블 보존 정책 없음 (단순 삭제 시 재전송 위험) | 신규 | 2.7 |
| P2 | 발송 정책 권고가 9/7과 10/16 문서 사이에 엇갈림 | 누락 | 1.4 |
| P2 | 기타 운영·배포·UI 항목 | 누락·신규 | 1.5~1.7, 2.8 |

## 1. 기존 개편 문서에서 빠진 항목

### 1.1 `.env` 키 미전달 버그 (P0, 미수정)

9/7 리뷰 §5.1의 P0였으나 10/16 요약과 구현 순서에 없다. 현재 코드에도 그대로 남아 있다.

- `config.ts:21-36` `loadConfig()`는 `.env`를 병합한 `effectiveEnv`를 만들지만 host·port·DB 경로만 반환한다.
- `runtime/container.ts:120`, `:151`은 번역기와 ModelService에 원래 `options.env`(일반 시작 시 `undefined`)를 넘긴다. `translator/keys.ts:13`은 그 결과 `process.env`만 본다.
- `.env`에만 키가 있으면 `missing-key` → 원문 발송. systemd `EnvironmentFile`이 키를 주입하는 운영 환경에서는 드러나지 않지만 `npm start`·`npm run dev`에서는 재현된다.

데이터 이관 없이 고칠 수 있는 가장 작은 수정이다. 10/16 구현 순서 **0단계**로 추가할 것을 제안한다. 번역 절감안 §5의 실패 캐시 분리보다 먼저 해야 실패 원문 캐시가 더 쌓이지 않는다.

### 1.2 설계 통합본의 위치와 보호 규칙 (P1)

- CLAUDE.md·AGENTS.md는 `Docs/README.md`, `Docs/backend-spec.md`, `Docs/frontend-spec.md`를 보호 문서로 지정한다. 실제 경로는 `Docs/Architecture/backend-spec.md`, `Docs/Architecture/frontend-spec.md`다.
- 9/7·10/16 문서는 `Docs/README.md`를 "찾을 수 없다"고 기록했다. 실제로는 앱 루트 **`README_DEV.md`**(115KB, "rss-discord-bridge 설계 통합 문서", §0~§16)로 존재한다.
- 이 파일은 `.gitignore`의 "설계 전체본 — 로컬 전용, Push 제외" 규칙으로 **버전 관리 밖**에 있다. 설계의 단일 진실원이 이 PC에만 있으며 백업·이력·리뷰 대상이 아니다.
- 보호 목록의 경로가 틀려 있어 실제 스펙 파일에 보호 규칙이 적용된다는 사실이 문서상 불명확하다.
- CLAUDE.md의 "아직 스캐폴딩 단계" 설명, 픽스처 경로 안내 등도 현재 상태와 다르다.

제안: 보호 목록을 실제 경로로 정정하고, 설계 통합본의 보관 방식(비공개 저장소 추적, 공개 제외 등)을 결정한다. CLAUDE.md·AGENTS.md 수정과 보호 문서 지정 변경은 사용자 승인 대상이다.

### 1.3 테스트 실행 환경 (P1, 원인 정정)

10/16 문서들은 "Windows 네이티브 의존성 문제로 Vitest 실행 불가"라고만 기록했다. 확인 결과:

- `node_modules/@rolldown/`에는 `binding-linux-x64-gnu`, `binding-linux-x64-musl`만 있고 win32 바인딩이 없다.
- 즉 이 `node_modules`는 **Linux(WSL 등)에서 설치한 것**이다. better-sqlite3의 `.node`도 같은 이유로 Windows에서 로드되지 않는다.
- 이번 조사 셸(PowerShell)의 PATH에는 `node` 자체가 없다.

DEPLOY.md가 경고하는 "다른 OS의 node_modules 복사 금지"와 같은 문제다. 테스트는 설치한 OS(WSL)에서 실행하거나 OS별로 따로 설치해야 한다. 9/7 리뷰는 Node 22 환경에서 164개 테스트가 통과했다고 기록했다. **구현 순서의 첫 단계로 "테스트 실행 환경 확정"을 둘 것을 제안한다.** 발송 모델 재설계는 기존 테스트 수정을 전제로 하므로 이 환경이 없으면 진행할 수 없다.

### 1.4 엇갈리는 발송 정책 권고 (P2, 결정 필요)

| 문서 | 권고 |
| --- | --- |
| 9/7 리뷰 §4.3 | `new_only`(뉴스 기본) / `edit_existing`(incident) 정책 신설, 명시적 재전송 분리 |
| 10/16 발송 개선안 §4 | `editInPlace` 의미 유지, 작업 종류(`initial_post`/`edit`/`update_post`)로 분리. `new_only`는 별도 UX로 보류 |

10/16 요약은 이 차이를 정리하지 않았다. 보호 스펙 변경안을 만들기 전에 어느 쪽을 따를지 결정해야 한다.

### 1.5 긴급 완화와 운영 데이터 확인 (P1)

- 근본 수정은 신규 테이블 3개와 이관을 동반한다. 그 사이 재발을 막는 임시 차단(새 목적지에 대한 과거 항목 POST 금지, 기존 pending 검토)은 발송 개선안 §10 마지막 문단에만 있고 요약·구현 순서에 없다.
- 모든 보고서가 "로컬 DB가 비어 실제 사건 원인 미확정"으로 끝난다. **운영 DB 사본으로 사건 당시 pending·contentHash 변경·delivery_log를 대조하는 단계**가 구현 순서에 필요하다. 2.1·2.3의 경로도 같은 증상을 만들 수 있어 원인을 하나로 단정하기 어렵다.

### 1.6 PostgreSQL 결정 시점 (P2)

10/16 요약 §7은 DB 전환 결정(2단계) 후 발송 모델 구현(3단계) 순서다. 그러나:

- 같은 문서가 "SQLite로도 구현 가능, 오류 원인은 DB가 아님"이라고 결론지었다.
- PostgreSQL 전환은 better-sqlite3 동기 트랜잭션에 의존하는 repository·service·poller·dispatcher 전체를 비동기로 바꾸는 작업이다. 발송 모델 변경과 겹치면 변경 범위와 회귀 위험이 함께 커진다.
- 단일 프로세스·1 OCPU에서 PostgreSQL의 이점(`SKIP LOCKED` 다중 소비자)은 다중 워커를 도입할 때 생긴다.

제안: **SQLite에서 발송 모델을 먼저 고치고, DB 전환은 다중 워커가 실제로 필요해질 때 별도 프로젝트로 판단한다.** 또한 PostgreSQL 백업 계획만 있고, 그 전까지 쓰는 SQLite의 OCI 백업(`.backup`/`VACUUM INTO` 정기 실행, 복원 검증)은 계획이 없다. 이것도 추가해야 한다. PostgreSQL 전환은 CLAUDE.md의 SQLite·`data/` 제약을 바꾸는 결정이기도 하다.

### 1.7 배포·Access 관련 누락 (P2)

| 항목 | 현재 | 필요 조치 |
| --- | --- | --- |
| Node 버전 | `DEPLOY.md:18` Node 20 설치 안내, `package.json` `engines >=20`, `@types/node ^22` | 요약은 Node 24를 권장하지만 문서·engines·타입 갱신 항목이 없다 |
| systemd 경로 | `DEPLOY.md:81` `deploy/rss-discord-bridge.service` | 실제 파일은 `Docs/Deploy/rss-discord-bridge.service` |
| OCI Ampere | ARM64 | better-sqlite3 ARM64 prebuild/소스 빌드 확인 항목 없음 |
| Docker 안내 | `default.env.example:21` "포트 매핑으로 노출 — 컨테이너 내부 바인딩은 loopback 유지" | 컨테이너 내부 127.0.0.1에는 포트 매핑이 도달하지 않는다. Docker 운영 검토 전에 이 안내를 정정해야 한다 |
| Access 뒤 rate limit | `app.ts:90` IP 기준 분당 120회 | cloudflared 경유 시 모든 요청이 127.0.0.1 하나로 합산. Access 문서는 "확인"만 적었다. keyGenerator 또는 trustProxy 범위 결정 필요 |
| Access 뒤 Host 검증 | `app.ts:39`가 `port`만 전달 | Access 문서에 기록됨(보완 불필요) |

## 2. 기존 문서 범위 밖의 추가 발견

### 2.1 셧다운과 진행 중 발송의 경합 → 중복 발송 (P0)

- `app.ts:70-78` 셧다운은 `poller.stop()` 후 곧바로 `app.close()` → `container.close()`를 호출한다.
- `Poller.stop()`(`scheduler/poller.ts:71-75`)은 interval만 해제하고 **진행 중 tick(`runningTick`)을 기다리지 않는다.**
- `container.close()`(`runtime/container.ts:175-187`)는 곧바로 `db.close()` 한다.
- 진행 중 tick이 번역(최대 15초+fallback)이나 Discord 요청(10초)을 기다리는 동안 DB가 닫히면, Discord POST는 성공했는데 `commitAttempts` 트랜잭션이 실패한다. 항목은 pending으로 남아 **재시작 후 다시 POST된다.**

배포 업데이트(`systemctl restart`)마다 발생할 수 있는 경로다. CLAUDE.md의 "그레이스풀 셧다운은 단일 flight" 의도와도 다르다.

제안:
- `Poller.stop()`이 진행 중 tick의 완료를 기다리게 한다. 상한 시간을 두고, 초과하면 새 HTTP 시작을 막는다.
- dispatcher는 HTTP 직전에 종료 플래그를 확인한다.
- `container.close()`는 워커 drain 이후에 DB를 닫는다.
- systemd `TimeoutStopSec`을 그보다 길게 둔다.

발송 개선안의 `unknown` 상태 설계와 함께 다루면 좋다.

### 2.2 피드 본문 읽기의 타임아웃·크기 상한 부재 (P0)

- `security/ssrf-fetch.ts:82-140`의 abort 타이머는 `finally`에서 **헤더 수신 직후 해제**된다. 본문 읽기(`:170` `response.arrayBuffer()`)는 앱 타임아웃 밖이다.
- `security/agent-cache.ts:47-51` Agent는 `bodyTimeout`·`headersTimeout`을 지정하지 않아 undici 기본값(각 300초)을 쓴다.
- 본문 크기 상한이 없다. 응답 전체를 메모리로 읽는다.
- poller는 소스를 직렬로 처리하고(`poller.ts:148-150`), `runningTick` 가드 때문에 tick이 끝날 때까지 다음 tick이 실행되지 않는다. 본문을 느리게 흘리는 피드 하나가 **모든 소스의 수집과 모든 발송**을 최대 5분씩 멈춘다. 반복되면 사실상 정지 상태가 된다.

제안: 타이머를 본문 읽기 완료까지 유지(또는 Agent `bodyTimeout` 지정)한다. 스트림으로 읽으며 최대 바이트(예: 5~10MB)를 넘으면 중단한다. 10/16 요약 §4의 "수집·발송 분리"와 별개로 **지금 구조에서도 필요한 방어**다.

같은 파일의 부수 항목(P3):
- `isTlsHandshakeError`(`:261-265`)가 `certificate`를 포함한다. 만료·자체서명 인증서 오류도 TLS 1.2 재시도를 유발한다. 재시도는 실패하므로 기능 문제는 없으나 오류 분류가 흐려진다.
- 403 재시도가 성공하면 `tlsMaxVersion: 'TLSv1.2'`를 영구 저장하며 되돌리는 경로가 없다.
- 301/308 영구 리다이렉트가 `feedUrl`에 반영되지 않아 매번 리다이렉트를 거친다.

### 2.3 대량 신규 판정 차단 장치 없음 (P1)

`scheduler/cutoff.ts:6`은 `publishedAt`이 없는 신규 항목을 무조건 발송 대상으로 둔다. 아래 경우 초기화된 소스에서도 **과거 항목이 한꺼번에 신규로 판정**된다.

- 피드가 `<guid>`/`<id>` 체계를 바꿈. 예: http→https, 추적 파라미터 추가, CMS 이전. 모든 항목의 `atom_id`가 바뀌고, 날짜 없는 항목이나 cutoff 이후의 항목은 재발송된다.
- 날짜가 없는 피드가 과거 글을 다시 노출함.
- CDN 오류 페이지나 다른 피드가 200으로 응답해 파싱에 성공함.

웹훅 교체 문제와 별개로 "과거 이벤트 재전송" 증상을 만드는 경로다. 운영 사건의 원인 후보에도 포함해야 한다(1.5).

제안: 초기화된 소스에서 한 poll의 신규 판정 수가 임계값(예: 5건 또는 피드 항목의 50%)을 넘으면 자동 발송을 보류한다. 해당 항목을 `held`/검토 상태로 두고 로그·UI에 표시하며, 관리자가 "모두 historical 처리" 또는 "발송"을 선택하게 한다. 날짜 없는 항목의 처리 규칙은 발송 개선안 §3 baseline 논의와 함께 확정한다.

### 2.4 진행 중 poll과 설정 변경의 경합 (P1)

- poller는 poll 시작 시점의 `source` 레코드(`poller.ts:111` `claimed`)로 끝까지 판정한다(`shouldQueueNewItem`, `markPolled`).
- 그 사이 관리자가 feedUrl을 바꾸면 `source.service.ts:110-138`이 items 삭제, `initialized=false`, 새 cutoff를 커밋한다.
- 이후 poll이 끝나면 **옛 URL의 항목을 옛 `initialized=true` 기준으로 신규 삽입**한다. 날짜 없는 항목과 옛 cutoff 이후 항목이 pending이 된다. 이어서 `markPolled(... initialized: true)`가 새 URL의 baseline poll을 건너뛰게 만든다.

fetch 타임아웃(15초)이나 2.2의 본문 지연 동안 편집하면 재현될 수 있다. 소스 삭제·비활성화·그룹 변경과의 경합도 같은 구조다.

제안: poll 커밋 트랜잭션 안에서 소스를 다시 읽는다. `feed_url`·설정 버전(예: `config_revision`)이 시작 시점과 다르면 결과를 버리고 fetch_log만 남긴다.

### 2.5 신규 항목 발송 순서 역전 (P1)

- poller는 피드 순서대로 삽입한다(`poller.ts:215`). RSS/Atom은 보통 최신 글이 먼저다. 정렬 로직은 없다(`domain/` 전체에 sort 없음).
- 같은 poll의 신규 항목은 모두 `next_attempt_at = now`이다. 그래서 `findDueDeliveries`의 `ORDER BY next_attempt_at, id`(`db/item.repository.ts:151`)는 **최신 글부터** 발송한다.
- 재시도가 섞이면 `next_attempt_at`이 밀린 항목이 뒤로 가서 순서가 더 흐트러진다. incident 소스에서는 "해결" 알림이 "조사 중"보다 먼저 보일 수 있다.

제안: 삽입 전 `publishedAt` 오름차순(날짜 없으면 피드 역순)으로 정렬하거나, due 쿼리를 소스별 게시 시각 순서로 정렬한다. 목적지별 job으로 전환할 때 "같은 소스·목적지 내 순서 보장"을 설계 항목에 넣는다.

### 2.6 Discord 429 처리와 알림 유실 (P1)

- dispatcher는 due 항목을 직렬 처리하는데(`dispatcher/webhook.ts:85-87`), 한 항목이 429를 받아도 **같은 tick의 다음 항목은 같은 웹훅으로 곧바로 요청한다.** 웹훅별 대기 상태가 없다.
- 429도 `transient_failed`로 `incrementAttempt` 대상이다(`:356-361`, `MAX_ATTEMPTS = 5`). 버스트 상황(2.3, 대량 초기 발송)에서는 rate limit만으로 5회를 소진해 `failed(max_retries)`가 되어 **알림이 유실**된다.
- 반복된 429/4xx는 Discord(Cloudflare)의 잘못된 요청 한도에 걸려 IP 단위 차단으로 번질 수 있다.
- 10/16 요약 §4의 "제한된 동시 처리"를 도입하면 이 문제는 더 커진다.

제안: 웹훅(목적지)별 rate limit 상태를 두고 `Retry-After`/`X-RateLimit-*` 헤더를 기준으로 그 목적지의 후속 요청을 미룬다. 429는 재시도 횟수에서 제외하거나 별도 상한을 둔다. 목적지별 job 설계(발송 개선안 §5)에 "목적지별 rate limit 버킷"을 명시한다.

### 2.7 items 보존 정책 부재 (P2)

- `workers/cleanup-worker.ts:46-50`은 delivery_log·fetch_log·model_usage만 90일 정리한다. `items`(summary 최대 4,000자)는 소스 삭제·URL 변경 때만 지워진다.
- CVE·뉴스처럼 항목이 많은 피드는 DB가 계속 커진다.
- 그러나 **단순 삭제는 위험하다.** 아직 피드에 남아 있는 항목을 지우면 다음 poll에서 신규로 판정되어 재발송된다(2.3과 같은 경로).

제안: "피드에서 사라진 지 N일이 지난 항목"만 정리하거나, `(source_id, atom_id)`·해시만 남기는 tombstone으로 축소한다. 발송 개선안의 `item_deliveries` 영속 상태와 보존 기간도 함께 정한다.

### 2.8 기타 (P3)

| 항목 | 위치 | 내용 |
| --- | --- | --- |
| 목적지 없는 소스의 슬롯 점유 | `poller.ts:101-103`, `db/source.repository.ts:179` | 목적지가 없어 skip된 소스는 `next_poll_at`이 갱신되지 않는다. NULL이 정렬 맨 앞이므로 그런 소스가 `dueLimit`(50) 이상이면 다른 소스가 굶는다. 그 소스는 fetch_log도 남지 않아 UI에서 상태가 보이지 않는다 |
| poll 실패 backoff·알림 없음 | `poller.ts:270-288` | 실패해도 정상 주기로 계속 재시도한다. 연속 실패 횟수·관리자 알림이 없어 피드가 며칠씩 깨져도 알기 어렵다 |
| 셧다운 시 강제 종료 | `app.ts:77` | `process.exit(0)` 직전 drain이 없다(2.1과 함께 처리) |
| SSE 재연결 | `controllers/api/logs.ts:51-55` | `Last-Event-ID`를 처리하지 않아 재연결 때마다 50건을 다시 보낸다. delivery/fetch가 같은 `id` 필드를 공유해 구분할 수 없다. 새 이벤트는 15초 polling 주기로만 전달된다. Access 도입 시 연결 상한 5개와 함께 검토 |
| generic 본문 갱신 누락 | 9/7 리뷰 §4.1 | 해시(title+link)가 같으면 summary 변경도 저장하지 않는다. 번역 공유 캐시 키를 summary 원문으로 잡을 때 DB 값이 오래될 수 있다. 10/16 문서에서 빠졌다 |
| 구조 정리 항목 | 9/7 리뷰 §6·§7 | `blankToNull` 역방향 의존, `RepositoryRegistry` 전체 의존, `turn10-api`·`turn11-web` 회차 기반 테스트 이름. 10/16 문서에서 빠졌다 |
| 테스트 공백 | `test/` | `export-import.service`, `source.service`, `group.service`, `ssrf-fetch`의 TLS 재시도·리다이렉트, 셧다운 경로의 전용 테스트가 없다(API 통합 테스트에서 일부만 다룬다) |
| 보고서 미추적 | `Docs/Report/`, 루트 `PROJECT_STRUCTURE_REVIEW.md` | 10/16 보고서와 재현 스크립트는 git 미추적이다. 9/7 리뷰는 저장소 밖에 있다 |

## 3. 구현 순서 보완 제안

10/16 요약 §7 앞뒤에 다음을 넣는 것을 제안한다.

0. **테스트 실행 환경 확정**(1.3)과 **운영 DB 사본 확보·사건 대조**(1.5).
1. **즉시 수정 가능한 결함**: `.env` 키 전달(1.1), 셧다운 drain(2.1), 피드 본문 타임아웃·크기 상한(2.2). 스키마 변경 없이 회귀 테스트로 고정할 수 있다.
2. **긴급 완화**: 새 목적지 과거 POST 차단(1.5), 대량 신규 판정 보류(2.3), poll-설정 경합 검사(2.4).
3. 이후 10/16 요약 §7의 1~7단계. 다만 DB 전환 결정은 발송 모델 이후로 미루고(1.6), 목적지별 job 설계에 발송 순서(2.5)·목적지별 rate limit(2.6)·items 보존(2.7)을 포함한다.

## 4. 보호 문서 관련 제안 (미수정)

- CLAUDE.md·AGENTS.md: 보호 문서 목록과 설계 통합본(`README_DEV.md`) 경로·추적 방식 정정(1.2).
- `Docs/Architecture/backend-spec.md`: §4.4 대량 신규 보류·poll 커밋 시 설정 재검증(2.3, 2.4), Fetch 계층 본문 타임아웃·크기 상한(2.2), §4.6 발송 순서·목적지별 rate limit·429 재시도 정책(2.5, 2.6), 런타임 셧다운 drain(2.1), items 보존(2.7).
- `Docs/Architecture/frontend-spec.md`: 보류된 대량 신규 항목 검토 UI(2.3), poll 연속 실패 표시(2.8).

위 문서는 파일·항목 단위의 명시 승인 없이 수정하지 않는다. 이 보고서 작성은 보호 문서 편집 승인이 아니다.

## 5. 검증 범위와 한계

- 코드 정적 확인만 수행했다. 위 경로(2.1~2.6)는 코드 흐름으로 판단했으며 **재현 스크립트나 테스트로 실행 확인하지 않았다.** 1.3의 환경 문제로 이번 셸에서 Node·Vitest를 실행할 수 없었다.
- 줄 번호는 2026-10-16 작업 트리 기준이다.
- 외부 피드·Discord·번역 API 호출, 운영 DB 조회는 하지 않았다.
