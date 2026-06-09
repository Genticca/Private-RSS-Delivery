# Frontend 명세 (Gemini 트랙)

> 작성: 2026-05-28 · 상위: [README.md](../README.md) · 대칭: [backend-spec.md](./backend-spec.md)
> 갱신: 2026-06-09 — D24 채널 모델 반영
> 본 문서는 **프런트엔드(`src/resources/templates/**`, `src/resources/presets/**`)** 를 구현 직전 수준으로 정의한다.
> **2트랙 분담**: Backend = Codex / **Frontend = Gemini**(이 문서). 경계는 §1.

---

## 1. 받는 입력 (Backend 계약) & 원칙

Gemini는 **세 가지 고정 계약**만 신뢰하고 작업한다(backend-spec §1·§7):
1. **페이지 view-model 키** — Codex가 `reply.view(page, model)`로 넘기는 `model`(§4 각 페이지에 명시).
2. **JSON/SSE API req/resp** — 데이터·스트림(JSON·SSE)은 app.js가 `fetch`·`EventSource`로 호출(HTML partial mutation은 htmx; C-1, backend-spec §3.1).
3. **프리셋 Handlebars 변수 컨텍스트** — `{{item.*}}`/`{{source.*}}`(설계서 §10, §7).

### 스택 (D5~D8, D13)
| 도구 | 용도 |
|------|------|
| **Handlebars (서버 렌더)** | 모든 페이지·partial. **React 아님**(D6) |
| **htmx** | 폼 제출·토글·행 swap·폴링(부분 갱신) |
| **CodeMirror** | 프리셋 JSON 편집(template-editor) |
| **SSE (EventSource)** | Logs 라이브 tail(D13, 단방향) |

### 절대 원칙
- **React/Vite 금지**(D6) — SPA 빌드 없음. 페이지는 서버가 렌더, 동적성은 htmx.
- **다크모드 금지** — UI에 다크모드 추가하지 않는다(명시 거부).
- **WebSocket 금지**(D7) — 실시간은 SSE 단방향만.
- **렌더 실행은 Backend** — 프리셋 .hbs는 Gemini가 *작성*하지만 Handlebars *실행*은 Codex(D8). 미리보기도 서버 왕복(D15).
- **로그인/인증 화면 없음** — 접근 제어는 **SSH 프록시 + loopback**이 담당(backend §4.10). 모든 사용자는 신뢰된 단일 운영자로 가정 → **로그인·세션·비밀번호·인증 토큰 UI를 만들지 않는다.** UI는 `localhost:port`로 서빙되고 htmx·SSE·CodeMirror는 SSH 터널 위에서 그대로 동작(전송 암호화는 SSH가 처리하므로 프런트는 신경 쓸 것 없음).

---

## 2. 디렉터리 구조

```
src/resources/
├── templates/
│   ├── layouts/
│   │   └── main.hbs          # 공통 레이아웃 (head · 사이드바 nav 인라인 · {{{body}}} · flash)
│   ├── partials/             # nav.hbs 없음 — nav는 main.hbs 사이드바에 인라인
│   │   ├── source-row.hbs    # htmx swap 단위(행)
│   │   ├── group-row.hbs
│   │   ├── template-row.hbs  # 템플릿 1행 swap 단위
│   │   ├── log-entry.hbs     # 로그 1줄 마크업 참조(app.js 클라 렌더)
│   │   ├── status-badge.hbs  # ready/missing-key/invalid-key/disabled, 폴 결과
│   │   ├── import-preview.hbs # Import dry-run 미리보기 fragment(§4.2)
│   │   └── flash.hbs         # 알림(OOB swap)
│   ├── pages/
│   │   ├── dashboard.hbs  sources.hbs  source-form.hbs
│   │   ├── groups.hbs     templates.hbs  template-editor.hbs
│   │   └── logs.hbs       model.hbs
│   └── assets/
│       ├── css/
│       │   ├── app.css        # 라이트 단일 테마(다크모드 없음)
│       │   └── codemirror.css # vendored
│       ├── fonts/             # Inter.woff2 · Outfit.woff2 (vendored @font-face — 외부 CDN 금지 §11)
│       └── js/
│           ├── htmx.min.js    # vendored
│           ├── codemirror.js  # vendored
│           └── app.js         # CodeMirror init · SSE · preview debounce
└── presets/                  # Discord 프리셋 .hbs 4종 (§9) — 콘텐츠 템플릿
    ├── incident-active.hbs   news-article.hbs
    ├── link-discussion.hbs
    └── minimal.hbs
```
> `templates/`(관리 UI 뷰)와 `presets/`(Discord 메시지 템플릿)는 성격이 다르다. 둘 다 Gemini 소유이나, presets는 §9 변수 계약을 따르는 **콘텐츠 템플릿**.
> 빌드: copy 스텝으로 `dist/resources/{templates,presets}`. 자산은 `GET /assets/*`(@fastify/static)로 서빙.

