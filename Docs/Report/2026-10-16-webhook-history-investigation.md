# 새 웹훅에 과거 항목이 발송되는 문제 조사

조사일: 2026-10-16 (Asia/Seoul)

## 결론

현재 코드에서 **새 웹훅에 과거 항목이 자동 POST되는 경로를 재현했다.** 소스 최초 등록의 historical baseline과 달리, 웹훅 교체·그룹 추가 시에는 목적지별 발송 시작 경계가 없다. 기존 항목이 pending이 되면 전송 시점의 현재 그룹 전체를 대상으로 처리한다.

단, **웹훅 URL을 바꾸는 동작만으로 모든 delivered 항목이 즉시 재큐되지는 않는다.** 다음 두 조건을 구분해야 한다.

- 이미 발송한 항목: 이후 `contentHash`가 바뀌면 재큐되어 새 웹훅에도 POST된다.
- 이미 pending인 항목: 내용 변경 없이도 새 웹훅으로 전송된다.

운영에서 과거 항목 전체가 발송된 개별 사건은 확인하지 못했다. 기본 경로의 로컬 DB는 sources/items/groups/delivery_log/fetch_log가 비어 있었다. 실제 운영 DB 또는 당시 로그와 대조해야 전체 항목의 재큐 계기를 확정할 수 있다.

## 코드상의 원인

1. `scheduler/change-detect.ts:6`은 해시가 달라진 delivered 항목을 `changed-requeue`로 분류한다.
2. `scheduler/poller.ts:243`의 upsert에서 cutoff 검사는 **DB에 없는 신규 항목에만** 적용한다. 기존 항목의 변경은 `requeueForDelivery`로 pending이 된다. 웹훅 연결 이전 항목인지 검사하지 않는다.
3. `dispatcher/webhook.ts:111`은 전송 당시 `resolveDestinationsForSource`로 **현재 그룹의 웹훅**을 조회한다. 과거 항목의 원래 발송 대상이나 큐 생성 당시의 대상이 보존되지 않는다.
4. `db/item.repository.ts:141`의 due 쿼리는 pending/재시도 시각/소스 활성화만 검사한다. 새 목적지의 연결 시각과 비교하는 조건이 없다.
5. `dispatcher/webhook.ts:199`의 중복 방지는 `(itemId, destinationKey, contentHash)`별 성공 로그를 기준으로 한다. 웹훅이 바뀌면 destinationKey가 달라져 옛 성공 기록이 새 목적지의 발송을 막지 않는다.
6. `dispatcher/webhook.ts:229`은 `editInPlace=true`여도 **새 목적지에 기존 message ID가 없으면 POST**한다. 수정 옵션은 과거 항목의 신규 목적지 발송을 제한하지 않는다.

그룹 수정은 `services/group.service.ts:51`, 소스 그룹 변경은 `services/source.service.ts:95`에서 수행한다. 이 경로에는 목적지별 baseline이나 과거 작업의 새 목적지 편입을 막는 처리도 없다. 소스 단위 cutoff만 리셋해도 기존 pending 및 변경 재큐 경로에는 적용되지 않아 충분한 해결책이 아니다.

generic의 변경 감지는 제목+링크, incident는 단계+요약을 기준으로 한다. 따라서 운영에서 모든 항목이 재큐되었다면 해당 필드의 실제 변화 또는 기존 pending 축적 여부를 추가로 확인해야 한다. generic 본문만 변했다고 일괄 재큐된다고 단정할 수 없다.

## 이번 조사에서 실행한 재현

`2026-10-16-webhook-history-repro.mjs`는 현재 `src/server`를 로드하고 실제 마이그레이션·레포지토리 SQL·서비스·poller·dispatcher를 사용한다. DB만 Node 내장 SQLite의 메모리 어댑터로 대체하고, 피드 응답과 POST/PATCH를 모의 처리했다. 외부 네트워크 요청은 없으며 운영 DB는 변경하지 않았다.

테스트 시간은 소스 등록 10/1, 항목 게시 10/2, 웹훅 연결 변경 10/15, 재수집 10/16으로 고정했다. 아래 3개 항목은 모두 웹훅 변경 전에 존재했다.

