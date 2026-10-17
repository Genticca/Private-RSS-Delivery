# AI 번역 API 사용량 절감 조사

조사일: 2026-10-16 (Asia/Seoul)

## 1. 결론과 우선순위

**현재 모델을 유지하면서 필요한 필드만 번역하고, 동일 원문 결과를 공유하며, 캐시 미스의 동시 중복 요청을 합치는 개선을 우선 권장한다.** API 요청 수와 토큰 사용량은 구분해서 줄여야 한다. 이미 있는 item별 재시도 캐시는 유지할 가치가 있다.

| 우선순위 | 개선 | API 요청 수 | 토큰 사용량 |
| --- | --- | --- | --- |
| P1 | 실제 사용하는 제목/본문만 번역 | 번역 대상이 없어지면 감소 | 미사용 필드 제외만큼 감소 |
| P1 | 필드별 성공 캐시를 항목·소스 간 공유 | 같은 입력의 중복 호출 제거 | 중복 입력/출력 제거 |
| P1 | 같은 캐시 키의 진행 중 요청 공유 | 동시 미스 중복 제거 | 같은 작업의 중복 제거 |
| P1 | 한국어/빈 문자열/고정 상태 문구의 로컬 처리 | 확실히 불필요한 요청 제거 | 해당 입력/출력 제거 |
| P1 | 타임아웃·보조 모델·실패 cooldown 조정 | 장애 때 중복/반복 호출 제한 | 중복 생성 제한 가능 |
| P2 | 뉴스용 입력 발췌·출력 예산 조정 | 대체로 동일 | 요청당 입력/출력 축소 |
| P2 | 뉴스 여러 건을 한 동기 생성 요청에 묶기 | 정상 처리 시 감소 | 공통 지시문 절약, 본문 비용은 남음 |
| P3 | provider context caching / 비동기 Batch API | 방식에 따라 다름 | 특정 조건에서 비용 절감 |

P1/P2는 이 프로젝트 코드에 대한 제안이다. 실제 절감률은 운영 데이터의 중복률·언어·템플릿 사용 비율에 따라 달라진다. 기본 로컬 DB의 `model_usage`는 0행이므로 몇 % 절감한다고 확정할 근거는 없다.

## 2. 현재 이미 하는 최적화와 부족한 부분

- `dispatcher/webhook.ts:130`에서 번역을 한 뒤 `:149`에서 목적지들을 순회한다. 현재는 웹훅 개수만큼 모델을 호출하지 않는다.
- `translator/translator.ts:153`은 item의 `translatedAt`이 있으면 재사용한다. 따라서 같은 item의 Discord 재시도에는 정상적으로 번역 호출을 줄인다.
- 전송 대상이 없는 경우에는 번역 전에 skip하고, 미리보기는 번역하지 않는다. historical 전송 방지와 함께 이 규칙을 유지한다.
- 서로 다른 item ID에는 같은 원문이어도 별도 캐시를 사용한다. 동일 뉴스가 다른 피드에 들어오면 중복 번역할 수 있다.
- `db/item.repository.ts:195`와 `:254`는 내용 갱신/재큐 시 제목·본문 번역 캐시를 함께 지운다. 제목이 같아도 본문 변경 때 다시 번역한다.
- 번역 입력은 항상 title+summary다. **`minimal.hbs`에는 summary 표시가 없는데도 본문 전체를 번역한다.**
- normalized summary는 최대 4,000자다. 뉴스/토론 프리셋은 번역된 summary를 각각 300/200자로 줄여 표시하지만 모델에는 긴 원문을 보낸다. incident 프리셋은 3,500자를 표시한다.
- 실패 후 반환한 원문에도 `translatedAt`을 기록한다. 호출을 줄이는 효과는 있지만 성공 번역과 구분하지 않으므로 키/서비스 복구 후에도 해당 item은 자동 복구되지 않는다.

## 3. 실제 표시 필드만 번역

첫 적용은 다음처럼 한정한다.