---

## 3. 레이아웃 & 공통 partial

### layouts/main.hbs
- `<head>`: `app.css`, `htmx.min.js`, (필요 페이지만) codemirror·app.js.
- **사이드바 nav 인라인**(`<aside class="sidebar">` + 메뉴 4개: 소스 관리 `/` · 메시지 템플릿 `/templates` · 시스템 로그 `/logs` · AI 모델 설정 `/model`) + `<main>{{{body}}}</main>` + `{{> flash}}`(OOB 타깃 `#flash`). **별도 `nav.hbs` partial 없음** — nav는 main.hbs에 인라인.
- 메타: 루프백 내부 도구(SSH 프록시 접근) → SEO 태그·인증 헤더 처리·로그인 리다이렉트 불필요. nav에 로그아웃/계정 메뉴도 없음.

### partials (htmx swap 단위)
- **source-row.hbs** — 소스 1행. 토글/삭제/폴 버튼 포함. 행 단위 교체에 재사용.
- **group-row.hbs / template-row.hbs** — 그룹·템플릿 1행(행 단위 swap, source-row와 동형). group-row는 각 셀이 인라인 `<input form="group-update-{id}">`인 행-편집 폼.
- **log-entry.hbs** — 로그 1줄의 **마크업 참조**. SSE·`/api/logs`는 **JSON**을 반환하므로 app.js가 이 모양으로 **클라이언트 렌더**해 prepend(§4.7·§8 — 로그 스트림은 서버 HTML이 아니라 JSON+클라 렌더로 고정; D8 서버 렌더 원칙은 프리셋·미리보기 한정).
- **status-badge.hbs** — `ready`🟢 / `missing-key`🟡 / `invalid-key`🔴 / `disabled`⚪ / 폴 결과(`200`/`304`/`error`).
- **flash.hbs** — 성공/오류 알림. 컨트롤러가 `hx-swap-oob`로 갱신 가능하게 `id="flash"`.
- **import-preview.hbs** — Import dry-run 미리보기 fragment(§4.2, D21): 추가 N·충돌 N·SSRF 차단 N·templateRef 미해결 N·**웹훅 재입력 필요 N** 요약 + `skip`/`overwrite` 라디오. `#import-preview`에 swap.
- **빈 상태(empty-state)** — 모든 목록 테이블(소스·그룹·템플릿·모델 사용량·대시보드)은 데이터 0건일 때 `{{else}}`(서버 렌더) 또는 app.js(JS 갱신 경로)로 "아직 …이 없습니다 + 다음 행동 안내" 행을 렌더한다(빈 표 방지).

---

## 4. 페이지별 상세 (8개)

각 페이지: **(view-model) / 레이아웃 / htmx 상호작용 / 핵심 UI**.

### 4.1 dashboard.hbs — `GET /`
- **view-model**: `{sources:[{id,name,enabled,lastOutcome,profile}], counts}`
- 소스 상태 요약 카드 + 최근 폴 결과 배지. `/sources`·`/logs` 링크.
- 상태 영역 주기 갱신(선택): `/api/sources`는 **JSON**이라 htmx `hx-get` 직접 swap 대상이 아니다 → **app.js가 `/api/sources`를 fetch해 상태 영역을 클라이언트 렌더**(30s 주기는 app.js setInterval, 선택; 원시 JSON을 DOM에 꽂지 않음 — §5·C-1).

