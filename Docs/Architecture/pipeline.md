# 수집 → 발송 파이프라인과 오류 처리

> 검증 커밋 `6e53b7f` · 작성 2026-10-16 · 현재 동작 설명 문서(보호 대상 아님). 상태 값의 정의는 [DB 스키마 계약 §5](../Contracts/db-schema.md#5-상태-값)를 따른다.

수집(PollService)과 발송(DeliveryService)은 서로 다른 워커에서 돌고, DB의 `delivery_jobs`로만 연결된다.

## 1. 수집: 피드 → 항목 저장 → 작업 계획

코드: `workers/poll-worker.ts`, `services/poll.service.ts`, `security/ssrf-fetch.ts`, `domain/*`, `services/delivery-plan.service.ts`

```mermaid
flowchart TD
  A["tick: 수집할 소스 조회<br/>enabled · next_poll_at 경과 · 최대 50개"] --> B{"종료 중이거나<br/>이미 수집 중?"}
  B -->|예| Z0[건너뜀]
  B -->|아니오| C["연결 세대 갱신 reconcile"]
  C --> D{"소스 비활성?"}
  D -->|예| Z0
  D -->|아니오| E{"목적지 있음?"}
  E -->|없음| Z1["markPolled 후 건너뜀"]
  E -->|있음| F{"baseline이 필요한<br/>새 연결 있음?"}
  F -->|예| G["조건부 GET 생략"]
  F -->|아니오| H["조건부 GET<br/>etag · last-modified"]
  G --> I[fetchFeed]
  H --> I
  I --> I1{"SSRF 검사"}
  I1 -->|차단| ERR
  I1 -->|통과| I2{"응답"}
  I2 -->|"403 · TLS 핸드셰이크 실패"| I3["TLS 1.2로 1회 재시도<br/>성공하면 고정, 하루 뒤 재검사"]
  I3 --> I2
  I2 -->|"3xx, 최대 3회"| I4["대상도 SSRF 검사<br/>301·308이면 feedUrl 갱신"]
  I4 --> I2
  I2 -->|"15초 초과(본문 포함) · 5MiB 초과 · 4xx · 5xx"| ERR
  I2 -->|304| N304["markPolled · 연속 실패 0<br/>fetch_log 304"]
  I2 -->|200| TX{"트랜잭션:<br/>설정 버전이 그대로이고 활성?"}
  TX -->|"바뀜 · 비활성"| Z2["결과 폐기<br/>다음 poll에서 다시 수집"]
  TX -->|그대로| P1["Stage 1 파싱<br/>Stage 2 정규화 + contentHash"]
  P1 -->|파싱 오류| ERR
  P1 --> P2{"대량 신규?<br/>50건 이상, 또는<br/>10건 이상이면서 80% 이상"}
  P2 --> LOOP[항목별 처리]
  LOOP --> Q{"atom_id가<br/>DB에 있나?"}
  Q -->|"없음 = 신규"| R{"소스 초기화됨 ·<br/>baseline 끝난 연결 있음 ·<br/>cutoff 이후?"}
  R -->|아니오| HIST["historical 저장"]
  R -->|예| NEW["pending 저장<br/>baseline 이후 연결마다 initial_post<br/>대량이면 held"]
  Q -->|"있음 = 기존"| S{"contentHash 변경?"}
  S -->|예| UPD["content_revision +1<br/>최초 발송한 연결에만<br/>edit 또는 update_post"]
  S -->|아니오| DISP["표시 필드만 갱신"]
  HIST --> END
  NEW --> END
  UPD --> END
  DISP --> END
  END["새 연결 baseline 완료<br/>markPolled · 연속 실패 0 · fetch_log 200"]
  ERR["오류:<br/>연속 실패 +1<br/>다음 poll = 주기 × 2^(n-1), 최대 24시간<br/>fetch_log error"]
```

### 수집 오류 처리 요약

| 상황 | 처리 | 기록 |
| --- | --- | --- |
| SSRF 차단, 4xx, 5xx, 타임아웃, 크기 초과, 파싱 실패 | 다음 poll을 지수적으로 미룸(최대 24시간) | `fetch_log` error, `sources.consecutive_failures` |
| 403·TLS 핸드셰이크 실패 | TLS 1.2로 한 번 재시도. 성공하면 `fetch_options`에 고정, 하루 뒤 기본 설정으로 재검사 | |
| 인증서 오류 | 재시도하지 않음 | error |
| 304 | 본문 없이 종료, 재감지 없음 | `fetch_log` 304 |
| poll 도중 설정 변경 | 결과를 버림(설정 버전 비교) | 없음 |
| 목적지 없는 소스 | 수집하지 않고 다음 주기로 | 없음 |

## 2. 발송: 작업 한 건 처리

코드: `workers/delivery-worker.ts`, `services/delivery.service.ts`, `dispatcher/*`, `db/delivery-job.repository.ts`

```mermaid
flowchart TD
  A["tick: due 작업 조회<br/>pending · 시각 경과 · 소스 활성 · 연결 유지 · cooldown 아님<br/>게시 시각 순"] --> B["웹훅(bucket)별로 묶어<br/>묶음 안에서 순차 실행"]
  B --> C{"claim 성공?"}
  C -->|실패| Z0[건너뜀]
  C -->|성공| D{"연결 종료 · 소스 비활성 ·<br/>목적지 사라짐?"}
  D -->|예| CANCEL[cancelled]
  D -->|아니오| E{"종료 중 · cooldown?"}
  E -->|예| PEND["pending으로 되돌림"]
  E -->|아니오| F{"계획 이후 내용이<br/>또 바뀜?"}
  F -->|"예 · initial_post"| REF["최신 snapshot으로 갱신 후 pending"]
  F -->|"예 · 수정 작업"| SUP["cancelled<br/>최신 revision으로 재계획"]
  F -->|아니오| G{"영속 발송 기록 확인"}
  G -->|"수정 작업인데 기록 없음 ·<br/>edit인데 message ID 없음"| UNED[uneditable]
  G -->|"이미 이 revision 반영"| OK0[succeeded]
  G -->|진행| H{"저장된 payload?"}
  H -->|"있음(재시도)"| SEND
  H -->|없음| T["번역(translate ON) → 렌더 → 검증"]
  T -->|"렌더·검증 실패"| FAIL[failed]
  T --> SAVE["payload 저장"]
  SAVE --> RC{"연결·내용·종료·cooldown<br/>다시 확인"}
  RC -->|문제| D
  RC -->|통과| SEND["request_started 기록<br/>POST(wait=true) 또는 PATCH, 10초"]
  SEND --> R{"응답"}
  R -->|"2xx + message ID"| SUCC["succeeded<br/>message·thread ID와 revision 영속 저장<br/>더 새 revision이 있으면 재계획"]
  R -->|"POST 2xx, ID 없음"| UNK[unknown]
  R -->|429| RL["웹훅 cooldown(전역이면 전체)<br/>pending, 재시도 횟수 미증가"]
  R -->|5xx| R5{"POST?"}
  R5 -->|POST| UNK
  R5 -->|PATCH| RETRY
  R -->|"PATCH 404"| UNED
  R -->|"기타 4xx"| FAIL
  R -->|"예외(타임아웃·네트워크·커밋 실패)"| RX{"POST?"}
  RX -->|POST| UNK
  RX -->|PATCH| RETRY["재시도 1·2·4·8분<br/>5회째 failed"]
```

### 발송 오류 처리 요약

| 결과 | POST(`initial_post`·`update_post`) | PATCH(`edit`) |
| --- | --- | --- |
| 2xx | `succeeded`(ID 없으면 `unknown`) | `succeeded` |
| 429 | cooldown 후 재실행, 횟수 미증가 | 같음 |
| 5xx | `unknown` | 재시도 |
| 404 | `failed` | `uneditable` |
| 기타 4xx | `failed` | `failed` |
| 타임아웃·네트워크 오류 | `unknown` | 재시도 |
| 렌더·검증 오류 | `failed` | `failed` |
| SSRF·웹훅 검증 실패 | `failed`(guard_blocked) | 같음 |

`unknown`·`held`·`uneditable`·`legacy_unknown`은 자동으로 다시 보내지 않는다. 관리자가 `/delivery-jobs`에서 처리한다(§4).

## 3. 번역 (발송 중 payload를 만들 때)

코드: `translator/translation-cache.service.ts`, `translator/translator.ts`, `domain/translation/policy.ts`

```mermaid
flowchart LR
  A["템플릿 AST로<br/>필요한 필드 판정"] --> B{"필드별"}
  B -->|"빈 문자열 · 한국어 · 단계 라벨"| L[로컬 처리]
  B -->|성공 캐시| C[캐시 사용]
  B -->|"실패 cooldown 중(5분)"| O[원문]
  B -->|같은 입력 요청 진행 중| SF[결과 공유]
  B -->|miss| M["primary → fallback<br/>각 15초"]
  M -->|"비활성 · 키 없음 · 오류 · 타임아웃"| M2[다음 역할]
  M2 -->|둘 다 실패| O2["원문 + 실패 캐시"]
  M -->|"출력 잘림 · JSON 파싱 실패"| O2
  M -->|성공| S[성공 캐시]
```

- 캐시 미스인 필드는 한 번의 요청으로 묶는다.
- 번역에 실패해도 원문으로 렌더한 payload가 저장되므로, Discord 재시도 때 번역을 다시 호출하지 않는다.
- 미리보기는 번역하지 않는다.

## 4. 작업 상태와 관리자 조치

```mermaid
stateDiagram-v2
  [*] --> pending: 신규·수정 계획
  [*] --> held: 대량 신규
  held --> pending: 관리자 "발송"
  held --> cancelled: 관리자 "과거 항목"
  pending --> running: claim
  running --> succeeded
  running --> pending: "429 · cooldown · 종료 중 · PATCH 재시도"
  running --> failed: "4xx · 렌더 오류 · 5회 초과"
  running --> unknown: "POST 결과 불명"
  running --> uneditable: "ID 없음 · PATCH 404"
  running --> cancelled: "연결 종료 · 새 revision으로 대체"
  failed --> pending: "소스 화면 '실패 재시도'"
  unknown --> succeeded: "관리자가 message ID 등록"
  unknown --> cancelled: 관리자 보관
  uneditable --> cancelled: 관리자 보관
  legacy_unknown --> cancelled: 관리자 보관
  pending --> cancelled: 연결 종료
```

## 5. 설정 변경과 연결 세대

코드: `services/delivery-binding.service.ts`

```mermaid
flowchart LR
  C["소스·그룹 수정, import,<br/>활성/비활성, poll 시작, 부팅"] --> R["reconcile:<br/>현재 목적지 집합 계산"]
  R --> E["사라진 목적지 → 연결 종료<br/>pending·held·failed 작업 취소"]
  R --> N["새 목적지 → 새 연결 세대<br/>next_poll_at = NULL"]
  N --> P["다음 poll: 조건부 GET 없이 수집<br/>그 시점까지의 항목 = baseline(보내지 않음)"]
```

- 그룹 이름·아바타 변경, 같은 웹훅을 가리키는 그룹 추가로는 새 세대가 생기지 않는다.
- feedUrl을 바꾸면 항목을 지우고 모든 연결을 새 세대로 시작한다.
- 웹훅만 바꿔도 이전 웹훅으로 보낸 메시지는 더 이상 수정하지 않는다(Discord는 메시지를 만든 웹훅으로만 수정할 수 있다).

## 6. 알려진 한계 (2026-10-16 검토, 후속 수정 대상)

| 위치 | 내용 |
| --- | --- |
| §2 예외 → POST → `unknown` | DNS 실패·연결 거부처럼 요청이 나가지 않은 경우도 `unknown`이 된다. `unknown`에는 재발송 조치가 없다 |
| §4 `held`·`unknown` | 건수 알림이 없어 `/delivery-jobs`에 들어가야 보인다 |
| §2 정렬 | 같은 poll의 날짜 없는 신규 항목은 피드 순서(보통 최신 글 먼저)대로 발송된다 |
| §1 항목별 처리 | poll마다 모든 항목의 `last_seen_at`을 개별 UPDATE한다 |
| 정리 | 0021 이전 항목은 `last_seen_at`이 NULL이라 본문이 정리되지 않는다. 성공 번역 캐시는 정리하지 않는다 |