| 템플릿/용도 | 번역 범위 제안 |
| --- | --- |
| `minimal` | 제목만 |
| `news-article` | 제목 + 표시용 본문 발췌 |
| `link-discussion` | 제목 + 표시용 본문 발췌 |
| `incident-active` | 제목 + 최신 상태 본문. 장애 원인·복구 정보의 과도한 축약은 피함 |
| 사용자 템플릿 | 참조 필드를 안전하게 판정할 수 없으면 제목+본문 유지 |

템플릿 이름만 보고 필드를 결정하면 빌트인 편집/복제에서 오판할 수 있다. 실제 Handlebars AST를 읽어 필드를 보수적으로 판정하거나 명시적 번역 필드 설정을 제공한다. 동적 경로·lookup·객체 전달 등 불명확한 패턴은 전체 번역으로 돌아간다. 포럼의 자동 thread_name이 번역된 제목을 쓰는 것도 필드 요구에 포함한다.

본문 300자 표시가 원문 300자만 번역해도 같다는 뜻은 아니다. 언어별 길이가 다르고 문맥이 잘릴 수 있다. 뉴스에는 문장 경계의 발췌 길이/예산을 따로 정하고 실제 결과를 확인한다. 이를 위해 요약 AI를 한 번 더 호출하는 방식은 기본안에서 제외한다. CVE·버전·URL·부정 표현을 임의로 제거하지 않는다.

`maxOutputTokens=1200`은 현재 상한이며 항상 1200개를 사용하는 것은 아니다. 상한을 무조건 낮추면 잘림과 재요청을 늘릴 수 있다. 제목만/짧은 뉴스/장애 본문에 다른 예산을 적용하고, 잘림률과 실제 출력 토큰을 함께 본다.

## 4. 원문 기반 공유 캐시와 변경 필드만 번역

신규 `translation_cache`를 두어 **필드별 실제 번역 입력**을 키로 성공 결과를 저장하는 구성을 권장한다.

예시 키:

```text
sha256(JSON.stringify({
  policyVersion,
  targetLang,
  field,             // title 또는 summary
  contextProfile,    // 뉴스/장애 등 번역 문맥
  glossaryVersion,
  inputText          // 실제 요청할 원문/발췌
}))
```

필요한 메타데이터는 상태, 성공 번역문, 생성/최근 사용 시각, 실제 provider/model, 마지막 실패와 nextRetryAt 등이다. API 키는 환경 변수에만 두고 캐시에 저장하지 않는다.

- item ID·웹훅 URL·binding ID·delivery job ID를 번역 키에 넣지 않는다. 같은 입력을 여러 항목·목적지에서 공유한다.
- 모델 변경만으로 모든 과거 항목을 재번역하지 않는다. provider/model은 결과의 출처로 기록하고, 품질 정책을 바꾸려면 명시적인 policyVersion 갱신을 사용한다.
- normalization은 NFC, 줄바꿈 통일 등 의미를 보존하는 범위로 제한한다. 숫자·부정어·제품명·URL을 지우거나 유사 문장을 같은 결과로 취급하지 않는다.
- 제목이 같고 본문만 바뀌면 제목 캐시를 재사용하고 본문만 번역한다. 반대도 동일하다.
- **필드별 캐시가 필드별 API 요청을 뜻하지는 않는다.** 같은 item에서 미스인 제목·본문은 한 요청으로 묶어 현재 1회를 2회로 늘리지 않는다. 응답 스키마는 요청한 필드만 받고 캐시 결과와 병합하도록 바꾼다.
- 문맥에 따라 번역이 달라지는 짧은 표현은 contextProfile/용어집 버전으로 분리한다.

### 기존 contentHash를 번역 캐시 키로 쓰면 안 되는 이유

generic contentHash는 title+link이고 summary를 포함하지 않는다. incident contentHash는 stage+summary이고 title을 포함하지 않는다. 따라서 번역할 원문 전체의 동일성을 보장하지 않는다. 별도 translation key가 필요하다. 발송 변경 감지 규칙 자체를 번역 최적화 때문에 바꾸지 않는다.

앞서 제안한 발송 revision과도 역할이 다르다. 원문이 H1→H2→H1로 돌아오면 발송 revision은 1→2→3이어야 하지만, revision 3의 번역은 H1의 성공 결과를 재사용할 수 있다. **번역 캐시 재사용이 필요한 Discord PATCH를 생략하는 근거가 되어서는 안 된다.**