### 4.2 sources.hbs — `GET /sources`
- **view-model**: `{sources, groups, profiles}`
- 테이블(7열): 소스 이름 · 피드 URL · 파싱 프로필 · 소속 그룹 · 수집 상태 · **번역**(translate ON이면 배지) · 작업(편집/지금폴/**테스트 전송**/실패 재시도/삭제). ※ 소스는 자체 webhook을 갖지 않으므로(D24, 전송 채널은 그룹) **개별 웹훅 표시 컬럼 없음**.
- htmx:
  - 토글 `hx-patch="/api/sources/{id}/enabled"` → `{> source-row}` swap.
  - 지금폴 `hx-post="/api/sources/{id}/poll"` `hx-swap="none"` → OOB `#flash`만 갱신(행 변화 없음; 응답=`200`+OOB flash partial, C-1). 재큐 `retry-failed`·**테스트 전송 `hx-post="/api/sources/{id}/test"`**도 동일 패턴(OOB `#flash` 성공/실패 알림).
  - 삭제 `hx-delete="/api/sources/{id}" hx-confirm="삭제할까요?" hx-target="closest tr" hx-swap="delete"` → `204` 성공 시 htmx가 타깃 행 element 제거(204는 본문이 없어 swap 없음 — `delete`가 행 제거).
  - "+ 소스 추가" → `/sources/new`(`#source-modal-mount`에 htmx로 주입되는 **모달** — 풀페이지 라우트 겸용).
- **백업/가져오기 섹션(D21 Export/Import)** — 소스·그룹을 함께 다루므로 이 페이지에 배치(**view-model 변경 없음** — export는 링크, import는 fragment 라우트가 채움):
  - **내보내기**: `<a href="/api/export" download>설정 내보내기(.json)</a>` — 브라우저 네이티브 다운로드라 **htmx 대상 아님**(`Content-Disposition: attachment`는 서버가 부여). 안내문 "웹훅 URL은 보안상 제외 — 가져오기 후 각 그룹에 재입력해야 전송됩니다"(webhook은 그룹만 보유 — D24).
  - **가져오기(2단계)**: ① `<form hx-post="/api/import/dry-run" hx-encoding="multipart/form-data" hx-target="#import-preview">` + `<input type="file" name="file" accept="application/json">` "미리보기" → `{> import-preview}` swap. ② commit `<form hx-post="/api/import" hx-encoding="multipart/form-data">`(**파일 재첨부** + `mode` hidden — dry-run은 stateless) → `204 + HX-Redirect: /sources` + flash "가져오기 완료: 소스 N·그룹 N, 웹훅 N건 재입력 필요". import된 그룹의 빈 webhook은 **기존 "전송 대상 없음" 경고(§4.3) 재사용**으로 재입력 유도(신규 패턴 아님; webhook은 그룹만 보유 — D24).

