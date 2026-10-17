# rss-discord-bridge

RSS 2.0 / Atom 피드를 폴링해 **Discord 웹훅으로 전달**하는 셀프호스트 브리지. 특히 **status page(장애 공지)** 피드를 안정적으로 중계하도록, "등록 후 과거 이벤트가 다시 전송되는" 재전송 버그를 **구조적으로 차단**하는 데 초점을 둔 재작성판이다. 서버 렌더 관리 UI(내부·단일 관리자, loopback 전용)를 포함한다.

> Node ≥ 20 · TypeScript(ESM) · SQLite 단일 프로세스 · 목적지별 발송 작업과 공유 번역 캐시

## 주요 기능

- **RSS 2.0 / Atom 폴링 → Discord 전송** — 소스별 폴 주기, 조건부 GET(etag/last-modified)으로 대역 절감.
- **2단계 파싱** — Stage 1 Envelope(형식 흡수) / Stage 2 Normalize(순수·결정적 정제 + `contentHash`).
- **재전송 버그 차단** — identity(`atom_id`) ≠ change(`contentHash`) 분리 + 연결별 첫 수집 baseline + 고정된 목적지별 발송 작업.
- **Provider Profile 자동 감지** — `generic` / `incident-io` / `atlassian-statuspage`.
- **Discord 프리셋 4종** — `incident-active`·`news-article`·`link-discussion`·`minimal`. 서버 Handlebars 렌더이고 미리보기는 전송과 동일 경로.
- **그룹 = 재사용 전송 채널** — 웹훅을 그룹이 보유하고 여러 소스가 공유한다.
- **메시지 옵션** — 조용히 보내기·멘션·Forum 스레드/태그·수정(edit-in-place).
- **번역(→ 한국어)** — 필요한 필드만 번역하고 항목·웹훅 사이에서 입력별 캐시를 공유. primary = Gemini, fallback = NVIDIA NIM. 별도 번역 진단 지원.
- **Export/Import** — 소스·그룹 설정을 JSON 1파일로 백업/이전(웹훅 URL 등 시크릿 제외).
- **관리 UI** — 서버 렌더 Handlebars + htmx + CodeMirror + 라이브 로그 SSE. React/번들러 없음.

## 아키텍처 한눈에

폴링 한 사이클의 데이터는 네 형태로 변환된다:

```mermaid
flowchart LR
  X[원본 XML] -->|Fetch + Stage 1| E[FeedEnvelope]
  E -->|Stage 2 정규화| N["NormalizedItem<br/>+ contentHash"]
  N -->|프리셋 렌더| D[Discord payload]
```

- **Stage 1 — Envelope**: RSS 2.0와 Atom의 형식 차이를 흡수해 동일 DTO로 만든다. HTML 본문은 해석하지 않고 운반만 한다.
- **Stage 2 — Normalize**: 본문을 정제하고 `contentHash`를 계산한다. I/O 없는 순수·결정적 함수.

**3대 불변식**

1. **2단계 분리** — 형식(Stage 1) / 내용(Stage 2).
2. **identity ≠ change** — 식별은 `atom_id`(불변), 변경 감지는 `contentHash`(별도).
3. **순수·결정적 정규화** — 같은 입력 → 같은 출력 → 해시 안정 → 재전송 버그 차단.

소스 등록 시 `delivery_cutoff_at = now`로 두고, 첫 폴은 기존 항목을 **historical로 저장만**(전송하지 않음) 한 뒤 이후 신규 항목만 전송한다.

새 웹훅·스레드 연결도 첫 성공 수집을 묵음 baseline으로 삼는다. 연결 직후 첫 수집 전까지의 새 글도 제외될 수 있다. 웹훅 교체로 기존 작업을 새 목적지에 옮기지 않는다. POST 결과 불명·PATCH 404는 자동 새 POST 대신 발송 작업(`/delivery-jobs`) 화면에서 검토한다.

실행 진입점은 `src/server/main.ts`(`npm run dev`)와 `dist/server/main.js`(`npm start`)다. `app.ts`는 HTTP 앱 구성, `runtime`은 조립·종료, `workers`는 실행 제어, `services`는 업무 처리, `domain`은 I/O 없는 규칙을 담당한다. 수집과 발송은 별도 워커로 실행하며 종료 시 진행 중 작업을 기다린다.

