# RSS → Discord 프로젝트 구조 및 장애 경로 조사

조사일: 2026-09-07 · 대상: `rss-discord-bridge/` · 현재 HEAD: `342d9dd`

> 2026-10-16 문서 정리 때 워크스페이스 루트(`RSS_Monite/PROJECT_STRUCTURE_REVIEW.md`, 저장소 밖)에서 이 위치로 옮겼다. 링크만 새 위치에 맞게 고쳤고, 본문은 조사 당시 그대로다. 이후 교체된 코드 링크는 `Archive/2026-10-16/` 보관본을 가리킨다. 현재 기준은 [통합 개편 보고서](../../2026-10-16-consolidated-reorganization-report.md)다.

## 1. 결론

현재 프로젝트는 RSS 수집, 정규화, DB, Discord 전송, 번역, 관리 화면의 큰 경계가 이미 분리되어 있다. 프레임워크를 교체하거나 전체 디렉터리를 재작성하기보다 **전송 상태와 로그를 분리하고, 신규 발송과 수정의 정책을 명시하며, 환경 설정의 전달 경로를 통합하는 것**이 우선이다.

| 우선순위 | 발견 사항 | 판단 및 권고 |
| --- | --- | --- |
| P0 | 발송된 항목의 내용 변경 → 재큐 → 현재 그룹의 Webhook으로 전송 | 새 Webhook에 과거 항목이 POST되는 경로를 재현했다. 수정 작업의 대상은 기존 발송 대상에 한정하고 신규 목적지 소급 전송은 명시적 작업으로 분리한다. |
| P0 | `.env`의 API 키가 번역 모듈에 전달되지 않음 | 현재 환경에서 재현했다. 단일 환경 로더의 결과를 런타임 설정·번역·상태 화면에 함께 주입한다. |
| P1 | 번역 실패로 반환된 원문도 완료 캐시로 저장 | 재현했다. 번역 성공 여부와 실패 재시도 시각을 별도 상태로 기록한다. |
| P1 | 기존 Discord 메시지 ID를 삭제 가능한 로그에서만 조회 | 로그 정리 후 POST로 돌아가는 경로를 재현했다. 영속적인 목적지별 발송 상태가 필요하다. |
| P1 | 현재 테스트가 문제 동작 일부를 정상 계약으로 검증 | 기존 테스트 통과만으로 사용자 요구 충족을 판단할 수 없다. 먼저 동작 정책을 결정한 뒤 회귀 테스트를 바꿔야 한다. |
| P2 | 설계 문서 경로와 실제 배치 불일치, 계층 간 역방향 의존 | 문서 진입점 복구와 작은 단위의 책임 분리를 권고한다. |

이 작업은 조사와 제안이다. 애플리케이션 코드, 보호된 설계 문서, 운영 설정 및 DB는 수정하지 않았다. 실제 Gemini 호출과 Discord 전송도 수행하지 않았다.

## 2. 확인 범위와 Git 이력

### 저장소와 작업 트리

- `/RSS_Monite` 자체는 Git 저장소가 아니며, 실제 저장소는 `/RSS_Monite/rss-discord-bridge`이다. 요청한 보고서는 워크스페이스 루트인 이 위치에 작성했다. 따라서 이 보고서는 내부 저장소의 `git status`에는 표시되지 않는다.
- `main`에는 `342d9dd Initial commit: rss-discord-bridge` 한 커밋만 있다. 그러나 `backup/original-with-claude-coauthor`와 전체 ref를 포함하면 67개 커밋이 확인된다. shallow checkout은 아니다.
- 따라서 AGENTS.md의 “Git 히스토리가 없다”는 설명은 현재 상태와 다르다. `git log`뿐 아니라 `git log --all`로 과거 구현을 확인했다. 전체 ref의 유사 커밋을 각각 독립적인 기능 추가로 집계하지 않았다.
- 백업 브랜치와 main의 파일 내용 차이는 없고, 확인된 7개 차이는 파일 모드이다. 과거 브랜치의 관련 구현을 현재 코드와 대조할 수 있었다.
- 조사 전부터 `package-lock.json` 및 피드 fixture 6개에 `100644 → 100755` 변경이 있었다. 내용 변경은 없으며 그대로 보존했다.