### 4.3 source-form.hbs — `GET /sources/:id` · `/sources/new`
- **view-model**: `{source, groups, templates, profiles}` (※ `source`=`SourceDto`[D22 전송 옵션 포함, 소스 webhook URL 필드 없음 — D24]; `groups[].selected`[현재 배정 체크]·`source.hasAnyDestination`[소속 그룹 중 webhook 보유 그룹 유무 — group-only, D24]는 `web.ts`가 주입 — backend-spec §3.2)
- 폼 필드:
  - `feedUrl`, `name`
  - `profile` 드롭다운: `auto | incident-io | atlassian-statuspage | generic` (순서 고정, 수동 override, D12)
  - `pollIntervalSeconds`(기본 300)
  - `translate` 토글(ON=한국어 번역, A4)
  - `templateId` 프리셋 선택(소스 전용, A3)
  - webhook 표시용 override: `webhookName` / `webhookAvatarUrl`(소속 그룹 webhook에 얹는 표시 이름/아바타). **소스는 자체 webhook URL을 갖지 않는다**(D24, 전송 채널은 그룹) — 소스 폼에 **webhook URL 입력란·"웹훅 지우기" 체크박스 없음**.
  - `groupIds` 다중 선택(N:M, **최소 1개 필수** — 0개면 저장 거부, `validation_error`로 필드오류 인라인 표시(§5): 필드 `groupIds` "최소 1개 이상 선택하세요.")
  - **〔Discord 전송 옵션 — D22, 전부 source 소유; backend-spec §3.1 SourceDto·§4.6〕**
    - **조용히 보내기** `silent` 토글 — ON=알림 억제(Discord `flags` 4096). 메시지는 전송되나 푸시/데스크톱 알림이 안 울림.
    - **멘션** `mentionRoleIds`·`mentionUserIds`(Discord 역할/사용자 **ID 쉼표구분** 입력) + `mentionEveryone`·`mentionHere`(@here, 0012) 토글. ※ 멘션은 backend가 **본문(content)** 에 주입해 핑한다 — **임베드엔 핑 안 됨**(프리셋과 무관). @here/@everyone은 `allowed_mentions.parse=['everyone']` 공통 토큰.
    - **Forum 전송** `threadId`(기존 스레드)·`threadName`(새 스레드 생성)·`appliedTags`(포럼 태그, 쉼표구분) — **포럼/미디어 채널 대상**일 때만 의미.
    - **메시지 수정** `editInPlace` 토글 — ON=콘텐츠 변경 시 새 메시지 대신 **원본 편집**(Status Page 상태 업데이트용).
    - 표현: bool 토글 4종(`silent`/`mentionEveryone`/`mentionHere`/`editInPlace`), ID·태그는 쉼표구분 텍스트. 값은 `SourceDto`로 prefill. 멘션은 `<details>`(역할·사용자·@everyone·@here)로, thread/forum 필드는 **채널 유형(일반/스레드/포럼) 셀렉터**로 점진 노출. **삭제·웹훅관리 UI 없음**(미구현).
- htmx: 제출 `hx-post`(신규)/`hx-patch`(수정) → 성공 시 204 + `HX-Redirect: /sources` 또는 partial 폼(validation 오류 시 인라인 표시 포함).
- 안내: **선택한 그룹 중 webhook 보유 그룹이 없으면**(`source.hasAnyDestination`=false, group-only) "전송 대상 없음" 경고 표시.

### 4.4 groups.hbs — `GET /groups`
- **view-model**: `{groups}`
- 테이블: name · webhookUrl(**서버 제공 `maskedWebhookUrl` 표시** — 클라 마스킹 아님, 원문 비노출) · webhookName · **avatar 미리보기(원형 썸네일 `.avatar-preview`)**. CRUD htmx + 행별 **테스트 전송**(`hx-post="/api/groups/{id}/test"`, OOB `#flash`). **그룹이 전송 채널**이므로 webhook(`webhookUrl`/`webhookName`/`webhookAvatarUrl`)은 **그룹만 보유**한다(D24). **그룹 webhook은 optional** — 비면 *전송 대상 없음*(§4.3 경고 재사용; import 직후 상태), 빈 webhook 그룹도 정상 생성·저장된다. 수정 시 webhook 변경 의미론: **빈칸=유지 / '웹훅 지우기' 체크(`clearWebhook`)=해제(NULL) / 새 URL=교체**(빈칸만으로는 절대 해제되지 않음).
- 그룹엔 **프리셋 필드 없음**(A3 — 프리셋은 소스 전용).

### 4.5 templates.hbs — `GET /templates`
- **view-model**: `{templates}`
- 목록 표시: **label**(사람 표시명) + `is_builtin` 배지. 액션: 편집(→editor) / 복제 / 삭제(빌트인 삭제 불가). **내장 템플릿 label은 한국어**(장애 / 뉴스 기사 / 링크·토론 / 심플; 슬러그 `name`은 불변).
- 신규 등록·복제: **`label`만 입력**한다 — **식별자(`name`)는 시스템이 자동 부여**(사용자 입력 없음, slugify; 한글 라벨이면 `custom` 기반). 복제도 새 label만 받는다.
- 빌트인 편집 시도 → "복제 후 편집" 유도. **모든 템플릿의 `name`(식별자)은 시스템 관리**(read-only, 시스템 예약)이며 사용자는 label만 지정한다.