| 시나리오 | 재현 결과 |
| --- | --- |
| 새 RSS 소스 첫 수집에 기존 항목 4개 포함 | historical 4개, POST 0회 |
| A→B 교체, 기존 delivered 항목 내용 동일 | POST 0회 |
| A→B 교체 후 delivered 항목 3개 내용 변경 | **B POST 3회, PATCH 0회** (`editInPlace=true`) |
| A 유지+B 그룹 추가 후 delivered 항목 3개 내용 변경 | **A PATCH 3회+B POST 3회** |
| 기존 pending 항목 3개가 있는 상태에서 A→B 교체 | **내용 변경 없이 B POST 3회** |
| A→B 교체 후 historical 항목 내용 변경 | POST 0회, historical 유지 |

재현 실행 (애플리케이션 디렉터리에서):

```powershell
node Docs/Report/2026-10-16-webhook-history-repro.mjs
```

모든 assertion이 통과했다. 이 assertion은 현재 문제 동작의 확인용이며, 원하는 수정 동작을 검증하는 회귀 테스트는 아니다.

## 검증 범위와 환경 제약

- 서버와 테스트 TypeScript 검사 모두 통과: `node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit`, `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit`.
- 셸 PATH에 npm/npx가 없어 설치된 CLI의 Node 진입점을 직접 실행했다.
- 기존 poller/dispatcher Vitest는 `@rolldown/binding-win32-x64-msvc` 누락으로 시작하지 못했다. 설치된 better-sqlite3 바이너리도 Windows에서 로드되지 않는다. 의존성 재설치나 lockfile 수정은 하지 않았다.
- 재현의 SQLite 어댑터는 전체 better-sqlite3 호환성이나 운영 환경의 검증을 대체하지 않는다. 이번 시나리오의 실제 SQL과 상태 전이를 검증했다.
- 로컬 기본 DB를 읽기 전용으로 조회했다. 운영 프로세스가 별도 DATABASE_PATH를 사용하는지는 확인하지 않았다. 비밀값과 실제 웹훅 URL을 출력하지 않았다.
- 애플리케이션 코드, 기존 테스트, 마이그레이션, 보호 설계 문서는 수정하지 않았다. 이번에 추가한 파일은 조사 보고서와 진단 스크립트뿐이다.

## 설계와 수정 제안

`Docs/Architecture/backend-spec.md` §4.4·§4.6은 변경된 delivered 항목을 전체 목적지로 재전송하고, message ID가 없거나 PATCH 404일 때 POST하는 현재 정책을 명시한다. 따라서 최초 poll의 baseline 누락보다 **새 목적지에 대한 과거 항목 비소급 정책이 빠진 설계 문제**에 가깝다. 2026-09-07의 루트 `PROJECT_STRUCTURE_REVIEW.md` §4에도 같은 경로가 기록되어 있으며, 현재 코드에서 그대로 재현된다.

제안하는 계약 변경:

1. backend-spec §4.4·§4.6: 기존 항목의 수정은 이미 발송했던 목적지의 기존 메시지에만 적용한다. 새 목적지에는 과거 항목을 자동 POST하지 않는다.
2. backend-spec §4.6·§4.9·§4.11: 웹훅 교체·그룹 연결마다 연결 세대/시작 경계를 관리하고, 기존 pending 작업이 새 목적지로 자동 이관되지 않도록 목적지별 발송 작업·상태를 보존한다. 날짜 없는 피드 때문에 publishedAt만으로 판정하지 않는다.
3. backend-spec §4.6: message ID 미상/삭제 시 새 POST는 명시적 재전송 작업으로 제한한다. 영속 발송 상태를 정리 가능한 delivery_log에서 분리한다.
4. 필요한 경우 frontend-spec: 신규 항목 전송, 기존 메시지 수정, 명시적 과거 재전송의 선택과 안내를 구분한다.

이것은 변경 제안이며 보호 문서는 편집하지 않았다. 해당 문서 수정은 AGENTS.md에 따른 파일·항목별 명시 승인이 필요하다. 이번 요청은 원인 조사이므로 수정 승인 요청이나 구현까지 진행하지 않았다.