### 문제와 관련된 변경

| 커밋 | 일자 | 조사상 의미 |
| --- | --- | --- |
| `1761368` | 2026-05-30 | 백엔드 구현 누적: 수집·전송·번역·설정 경로의 기반 |
| `3c29372` | 2026-05-30 | D22: `edit_in_place`, Discord message ID 기록, PATCH와 404 POST 폴백 도입 |
| `9a9044c` | 2026-06-01 | systemd `EnvironmentFile` 추가. 커밋 본문에 API 키의 `missing-key` 해소 목적이 명시되어 있다. 앱 로더 자체의 문제는 남아 있다. |
| `be58105` | 2026-06-05 | generic 변경 감지를 `title + link` 중심으로 보정한 후속 수정 |
| `09ca325` | 2026-06-09 | D24: 전송 목적지를 그룹으로 단일화. 과거 `source_destinations` 설계 폐기 |
| `342d9dd` | 2026-06-09 | 현재 main 스냅샷 |

날짜와 의미는 로컬 Git에서 확인했다. 원격 fetch나 Git 변경은 하지 않았다.

## 3. 현재 구조와 유지할 부분

```text
/RSS_Monite/
├── AGENTS.md
├── CLAUDE.md
├── PROJECT_STRUCTURE_REVIEW.md
└── rss-discord-bridge/                 # Git 및 npm 루트
    ├── src/server/
    │   ├── app.ts, config.ts           # HTTP 시작과 설정
    │   ├── runtime/                   # 의존성 조립, 마이그레이션
    │   ├── controllers/, services/    # HTTP 어댑터, 관리 기능
    │   ├── domain/envelope/           # Stage 1 RSS/Atom 공통화
    │   ├── domain/normalize/          # Stage 2 순수 정규화·해시
    │   ├── scheduler/                 # 폴링, 신규·변경 판정
    │   ├── dispatcher/                # 렌더·목적지·전송·재시도
    │   ├── translator/providers/      # Gemini, NVIDIA NIM
    │   ├── db/, security/, workers/
    │   └── contracts/, middleware/
    ├── src/resources/
    │   ├── migrations/                # 0001~0020
    │   ├── presets/                   # Discord Handlebars 프리셋
    │   └── templates/                 # 관리 화면과 정적 자산
    ├── test/{unit,integration,mocks}/
    ├── Docs/{Architecture,Deploy}/
    ├── scripts/smoke.mjs
    └── package.json, default.env.example
```

실제 처리 흐름은 `Poller → fetchFeed → parseFeed → normalize → items 저장/재큐 → WebhookDispatcher → 번역 → Handlebars 렌더 → Discord`이다. 목적지는 전송 시점에 `source_groups → groups.webhook_url`에서 계산한다.

유지할 장점은 Stage 1/2 분리, `(source_id, atom_id)` 식별, 최초 성공 poll의 historical 처리, SSRF 방어, SQLite 트랜잭션, 모의 외부 호출을 주입할 수 있는 테스트 구조다. Fastify·Handlebars·htmx·CodeMirror·SSE 및 `tsc + copyfiles`도 현 규모에 적합하다. 마이크로서비스나 별도 큐 서버는 이번 문제 해결의 선행 조건이 아니다.

현재 복잡도가 집중된 곳은 `dispatcher/webhook.ts` 499줄, `scheduler/poller.ts` 378줄, `services/export-import.service.ts` 484줄이다. 파일 길이 자체보다 전송 대상 결정·메시지 수정·네트워크 요청·재시도·DB 커밋을 한 클래스가 함께 담당하는 점이 변경 위험을 높인다.

## 4. 과거 항목이 새 Webhook으로 보내지는 문제