### 4.6 template-editor.hbs — `GET /templates/:id` ★가장 복잡
- **view-model**: `{template, presetVars, sources, needsCodeMirror}`(needsCodeMirror=`true` 자산 로드 플래그, web.ts 주입; presetVars = 사용 가능 변수 목록 도움말 — 항목은 `{name, description?}`이고 **`description`은 선택**: backend 미제공 시 생략돼 툴팁이 빈 값이어도 무해(graceful, 강제 아님); sources = `{id,name}[]` live 모드용 소스 목록, 서버 렌더)
- 좌: **CodeMirror**(JSON 모드, `template.body`). 우: **미리보기 패널**(`#preview`).
- 상단: **미리보기 모드** 라디오 `sample`/`live` + (live면) 소스 선택 드롭다운.
- 동작(app.js):
  1. CodeMirror change → **300ms debounce** → `POST /api/preview {templateBody, sourceId?, mode}`.
  2. **sample 모드**: 미선택 시 내장 합성 item, 선택 시 지정 sourceId의 최근 item(0개면 합성 fallback)으로 렌더. **live 모드**: 지정 sourceId(필수)를 1회 fetch→정규화→렌더(번역 미적용, D14). sourceId 미선택 또는 폴 실패 시 "소스 선택 후 다시" 안내.
  3. 응답 `{ok,payload}` → 임베드 렌더 미리보기 swap / `{errors:[{stage:'fetch'|'render'|'validate', message, path?}]}` → 오류 표시(stage별 색/아이콘 구분, ajv 한도·HTTP 실패 등).
  4. 저장 `hx-patch="/api/templates/{id}"`(body) → flash.
- 변수 도움말: `presetVars`를 사이드에 칩으로(클릭 시 에디터 삽입).

### 4.7 logs.hbs — `GET /logs`  (D13 SSE)
- **view-model**: `{}`
- app.js: `new EventSource('/api/logs/stream')` → 이벤트(delivery/fetch)마다 **JSON `data`를 받아 app.js가 log row DOM을 클라이언트에서 생성**해 리스트 상단에 prepend(**서버는 SSE로 JSON만 보냄 — HTML fragment 아님**, backend §3.1; `log-entry.hbs`는 그 행의 참조 마크업).
- 필터 토글(delivery/fetch/error), 자동스크롤 일시정지. 연결 끊기면 자동 재연결.
- 과거 로그 더보기: `/api/logs?type=delivery|fetch`(+`before`·`limit`)는 **JSON**이라 htmx `hx-get` 직접 swap 대상이 아니다 → **app.js가 fetch해 행을 클라이언트 렌더·append**(cursor-based pagination — **서버는 DESC(최신→과거) 반환**, `?before` 커서로 과거 페이지 로드). **delivery_log·fetch_log는 테이블별 독립 커서/id**(전역 시퀀스 아님, R5; C-2: `?type=delivery|fetch` 분리·type별 `nextBefore` 단일 id 커서) → 필터별로 `before` 커서를 분리 관리. **라이브는 SSE(§8) — 별도 경로**(SSE 백필은 ASC, 라이브 append). *서버 반환 순서와 무관하게 클라 표시는 이 페이지가 정함(최신이 위, 더보기는 과거를 아래로 이어붙임).*
- usage 표(model 사용량): `/api/model/usage`(JSON envelope `{items,nextBefore}`)는 htmx `hx-get` 직접 swap 대상이 아니다 → **app.js가 fetch해 클라이언트 렌더**(폴 또는 더보기, 동일 커서 페이지네이션 패턴).

### 4.8 model.hbs — `GET /model`  (§12)
- **view-model**: `{config, status, usage, statusGuidance}`(statusGuidance=missing-key/invalid-key 안내 행, web.ts 주입 — backend-spec §3.2)
- 설정 폼(role별 primary/fallback): `provider`(gemini/nvidia-nim) · `model` · `enabled`. **targetLang은 read-only**(전역 고정 값 ko, 편집 불가 명시). **`promptLogMaxBytes`**(전역, 기본 32768 — `prompt_log` 저장 상한, 편집 가능). **API Key 입력란 없음** — 대신 `status` 배지(`ready`/`missing-key`/`invalid-key`/`disabled`)로 env 키 상태를 표시.
- `missing-key`면 "`PRIMARY_MODEL_API_KEY`를 .env에 설정 후 재시작" 안내. `invalid-key`면 provider와 env 키 값을 함께 교체하도록 안내.
- 사용량 표: `/api/model/usage`(JSON envelope `{items,nextBefore}`)는 htmx `hx-get` 직접 swap 대상이 아니다 → **app.js가 fetch해 클라이언트 렌더**(10s 주기 폴링은 app.js setInterval, D13). 토큰·지연·error 컬럼.
- 제출 `hx-patch="/api/model/config"`.