0021~0023 마이그레이션은 연결·발송 작업·영속 message ID·번역 캐시·설정 버전 추적을 추가한다. 기존 pending/failed는 `legacy_unknown`으로 이관하며 자동 발송하지 않는다. 구형 성공 로그의 message ID는 종료된 이전 연결에 보존한다. 운영 적용은 정지된 DB 사본으로 이관을 확인하고 백업 후 진행한다. 실행 제한과 대량 신규 보류 임계값은 [default.env.example](default.env.example)에 있다.

`npm run benchmark`는 빌드 후 외부 API 없이 25개 피드의 수집·발송과 공유 번역 캐시를 측정한다. 이전 구현과 재현 자료는 [Archive](Archive/README.md)에 보관한다.

## 기술 스택

| 영역 | 사용 |
|---|---|
| 서버 | Fastify 5, TypeScript(ESM) |
| 저장소 | better-sqlite3(WAL) + 순번 SQL 마이그레이션 |
| 피드 | fast-xml-parser, undici(SSRF-safe Agent · 조건부 GET · TLS) |
| 렌더 | Handlebars(프리셋·뷰), ajv(Discord payload 검증) |
| UI | htmx, CodeMirror, SSE — React/Vite 없음 |
| 번역 | @google/genai(Gemini) + NVIDIA NIM 폴백 |

## 빠른 시작

요구사항: **Node ≥ 20**.

```bash
npm install
cp default.env.example .env     # 값 채우기(아래 '설정' 참고)

# 개발 (tsx watch)
npm run dev

# 프로덕션
npm run build
npm start
```

기타 명령:

```bash
npm run typecheck        # 서버 + 테스트 tsconfig 양쪽 검사
npm test                 # 전체 (vitest)
npm run test:unit
npm run test:integration
```

> better-sqlite3는 **플랫폼별 네이티브 모듈**이다. 배포 서버에서는 그 서버에서 직접 `npm ci`로 빌드한다 — 다른 OS의 `node_modules`를 그대로 복사하면 동작하지 않는다.

## 설정 (.env)

env는 프로젝트 루트의 `.env`(gitignore)에서 읽는다. 템플릿은 `default.env.example`. 코드가 읽는 변수는 6개다:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NODE_ENV` | `development` | `production`이면 운영 점검 ON + HOST를 loopback으로 강제 |
| `HOST` | `127.0.0.1` | 내부 도구 — loopback 고정 |
| `PORT` | `8080` | 바인딩 포트 |
| `DATABASE_PATH` | `./data/rss-discord-bridge.sqlite` | 실행 cwd 기준 상대경로 |
| `PRIMARY_MODEL_API_KEY` | — | 번역 primary(Gemini). 비우면 번역 OFF |
| `FALLBACK_MODEL_API_KEY` | — | 번역 fallback(NVIDIA NIM) |

> 🔒 **API 키는 env 전용** — DB에 저장하지 않는다. 비워도 부팅은 정상이며, 해당 역할만 비활성화되어 번역 없이 원문이 전송된다.

## 프로젝트 구조

```
.
├── src/
│   ├── server/        # 백엔드: controllers contracts services db domain
│   │   │              #         scheduler dispatcher translator security runtime
│   │   └── app.ts
│   └── resources/
│       ├── templates/ # 관리 UI 서버 렌더 뷰(.hbs) + 정적자산(htmx, CodeMirror)
│       ├── presets/   # *.hbs 프리셋 시드 → 부팅 시 DB seed
│       └── migrations/# 0001_init.sql … (순번 적용)
├── test/{unit,integration,mocks}/
├── Docs/              # 설계 문서
├── default.env.example
└── data/              # SQLite DB — gitignore
```

## 설계 문서

세부 계약·알고리즘은 별도 문서에 있다. 입구는 [`Docs/README.md`](./Docs/README.md)(문서 지도)다.

- 구조 개요 — [`Docs/Architecture/overview.md`](./Docs/Architecture/overview.md)
- DB 스키마 계약 — [`Docs/Contracts/db-schema.md`](./Docs/Contracts/db-schema.md)
- 백엔드 스펙 — [`Docs/Architecture/backend-spec.md`](./Docs/Architecture/backend-spec.md)
- 프런트엔드 스펙 — [`Docs/Architecture/frontend-spec.md`](./Docs/Architecture/frontend-spec.md)
- 배포 가이드 — [`Docs/Deploy/DEPLOY.md`](./Docs/Deploy/DEPLOY.md)