### 4.1 코드로 확인하고 재현한 경로

1. Webhook A에 항목 X를 발송해 `delivery_status='delivered'`가 된다.
2. 관리자가 그룹 Webhook을 B로 바꾸거나 새로운 그룹을 연결한다.
3. 이후 RSS에서 X의 `contentHash`가 바뀐다.
4. `classifyExistingItem()`은 delivered 항목의 변경을 `changed-requeue`로 판정한다. 기존 항목에는 신규 항목용 cutoff 검사가 적용되지 않는다.
5. dispatcher는 큐 생성 당시의 목적지가 아닌 **현재** 목적지 B를 조회한다.
6. `(item_id, B의 destination_key, 새 content_hash)` 성공 기록이 없으므로 전송을 진행한다.
7. `editInPlace=true`여도 B에 대한 기존 메시지 ID가 없으므로 PATCH 대신 POST한다.

근거: [change-detect.ts](../../../../Archive/2026-10-16/src/server/scheduler/change-detect.ts), [poller.ts](../../../../Archive/2026-10-16/src/server/scheduler/poller.ts) 243~267행, [resolve-destinations.ts](../../../../src/server/dispatcher/resolve-destinations.ts), [webhook.ts](../../../../Archive/2026-10-16/src/server/dispatcher/webhook.ts) 113·199·229~252행.

**Webhook 변경만으로 이미 delivered인 모든 항목이 즉시 재전송되는 것은 아니다.** 위 경로에는 내용 변경에 의한 재큐가 필요하다. 이미 pending인 항목은 내용 변경 없이도 현재 목적지로 전송될 수 있다. 안정된 해시와 유지된 성공 기록에서는 매 poll마다 무한 반복하지 않는다. 운영에서 “계속” 보내진다면 해시의 반복 변화, PATCH 404, 목적지 변화, 로그 삭제 또는 전송 후 DB 커밋 실패를 구분해야 한다.

generic 해시는 현재 `title + '\n' + link`, incident 해시는 `stage + '\n' + summary`이다. 따라서 generic 본문만 바뀌는 것이 이번 재큐의 직접 원인이라고 단정할 수 없다. 제목·링크가 실제로 바뀌는지, incident 요약이 변하는지를 확인해야 한다. 또한 generic의 동일 해시에서는 저장 갱신도 건너뛰므로 본문만 수정되면 DB의 summary가 오래된 상태로 남을 수 있다.

### 4.2 중복을 늘릴 수 있는 별도 경로

| 조건 | 현재 동작 | 보완 |
| --- | --- | --- |
| `editInPlace=false` | 변경된 delivered 항목을 새 POST로 보냄 | “수정 비활성”과 “수정 내용을 새 메시지로 알림”을 다른 정책으로 표현 |
| OFF 상태로 처음 발송 후 ON 전환 | 과거 message ID를 수집하지 않았으므로 새 POST | 최초 발송부터 ID를 저장하고, 과거 ID 미상 항목은 수정 생략 |
| PATCH가 404 반환 | 즉시 POST 폴백 | 자동 재생성 기본 금지, `message_missing` 상태와 명시적 재전송 제공 |
| 마지막 관련 로그가 90일 보존기간을 넘겨 삭제 | message ID·중복 방지 근거 소실 | 목적지별 발송 상태를 로그에서 분리 |
| 일부 목적지 성공 뒤 재시도 중 그룹 구성 변경 | 최신 그룹으로 대상 재계산 | 최초 계획의 목적지별 작업을 보존하고 해제된 대상은 취소 |
| Discord 전송 성공 후 DB 커밋 실패 | 성공 기록이 없어 다음 실행에서 재전송 가능 | 목적지별 즉시 결과 기록 및 작업 상태 도입; 외부 API와 DB 간 원자성 한계는 남음 |