---

## 5. htmx 패턴 (공통 규약)
- **htmx=HTML / JSON=app.js (C-1)**: htmx가 직접 swap하는 응답은 **HTML만**(mutation: partial/204+HX-Redirect, 검증오류: 400 HTML fragment). **JSON 데이터 라우트(목록·logs·usage·dashboard 갱신)는 htmx가 아니라 app.js fetch+클라 렌더**로 표시 — 원시 JSON을 DOM에 swap하지 않는다.
- **클라 렌더 라벨 = 서버 표기 일치**: app.js가 클라이언트 렌더하는 행·카운트·배지의 **라벨·텍스트는 서버 렌더(한국어)와 동일 표기**를 쓴다. 주기 갱신(dashboard 30s·usage 10s 등) 후 라벨이 영어 등으로 바뀌어 서버/클라 표기가 어긋나면 안 된다.
- **부분 갱신**: 응답은 교체할 partial HTML 조각(전체 페이지 X). 컨트롤러가 `{> source-row}` 등 partial 렌더.
- **swap 타깃**: `hx-target`/`hx-swap="outerHTML"`(행 교체), **DELETE는 `hx-swap="delete"`**(응답 `204`엔 본문이 없어 타깃 행 element를 제거 — backend §3.1), prepend(로그).
- **확인**: 파괴적 액션 `hx-confirm`.
- **로딩 표시**: `hx-indicator`(스피너 partial).
- **flash(OOB)**: 어떤 응답이든 `<div id="flash" hx-swap-oob="true">`로 알림 갱신.
- **응답 형태 통일(R5)**: mutation 라우트(Sources·Groups·Templates·Model)는 성공 시 **partial HTML**(행 swap 등) 또는 **204 + `HX-Redirect`** 로 일관 응답한다.
- **에러**: **검증 실패(400 + `fields` envelope)는 flash가 아니라 해당 폼 위 인라인 fragment로 표시**(필드별 오류를 폼에 직접 swap). 그 외 4xx/5xx(서버 오류·권한 등)만 `htmx:responseError`에서 flash 표시(app.js 전역 핸들러).
- **파일 업로드(Import, D21)**: `<form hx-post hx-encoding="multipart/form-data">` + `<input type="file">`로 htmx가 multipart 전송 — **app.js 보조 불요**(CodeMirror·SSE 같은 비-htmx 케이스가 아님). 응답은 partial(dry-run 미리보기) 또는 204+HX-Redirect(commit).

---

## 6. CodeMirror 통합 (app.js)
- 대상: template-editor의 JSON 에디터 1곳.
- 설정: JSON 모드, 괄호 매칭, lint(JSON 구문) — **구문 검증은 클라(JSON.parse)로 충분**, 스키마/한도는 서버 ajv(미리보기 응답)에서.
- 미리보기 트리거: 에디터 change 이벤트 → debounce(300ms) → fetch. CodeMirror는 native input이 아니므로 **htmx가 아닌 app.js가 직접 fetch**(htmx는 폼·버튼에만).
- 저장 시 현재 에디터 내용을 hidden input/JS로 PATCH 본문에 실어 전송.

## 7. Preview 흐름 (D8/D14/D15)
```
CodeMirror 편집 → 300ms debounce → POST /api/preview {templateBody, sourceId?, mode}
  mode=sample : 서버 내장 샘플 item으로 렌더
  mode=live   : 서버가 소스 1회 fetch→정규화한 실제 item으로 렌더 (번역 미적용, D14)
→ 응답 {ok,payload} 임베드 미리보기 / {errors} 한도·구문 오류
```
- 클라가 직접 치환/렌더하지 않음 — **렌더는 서버 단일 경로**(D8, drift 방지). 미리보기엔 **번역 미적용**(D14).