## 5. 동시 요청·실패·불필요한 번역 차단

동일 캐시 키에 진행 중인 Promise를 공유하는 single-flight를 둔다. 호출 직전 캐시를 다시 확인하고 성공 결과를 저장한 후 대기 작업에 전달한다. 현재 dispatcher는 직렬 처리라 동시 중복의 운영 발생을 확인한 것은 아니지만, 앞서 제안한 목적지별 job을 병렬 실행하면 필수적인 방어가 된다.

필드별로 빈 텍스트, 번역할 자연어가 없는 텍스트, 확실한 한국어는 로컬 규칙/설정으로 통과시킬 수 있다. 한글이 조금 있다는 이유만으로 영문 혼합 문장을 모두 건너뛰지 않는다. 불확실하면 번역한다. 언어 감지를 위해 별도 모델 API를 호출하면 절감 목적에 맞지 않는다. 알려진 incident stage의 한국어 표시는 이미 `stageLabel`의 결정적 매핑으로 처리한다.

실패 원문과 성공 캐시는 분리한다.

- 성공 번역은 재사용한다. 실패 상태에는 error/nextRetryAt/횟수를 기록한다.
- 이번 delivery job에서 원문으로 보내기로 했다면 그 payload를 고정해 Discord 재시도 때마다 모델을 다시 호출하지 않는다.
- 실패한 동일 번역 입력은 cooldown 동안 재요청하지 않는다. 인증 실패는 해당 키/설정이 수정될 때까지 호출을 제한하고, 429는 제공되는 재시도 정보를 따른다.
- cooldown이 끝났다는 이유로 이미 발송한 과거 item을 다시 pending으로 만들거나 새 POST하지 않는다. 번역 재시도와 발송 재시도는 분리한다.
- 일일 호출/토큰 예산과 보조 모델 호출 상한을 두면 장애 때 비용을 제한할 수 있다. 예산 소진 시 기존 원문 전송 정책과 일관되게 처리한다.

## 6. Gemini 타임아웃과 보조 모델

현재 공통 translator는 `AbortSignal`을 provider에 전달하지만 `providers/gemini.ts`는 SDK config에 넘기지 않는다. 모의 SDK HTTP 요청에서도 signal이 빠졌고, 주 요청을 완료시키지 않은 상태에서 fallback이 시작되는 것을 확인했다.

권고:

1. 설치된 SDK의 `GenerateContentConfig.abortSignal`에 공통 signal을 연결하고 transport timeout도 정렬한다.
2. 명확한 인증/과부하 오류와 성공 여부를 모르는 timeout을 구분한다. 제한 시간마다 무조건 보조 모델까지 호출하는 정책에는 총 요청 예산을 둔다.
3. 사용 가능한 캐시가 있으면 보조 모델 호출 전에 사용한다. 실패가 반복되는 provider는 일정 기간 호출을 제한한다.
4. 늦게 도착한 주 모델 결과가 더 최신 번역/발송 버전을 덮어쓰지 않도록 입력 키·revision 조건으로 저장한다.

설치 SDK `node_modules/@google/genai/dist/genai.d.ts:4470`은 AbortSignal이 클라이언트 취소이며 서버 요청의 취소/과금 방지를 보장하지 않는다고 명시한다. 따라서 signal 연결만으로 이미 시작된 생성 비용이 사라진다고 설명하지 않는다.

SDK의 재시도도 구현을 확인해야 한다. 설치된 1.52.0의 generateContent transport는 client `httpOptions.retryOptions`가 없으면 바로 fetch한다(`dist/node/index.mjs:13305`). 타입 주석의 기본 5회만 보고 현재 호출이 5배라고 판단하면 틀린다. 보조 모델·SDK retry·앱 retry가 중첩되지 않도록 실제 사용 경로에서 정책을 명시한다.

## 7. 묶음 번역·provider 기능의 적용 범위

### 짧은 동기 묶음 번역