근거: [delivery-log.repository.ts](../../../../src/server/db/delivery-log.repository.ts)의 `findResolved`, `findLatestMessageId`, `pruneOlderThan`; [cleanup-worker.ts](../../../../src/server/workers/cleanup-worker.ts); 기존 [webhook.test.ts](../../../../Archive/2026-10-16/test/integration/dispatcher/webhook.test.ts)의 404 폴백·ID 수집·DB 커밋 실패 테스트.

현재 `editInPlace`는 **변경 알림을 끄는 스위치가 아니라 PATCH와 POST를 선택하는 스위치**다. 이를 OFF로 바꾸는 것만으로 중복 방지를 기대하면 안 된다. 임시 차단이 필요하다면 문제 소스를 비활성화할 수 있지만 신규 알림도 멈추며, 재활성화하면 보존된 pending 작업이 다시 실행된다. DB 초기화나 전체 실패 재시도를 해결책으로 먼저 적용하는 것도 적절하지 않다.

### 4.3 권고하는 동작 정책

RSS 신규 알림이 주목적이므로 일반 뉴스 소스는 `new_only`를 기본으로 권고한다. 기존 메시지의 지속적인 상태 갱신이 필요한 incident 소스에는 `edit_existing`을 제공한다. 기존 설정을 어떤 정책으로 이관할지는 별도 결정해야 한다.

| 정책 | 신규 항목 | 기존 항목 내용 변경 | 새로 연결된 Webhook의 과거 항목 | 기존 메시지 삭제/ID 미상 |
| --- | --- | --- | --- | --- |
| `new_only` | POST | 저장만 | 자동 전송 없음 | 자동 복구 없음 |
| `edit_existing` | POST + ID 저장 | 기존 발송 대상 중 여전히 유효한 대상에만 PATCH | 자동 전송 없음 | 수정 생략 + 사유 기록 |
| 명시적 재전송 | 선택한 항목·목적지만 POST | 관리자 요청 시 실행 | 범위 미리보기 후 실행 | 새 메시지 생성 가능 |

Webhook 교체는 연결의 새 세대로 취급한다. 새 세대에는 연결 후 관측한 신규 항목만 허용하고, 기존 큐를 새 세대로 자동 이관하지 않는다. 게시 시각이 없거나 부정확한 RSS도 있으므로 `published_at`만으로 판단하지 말고 **최초 관측 시점과 최초 발송 계획**을 기준으로 삼는다. 기존 목적지를 해제한 뒤 그곳으로 계속 PATCH하는 것도 피해야 한다.

현재 backend-spec §4.4·§4.6은 변경된 delivered 항목을 전체 목적지로 재전송하고 PATCH 404에는 POST 폴백하도록 명시한다. 따라서 위 권고는 일부 기존 설계를 바꾸는 제안이다. 구현 전에 해당 파일·항목의 명시적 승인이 필요하며, 이번 조사에서는 보호 문서를 수정하지 않았다.

## 5. Gemini 번역 실패

### 5.1 가장 먼저 고칠 부분: 환경 설정의 단절

[config.ts](../../../../src/server/config.ts) 21~48행은 `.env`를 읽어 복사된 `effectiveEnv`를 만든다. 그러나 반환값은 host·port·DB 경로·production 여부뿐이며 `process.env`를 변경하지 않는다.

[container.ts](../../../../src/server/runtime/container.ts) 97·120·151행은 `loadConfig(options.env)`를 호출한 다음, 번역기와 ModelService에는 원래 `options.env`를 전달한다. 일반 시작 경로에서는 이것이 undefined라 [keys.ts](../../../../src/server/translator/keys.ts)가 `process.env`를 읽는다. 결과적으로 `.env`에만 있는 API 키는 번역기에서 보이지 않는다.

현재 환경에서는 키 값을 출력하지 않고 존재 여부만 확인했다.

| 확인 항목 | 결과 |
| --- | --- |
| 앱 `.env`의 `PRIMARY_MODEL_API_KEY` 비어 있지 않음 | 참 |
| 조사 프로세스 환경의 같은 키 존재 | 거짓 |
| `loadConfig()` 호출 후 번역기의 키 인식 | 거짓 |
| 로컬 DB primary | Gemini / `gemini-3.1-flash-lite` / enabled |
| 로컬 DB fallback | NVIDIA NIM / disabled |