## 8. SSE Logs (app.js)
- **Named Event 구독**: `EventSource('/api/logs/stream')`에서 `event: 'delivery'` 또는 `event: 'fetch'`로 수신(설계서 §3.1 정의).
  - 각 메시지: `id: <단조 증가 정수>` + `data: <JSON>` (data 스키마는 backend-spec §3.1 명시). **id는 테이블별 독립 시퀀스**(delivery_log·fetch_log 각각, 전역 시퀀스 아님 — R5)이므로 백필 커서는 event type별로 따로 추적한다.
  - **백필(과거)**: **ASC 정렬(과거→최신)** — SSE 백필 한정(REST 더보기는 DESC, §4.7), last id 이후 라이브와 중복 제거(`?before` 커서 이용, 테이블별). *서버 반환 순서이며, 클라 표시 순서는 §4.7이 정함.*
  - **연결 초과**: 429/503 응답 → 클라 재연결 대기(지수 백오프).
- `onmessage` → JSON 파싱 → **app.js의 클라이언트 log row 템플릿**으로 DOM 생성·prepend(**SSE·`/api/logs` 모두 JSON 반환 — 서버 HTML fragment 아님**, 한 방식으로 고정), **event type과 data 필드로 색/아이콘 구분**(delivery 녹색·빨강·주황 vs fetch 파랑).
- `onerror` → 지수 백오프 재연결(일반 404/5xx 미처리, 429/503만 특별 대기). 페이지 이탈 시 `close()`.

---

## 9. 프리셋 .hbs 4종 (presets/) — 콘텐츠 템플릿

Discord webhook payload **JSON을 만드는 Handlebars 템플릿**. 변수는 §1-③ 계약(`{{item.*}}`/`{{source.*}}`), 헬퍼 `truncate/stageColor/stageLabel/eq/json`. (실행은 Codex 렌더러)

> **〔D22〕 멘션·silent·forum thread·editInPlace는 프리셋 변수가 아니라 source 전송 설정**이다 — **프리셋 .hbs에 넣지 마라**(멘션은 backend가 `content`로 주입, 임베드 아님; silent는 `flags`, forum은 URL·body로 backend가 주입). 프리셋은 기존 `{{item.*}}`/`{{source.*}}` 계약만 유지한다.

> **JSON 안 텍스트 값은 반드시 `{{json ...}}`로 보간한다**(바깥 따옴표 없음 — 헬퍼가 따옴표 포함 JSON 리터럴을 `Handlebars.SafeString`으로 출력; 설계서 §10·C1). 생값 `"{{item.summary}}"`는 따옴표·개행·백슬래시가 든 텍스트에서 JSON을 깨뜨린다. `color` 등 숫자 리터럴만 예외(숫자는 JSON 파괴 문자 없음). URL도 `{{json item.commentsUrl}}`로 보간한다(생값 보간 — 마크다운 링크 미사용).

**incident-active.hbs** — 단일 incident 프리셋(label "장애"). 색은 `stageColor`가 stage별로(진행중 빨강 ↔ 해결 초록) 칠하고, 진행 단계는 `stageLabel`이 한국어로 표시한다. 별도 resolved 프리셋은 없다(2026-06-02 통합, README §0/§10).
```hbs
{ "embeds": [{
  "title": {{json item.title}}, "url": {{json item.link}},
  "description": {{json (truncate item.summary 3500)}}, "color": {{stageColor item.incidentStage}},
  "fields": [
    { "name": "진행 단계", "value": {{stageLabel item.incidentStage}}, "inline": true },
    { "name": "업데이트", "value": {{json item.publishedAtFormatted}}, "inline": true }
  ],
  "footer": { "text": {{json source.name}} }
}] }
```