실시간성이 덜 중요한 뉴스에는 같은 poll/tick의 캐시 미스 여러 건을 한 generateContent 요청으로 묶을 수 있다. 항목 ID/필드 ID를 붙이고 응답에서 정확히 대응시킨다. 가령 미스 5건을 한 요청에 넣으면 정상 처리 때 HTTP 호출은 5회에서 1회가 되지만, 본문/번역문 토큰이 1/5이 되는 것은 아니다. 절약은 주로 공통 지시문의 반복이다.

건수만 정하지 말고 전체 입력/출력 예산도 제한한다. 잘린 결과나 일부 누락은 성공한 항목을 캐시한 뒤 미완료 항목만 복구한다. 항목끼리 문장이 섞이는지 검증한다. 짧은 대기 창으로만 묶고 장애 공지는 추가 지연 없이 처리하는 기본안을 권장한다.

현재의 JSON MIME 설정 외에 필수 필드/ID 스키마를 적용하면 형식 오류를 줄이는 데 도움이 된다. 값의 정확성은 별도로 검증해야 한다. 현재 모델은 structured output을 지원하며 설치 SDK에는 `responseJsonSchema`가 있다. [Gemini 3.1 Flash-Lite 공식 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite), [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)

### Gemini 비동기 Batch API

Google은 비긴급 대량 작업용 비동기 Batch에 표준 비용의 50%와 24시간 목표 처리 시간을 안내한다. 위의 여러 항목을 한 prompt에 넣는 동기 요청과는 다른 기능이다. 즉시 전달해야 하는 장애 알림에는 기본 적용하지 않고, 명시적으로 지연을 허용한 대량 작업에만 검토한다. [공식 Batch API 문서](https://ai.google.dev/gemini-api/docs/batch-api)

### Provider context caching / thinking

provider context caching은 반복 입력 prefix의 처리 비용을 줄이는 기능이며, 번역 결과를 저장해 API 호출 자체를 생략하는 로컬 캐시와 다르다. 공식 문서에는 모델별 최소 입력량과 prefix 조건이 있다. 짧은 번역 지시문을 캐시하려고 불필요한 텍스트를 늘리지 않는다. 현재 모델 페이지는 캐시 지원을 명시하지만 현재 caching 가이드의 최소량 표에는 이 모델 값이 없으므로 정확한 수치를 추측하지 않는다. [Context caching](https://ai.google.dev/gemini-api/docs/caching)

thinking 강도를 낮추는 옵션은 실제 설정 모델이 지원하는 범위와 기본값을 확인한 후 품질·실제 thought 토큰을 비교하는 후순위 실험이다. 현재 설정하지 않았다는 이유만으로 높은 reasoning 비용을 사용한다고 단정하지 않는다. 단순 번역용이라는 이유로 모델/SDK를 즉시 교체할 필요도 없다.

## 8. 구현 경계와 앞선 발송 개선안 연결

| 위치 | 제안 |
| --- | --- |
| `domain/translation/` 신규 | 의미 보존 입력 정리, 필드 선택, translation key, 로컬 통과 판정 |
| `db/translation-cache.repository.ts` 신규 | 성공 결과·실패 cooldown 저장. 새 순번 migration 추가 |
| `translator/translation-cache.service.ts` 신규 | 공유 캐시·single-flight·필드 미스 병합 |
| `translator/translator.ts` | 요청 예산·보조 모델 정책, 실패와 성공 결과 분리 |
| `translator/prompt.ts`, `types.ts` | 부분 필드/묶음 ID의 입력·응답 계약 |
| `translator/providers/gemini.ts` | abortSignal·응답 schema·usage의 추가 필드 연결 |
| `dispatcher`와 새 delivery jobs | 발송 자격/연결을 확인한 작업만 번역. 번역 키/결과를 여러 목적지에서 공유 |
| `db/item.repository.ts` | item revision 조건부 캐시 갱신, 필드 변경만으로 공유 성공 캐시를 삭제하지 않음 |
| 모델 사용량·관리 화면 | 실제 API 요청·캐시 hit·로컬 skip·fallback·잘림·토큰을 구분 |

발송 상태를 목적지별로 분리하더라도 **번역을 목적지마다 다시 수행하지 않는다.** 번역은 원문 입력 키별 공유 작업이고, Discord 발송은 item × 목적지 × 연결 세대별 작업이다.

기존 `model_usage`에는 disabled/missing-key도 행으로 남으므로 행 수가 실제 HTTP 호출 수가 아니다. actual request sent 여부와 provider 시도 수를 구분하고, Gemini의 cached/thoughts/total token 정보도 확인 가능한 경우 보관한다. 현재 prompt/candidates token만으로 모든 비용을 확정하지 않는다. API 호출을 생략한 캐시 hit/로컬 skip도 별도 집계해야 절감 효과를 검증할 수 있다.

## 9. 적용 순서와 검증

1. 번역 요청/캐시 hit·필드별 입력 길이·실제 토큰을 구분해 측정한다.
2. minimal 제목 전용 및 로컬 skip, 성공 캐시 공유와 single-flight를 적용한다.
3. 실패 상태/cooldown·Gemini signal·보조 모델 예산을 정비한다. 기존 원문 delivery payload 재사용은 유지한다.
4. 제목·본문 부분 갱신을 적용하고 앞선 목적지별 발송 작업과 연결한다.
5. 뉴스 본문 발췌/동기 묶음은 표본 번역 품질·잘림·지연을 비교한 뒤 켠다.

필수 테스트: 같은 item 재시도 0추가 호출, 서로 다른 item의 동일 입력 1회 공유, 동일 키 동시 요청 1회, 제목 불변/본문 변경 시 제목 재사용, minimal 본문 미전송, 언어 혼합 오판 방지, 번역 키와 contentHash 분리, 실패 cooldown과 성공 캐시 구분, 오래된 응답의 최신 revision 덮어쓰기 방지, 묶음 일부 실패의 성공 결과 재호출 방지, 취소된 delivery job의 번역 0회, 번역 복구가 과거 새 POST를 만들지 않음.

실제 절감률은 정상 번역률·지연·내용 보존과 함께 판단한다. 번역 실패를 계속 원문으로 고정하거나 보조 모델을 전부 꺼서 호출만 줄인 결과를 성공적인 번역 절감으로 취급하지 않는다.

## 10. 이번 조사 검증과 문서 변경 범위

`2026-10-16-translation-usage-repro.mjs`는 현재 source를 로드하며 번역기와 SDK fetch를 모의 처리한다. 6개 시나리오의 assertion을 통과했다.

| 확인 | 결과 |
| --- | --- |
| 같은 item 반복 vs 다른 item 동일 원문 | 같은 item은 1회 유지, 서로 다른 2개 item은 총 2회 호출 |
| 동일 입력 동시 캐시 미스 | 서비스 수준에서 2회 호출. 현재 직렬 dispatcher의 운영 중복을 입증한 것은 아님 |
| 번역 실패 원문 | translatedAt이 설정되고 다음 실행에서 재번역 안 함 |
| minimal 표시 | 본문 표시가 없는데 1,520자 본문을 번역기로 전달 |
| contentHash | generic summary 변경/incident title 변경을 모두 포함하지 않음 |
| Gemini timeout | SDK HTTP 요청에 signal 없음. 주 요청 미완료 상태에서 fallback 1회 시작 |

실제 외부 API/과금 호출은 0회이며 운영 DB는 읽기 전용 집계만 했다. 앱 코드·기존 테스트·의존성·마이그레이션은 변경하지 않았다. 앞서 확인한 Windows 네이티브 의존성 문제로 기존 Vitest는 실행하지 않았다. 제안 모델의 번역 품질과 실제 비용 절감률은 아직 측정하지 않았다.

보호 문서 변경 제안은 backend-spec §4.7(필드/공유 캐시·실패 상태·timeout·보조 호출·버전), §4.2 및 API 계약(translation cache/usage), §4.6(발송 작업과 번역 공유), frontend-spec 모델 설정/사용량 및 번역 안내다. AGENTS.md의 파일·항목별 명시 승인 규칙에 따라 이 문서들은 수정하지 않았다. 새 migration 번호는 앞선 발송 개선안과 함께 확정해야 한다.