즉 `.env`만 작성하고 일반 npm 명령으로 시작하는 경로에서는 `missing-key → 원문 반환`이 발생할 수 있다. 별도로 실행 중인 운영 서비스의 환경까지 확인한 결과는 아니다.

Git `9a9044c`와 현 [systemd unit](../../../../Docs/Deploy/rss-discord-bridge.service)은 이 문제를 `EnvironmentFile`로 우회한다. systemd가 실제로 키를 주입하는 운영 환경이라면 이 결함만으로 그 환경의 번역 실패를 설명할 수 없다.

권고 구현은 `loadEnvironment()`가 프로세스 환경 우선으로 `.env`를 한 번 병합하고, 같은 결과를 `loadConfig`, `ModelTranslator`, `ModelService`에 주입하는 것이다. 비밀값은 DB·화면 DTO·로그에 넣지 않는다. 단기 운영 대안은 서비스의 환경 파일 주입을 확인하는 것이지만, 로컬 실행까지 해결하려면 앱 설정 경계를 고쳐야 한다.

### 5.2 실패 캐시와 복구 경로

[translator.ts](../../../../src/server/translator/translator.ts) 153~161행은 `result.translated`를 검사하지 않고 항상 `saveTranslation()`을 호출한다. 번역 실패 원문도 `translated_at`이 설정되고, 다음 요청은 이 값만 보고 모델 호출을 생략한다. 기존 [webhook-translator.test.ts](../../../../Archive/2026-10-16/test/integration/dispatcher/webhook-translator.test.ts) 98행의 테스트도 이 동작을 명시적으로 기대한다.

따라서 키를 고친 뒤에도 기존 항목은 자동으로 새 번역을 얻지 못할 수 있다. 원문으로 Discord 전송에 성공한 항목은 이미 delivered라 번역 설정 변경만으로 다시 처리되지 않는다.

권고는 `translation_status`, `last_error`, `retry_after`, `translated_at`을 구분하는 것이다. 같은 전송 시도에서는 원문 폴백 결과를 재사용해 중복 모델 호출을 억제하되, 실패를 영구 성공 캐시로 취급하지 않는다. 원문 발송을 유지하면서도 재번역은 별도 작업으로 제어한다. 이미 발송한 메시지는 재번역만으로 새 POST하지 않고, 명시적 요청과 기존 메시지 수정 정책에 따른다.

캐시 키에는 번역 입력의 해시(title·summary), 언어, provider/model, 프롬프트 버전을 포함하는 편이 좋다. 현재 generic `contentHash`는 summary를 포함하지 않으므로 번역 캐시 키로 그대로 사용하는 것은 부족하다. 번역 입력 해시와 전송 변경 판정 해시는 목적이 다르다.

### 5.3 추가 보완 사항