**news-article.hbs** (보안뉴스·기술개발·보안위협) — 단순형(title·summary·footer).
<!-- author/image는 계약 변수로 사용 가능하나 현행 시드 프리셋은 미사용(의도된 단순화). 보강 시 {{#if item.author}}"author":{…}{{/if}}·{{#if item.image}}"thumbnail":{…}{{/if}} 패턴. -->
```hbs
{ "embeds": [{
  "title": {{json item.title}}, "url": {{json item.link}},
  "description": {{json (truncate item.summary 300)}}, "color": 5793266,
  "footer": { "text": {{json source.name}} }
}] }
```
**link-discussion.hbs** (HN/GeekNews) — `댓글` field에 토론 URL을 생값으로.
<!-- fields 배열은 항상 출력; commentsUrl 없으면 빈 배열([]). field명 "댓글", value=raw URL({{json item.commentsUrl}}), inline:false — 마크다운 링크 아님. -->
```hbs
{ "embeds": [{
  "title": {{json item.title}}, "url": {{json item.link}},
  "description": {{json (truncate item.summary 200)}}, "color": 16737095,
  "fields": [
    {{#if item.commentsUrl}}{ "name": "댓글", "value": {{json item.commentsUrl}}, "inline": false }{{/if}}
  ],
  "footer": { "text": {{json source.name}} }
}] }
```
**minimal.hbs**
```hbs
{ "embeds": [{ "title": {{json item.title}}, "url": {{json item.link}}, "color": 9807270 }] }
```
> 색 10진수·CVSS/stage 매핑은 설계서 §10. 렌더 결과는 Codex가 ajv로 한도 검증(title≤256/desc≤4096/fields≤25/합계≤6000/embeds≤10).

---

## 10. 스타일 (app.css)
- **라이트 단일 테마. 다크모드 없음**(명시 거부).
- 테이블·폼·배지·카드 위주의 미니멀 CSS. 프레임워크 의존 없이 한 파일로(또는 가벼운 classless CSS vendored).
- 상태 색: ready 녹색 / missing-key 노랑 / invalid-key·error 빨강 — 설계서 색과 무관(UI용).
- **webhook 아바타 미리보기**(`.avatar-preview`)는 원형 썸네일(≈30px, `border-radius:50%`·`object-fit:cover`·테두리). 목록 **빈 상태** 행은 `.muted` 중앙 정렬 `td[colspan]`.

## 11. 정적 자산 & 빌드
- vendored: `htmx.min.js`, CodeMirror(JS+CSS) → `assets/js`·`assets/css`.
- **외부 CDN 금지 — 폰트 포함 모든 자산은 vendored(로컬 `assets/`로 번들)한다.** loopback·SSH 내부 도구라 외부 요청은 오프라인 실패·외부 노출·FOUC를 부른다. 웹폰트도 외부 링크(`fonts.googleapis.com`/`fonts.gstatic.com`) 대신 폰트 파일을 받아 `@font-face` + 로컬 `assets/`로 서빙한다(외부 `<link>` 금지).
- 번들러 없음(D6). 필요 시 CodeMirror만 최소 esbuild 한 줄 가능하나 기본은 vendored 파일.
- 빌드: copy 스텝 → `dist/resources/templates/`·`dist/resources/presets/`. 런타임 서빙 `GET /assets/*`.

## 12. 구현 순서 (프런트 한정)
```
1) layouts/main(사이드바 nav 인라인) + partials(flash) + app.css  (뼈대)
2) sources.hbs + source-row + source-form  (핵심 CRUD, htmx)
3) groups.hbs + group-row
4) templates.hbs → template-editor + CodeMirror + preview(app.js)
5) logs.hbs + SSE(app.js) + log-entry
6) model.hbs + usage 폴링 + status-badge
7) dashboard.hbs
8) presets/*.hbs 4종 (Codex 렌더러와 변수 계약 맞춰 검증)
```
- **Backend 계약(§1)이 고정되면 즉시 병렬 착수 가능.** API가 아직 없으면 view-model 더미로 .hbs 먼저 작성 → API 연결.

---

## 13. Gemini가 Backend에 의존하는 지점 (재확인)
| 필요 | 출처 |
|------|------|
| 페이지 view-model 키 | backend-spec §3.2 |
| API req/resp(sources/groups/templates/preview/model/logs) | backend-spec §3.1 |
| `/api/preview` 응답 `{ok,payload,errors}` 형태 | backend-spec §3.1 |
| `/api/logs/stream` SSE 이벤트 스키마 | backend-spec §3.1 (delivery/fetch 필드) |
| 프리셋 변수 컨텍스트 | 설계서 §10 |
| **source-form D22 필드**(silent·mention·thread·editInPlace) | backend-spec §3.1 SourceDto·§4.6 (D22) |
> 이 외 백엔드 내부(스케줄러·정규화·DB)는 프런트와 무관.