- Gemini 어댑터는 `responseMimeType='application/json'`만 지정한다. 필수 문자열 `title`, `summary`를 JSON Schema로 지정하고 응답 검증은 유지한다. 공식 API는 스키마 기반 구조화 출력을 지원한다. [Google 구조화 출력 문서](https://ai.google.dev/gemini-api/docs/structured-output)
- 어댑터가 요청의 AbortSignal을 SDK에 전달하지 않는다. 15초 이후 상위 호출은 fallback으로 넘어가지만 Gemini 요청은 계속될 수 있다. 설치된 SDK의 `GenerateContentConfig.abortSignal`에 연결한다.
- 기본 출력 상한은 1,200 tokens다. 긴 RSS 입력에 부족할 수 있으나 실제 `MAX_TOKENS` 로그 없이 현재 장애 원인으로 단정할 수 없다. 입력 길이 정책과 종료 사유·출력 토큰 수를 함께 점검한다. 현 코드는 `MAX_TOKENS`를 소문자로 정규화해 처리하므로 대소문자 불일치는 원인이 아니다. [Google 응답 종료 사유](https://ai.google.dev/api/generate-content#FinishReason)
- 현재 파싱 실패·출력 잘림은 fallback을 호출하지 않고 즉시 원문으로 돌아간다. 이는 backend-spec §4.7의 기존 계약이다. fallback을 거치도록 개선하려면 정책 변경으로 다뤄야 한다.
- ModelService의 `ready`는 실제 API 호출 성공을 뜻하지 않는다. 최근 timeout·429·파싱 실패도 ready로 보일 수 있다. 키 존재 여부와 최근 호출 결과를 분리하고, Discord에 보내지 않는 번역 진단 기능을 제공한다.
- 공식 문서에 `gemini-3.1-flash-lite` 모델 코드가 존재한다. 모델명이 잘못되었다고 단정할 근거는 없다. 실제 키의 모델 접근 권한·쿼터·응답은 별도 검증 대상이다. [Google 모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)
- Preview는 계약상 번역하지 않으며 현재 TestSendService도 preview 샘플을 사용하는 별도 경로다. 미리보기나 테스트 전송에서 원문이 보였다는 사실만으로 실제 dispatcher의 번역 실패를 판단하면 안 된다.

## 6. 권고 구조: 기존 계층 유지 + 상태와 정책 분리

아래는 제안 구조이며 아직 만들거나 이동한 애플리케이션 파일은 없다.

```text
src/server/
├── app.ts
├── config.ts
├── runtime/
│   ├── environment.ts                 # 공통 환경 로드
│   ├── container.ts                   # 조립만 담당
│   └── migrator.ts
├── controllers/                       # 현재 HTTP/API 구조 유지
├── services/
│   ├── feed-ingestion.service.ts      # 수집 결과 저장·작업 계획
│   ├── delivery.service.ts            # 목적지별 작업 실행 조정
│   └── ...                            # source/group/model 관리
├── domain/
│   ├── envelope/, normalize/          # Stage 1/2 유지
│   └── delivery-policy.ts             # new_only/edit_existing 순수 판정
├── scheduler/poller.ts                 # 실행 시각·중복 실행 제어
├── workers/
│   ├── delivery-worker.ts             # 영속 작업 조회·실행
│   └── cleanup-worker.ts              # 감사 로그만 정리
├── dispatcher/
│   ├── discord-client.ts              # POST/PATCH·응답 분류
│   ├── resolve-destinations.ts         # 그룹 목적지 해석
│   ├── render.ts, validate.ts
│   └── payload-options.ts
├── translator/
│   ├── translator.ts                  # provider 선택과 폴백
│   ├── translation-cache.service.ts   # 성공/실패·캐시 무효화
│   └── providers/{gemini,nvidia-nim}.ts
├── db/
│   ├── item.repository.ts             # RSS 원문과 관측 상태
│   ├── item-delivery.repository.ts    # 목적지별 영속 발송 상태
│   ├── delivery-job.repository.ts     # 작업과 재시도
│   └── delivery-log.repository.ts     # 정리 가능한 감사 이력
└── contracts/, security/, middleware/
```

목적지 해석 모듈이 현재 `services/validation.ts`의 `blankToNull`을 가져오는 역방향 의존은 작은 순수 유틸로 옮기거나 해당 경계에서 처리한다. services·scheduler가 runtime의 전체 RepositoryRegistry 타입에 의존하는 부분도 필요한 repository 인터페이스만 받도록 점진적으로 좁힌다.

스케줄러와 delivery worker를 분리하면 번역·Discord 지연 때문에 다음 RSS 확인이 함께 늦어지는 결합을 줄일 수 있다. 처음에는 같은 프로세스에서 실행하고 동시 처리 상한을 둔다. 여러 프로세스를 지원하려면 현재 메모리 Set만으로는 충분하지 않으므로 DB claim/lease를 도입해야 한다. poll 도중 내용이 바뀌는 경우 이전 버전의 전송 완료가 최신 버전을 delivered로 덮지 않도록 버전 조건부 갱신도 필요하다.

### 저장 모델의 책임

| 데이터 | 제안 책임 |
| --- | --- |
| `items` | `(source_id, atom_id)` 원문·최초 관측·현재 버전. historical 불변식 유지 |
| 그룹/연결 세대 | Webhook 변경과 연결 시작·종료를 구별. 해제된 목적지 작업 취소 |
| `item_deliveries` | item×목적지 세대의 message ID, 실제 thread ID, 최초 발송 시각, 마지막 반영 버전, 수정 불가 상태 |
| `delivery_jobs` | create/update/replay 유형, 대상 세대, 버전, 재시도 시각·횟수·claim 상태 |
| `delivery_log` | 각 시도의 결과. 정리해도 발송 정체성과 중복 방지 근거는 유지 |

`delivery_jobs`의 중복 방지는 단순 contentHash만이 아니라 item·대상 세대·작업 종류·관측 버전을 기준으로 설계한다. 내용이 A→B→A로 되돌아왔을 때 최초 A의 성공 로그 때문에 필요한 PATCH가 생략되는 일을 피해야 한다. 명시적 replay에는 별도 요청 ID가 필요하다.

포럼 자동 생성 메시지는 반환된 실제 thread ID도 보존해야 한다. 수정 API는 webhook ID/token/message ID 및 필요 시 thread ID를 사용한다. 다른 Webhook으로 기존 메시지 ID를 옮겨서 수정하는 방식은 해결책이 아니다. [Discord Webhook API](https://docs.discord.com/developers/resources/webhook)

새 테이블은 제거된 D23 `source_destinations`를 복원하려는 것이 아니다. 설정의 권위는 D24대로 그룹에 두고, **실제로 어떤 버전을 어느 목적지에 보냈는지**를 별도로 기록한다. 마이그레이션 번호는 구현 시점의 다음 번호를 확인해 새 파일로 추가하며 0001~0020은 수정하지 않는다.

백필은 남아 있는 성공 로그에서만 확실한 상태를 복원한다. 이미 삭제된 메시지 ID를 추측하거나 Webhook 변경을 과거 재전송의 허가로 해석하지 않는다. 복원 불가 항목은 `legacy_unknown` 등 명시적인 상태로 두고 자동 새 POST를 막는다. `wait=true`로 최초 발송부터 ID를 받되, Discord 성공 직후 프로세스가 죽는 경우까지 정확히 한 번 전송을 보장한다고 약속해서는 안 된다.

## 7. 문서 및 테스트 구조 개선

AGENTS.md가 참조하는 `Docs/README.md`와 `stage2-normalize.md`는 현재 작업 트리에서 찾을 수 없었다. 실제 backend/frontend 스펙은 `rss-discord-bridge/Docs/Architecture/`에 있다. 스펙 내부에도 예전 README 섹션 참조가 남아 있다. 내용은 직접 고치지 않고, 문서 진입점 복구와 참조 정비를 제안한다. 관련 발견 사항은 `Docs/Report/2026-09-07-structure-review-notes.md`에도 기록했다.

테스트는 현재 unit/integration 구분을 유지하되 `turn10-api`, `turn11-web` 같은 작업 회차 기반 이름은 향후 기능별 이름으로 정리하는 것이 좋다. 외부 피드 fixture의 최신화와 회귀 테스트용 고정 fixture도 구분해 같은 입력에 대한 결과를 재현할 수 있게 한다.

필수 회귀 시나리오는 다음과 같다.

1. 첫 poll historical 무전송, 두 번째 poll의 신규 항목만 발송.
2. A→B Webhook 교체 후 과거 항목 변경에도 B POST 0회, 연결 이후 신규 항목 B POST 1회.
3. 기존 A 유지 + B 추가 시 과거 항목은 A에만 PATCH, B에는 전송 없음.
4. `new_only` 변경 무전송, `edit_existing` 수정 성공, ID 미상·404 자동 POST 금지.
5. 로그 정리 후에도 메시지 ID·중복 방지 상태 유지.
6. 부분 성공·목적지 변경·동시 내용 갱신·A→B→A 내용 복귀의 상태 일관성.
7. 비밀이 아닌 테스트 `.env`만 주었을 때 번역기와 ModelService가 같은 키를 인식; 프로세스 환경 우선순위 확인.
8. Gemini SDK 경계 모의 테스트: 스키마·signal 전달, 빈 응답, JSON 오류, MAX_TOKENS, 429, timeout.
9. 번역 실패와 성공 캐시 구분, 키 복구 후 허용된 재번역, 모델/프롬프트 버전 변경 무효화.
10. 새 마이그레이션 백필과 ID 미상 과거 항목의 보수적 처리.

## 8. 실행한 검증과 한계

- Node.js `v22.23.2` 환경에서 앱 디렉터리의 `npm run typecheck`: 통과.
- `npm test`: **22개 테스트 파일, 164개 테스트 통과**.
- 별도의 임시 진단 스크립트를 메모리 SQLite와 모의 POST/PATCH로 실행했다. Webhook 교체만으로는 재전송하지 않지만 이후 내용 변경에는 새 POST가 발생함, 로그 정리 후 같은 목적지에서도 새 POST가 발생함, 실패 원문 캐시가 재번역을 생략함을 assertion으로 확인했다.
- 동일 진단에서 `loadConfig()` 호출 이후에도 `.env`의 primary 키가 번역기에 보이지 않음을 확인했다. 키 값은 출력하지 않았다.
- 로컬 기본 경로 SQLite는 읽기 전용으로 조회했다. 모델 설정은 있었지만 sources/items/delivery_log/model_usage는 비어 있었다. **실제 운영 중복 발송의 발생 시각·개별 원인 및 Gemini API 응답은 확인할 수 없다.** 운영 프로세스가 다른 DB 경로나 환경을 사용한다면 그 상태와 별도 대조가 필요하다.
- 실제 RSS 가져오기, Discord 발송, Gemini 과금 호출, 운영 프로세스 시작·재시작은 하지 않았다.

운영 대조 시에는 키나 Webhook URL 대신 item ID, source ID, destination key, contentHash, POST/PATCH 구분, HTTP 상태, 모델 오류 코드만으로 먼저 추적하는 것을 권고한다. 현재 모델 usage에는 item 상관관계가 부족하므로 향후 item ID·전송 job ID를 추가하면 진단이 쉬워진다.

## 9. 권고 적용 순서

1. 환경 로드 통합과 키 상태 진단을 먼저 수정한다. 데이터 마이그레이션 없이 검증할 수 있는 가장 직접적인 번역 복구 작업이다.
2. 신규 전용/기존 수정/명시적 재전송 정책과 기존 소스의 이관 정책을 결정한다. backend-spec §4.4·§4.6·§4.7 및 frontend-spec의 옵션·모델 상태 표시 관련 변경안을 파일·항목 단위로 승인받는다.
3. 전송 상태 영속화와 목적지 세대·작업 구분을 추가한다. 기존 로그로 보수적으로 백필하고, 404/ID 미상 POST 폴백을 새 정책에 맞게 제거한다.
4. 번역 성공/실패 상태와 복구 경로, Gemini 어댑터 진단을 보완한다. 실패 캐시를 일괄 삭제해 모든 과거 항목을 재전송하는 방식은 사용하지 않는다.
5. 위 동작을 회귀 테스트로 고정한 후 scheduler·dispatcher의 책임을 작은 변경 단위로 분리한다. 파일 이동과 정책 변경을 한 번에 묶지 않는다.

추천 목표는 **새 RSS 항목은 현재 연결된 Discord 목적지로 보내고, 수정은 이미 발송한 메시지에만 적용하며, 번역 실패는 원문 전송과 별개로 관찰·복구할 수 있는 구조**다.
