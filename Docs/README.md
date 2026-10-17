# 문서 지도

rss-discord-bridge 문서의 입구다. 무엇을 어디서 찾는지, 어떤 문서가 현재 기준인지를 적는다. (2026-10-16 정리 시작)

## 어디서 찾나

| 알고 싶은 것 | 문서 |
| --- | --- |
| 이 시스템이 무엇이고 어떻게 구성되나 | [Architecture/overview.md](Architecture/overview.md) |
| 부팅·워커·종료, 환경 변수 | [Architecture/runtime.md](Architecture/runtime.md) |
| 수집부터 발송까지의 흐름과 오류 처리 | [Architecture/pipeline.md](Architecture/pipeline.md) |
| 이 기능은 어느 파일·테이블·API·테스트와 연결되나 | [Architecture/module-map.md](Architecture/module-map.md) |
| 테이블·컬럼·상태 값의 정확한 정의 | [Contracts/db-schema.md](Contracts/db-schema.md) |
| 백엔드·프런트 계약(현행 보호 스펙) | [Architecture/backend-spec.md](Architecture/backend-spec.md), [Architecture/frontend-spec.md](Architecture/frontend-spec.md) |
| 배포·운영 | [Deploy/DEPLOY.md](Deploy/DEPLOY.md), [Deploy/CLOUDFLARE_ACCESS_PLAN.md](Deploy/CLOUDFLARE_ACCESS_PLAN.md)(검토안) |
| 최근 개편 내용과 남은 과제 | [Report/2026-10-16-consolidated-reorganization-report.md](Report/2026-10-16-consolidated-reorganization-report.md), [Report/2026-10-16-implementation-report.md](Report/2026-10-16-implementation-report.md) |
| 초기 설계 배경(D1~D24) | [Decisions/history/design-v1.md](Decisions/history/design-v1.md) (역사 기록) |

## 디렉터리

| 디렉터리 | 성격 | 보호 | 상태 |
| --- | --- | --- | --- |
| `Contracts/` | **계약**: 바꾸면 다른 모듈·트랙이 깨지는 정의(DB 스키마, API, view-model, 프리셋 변수, 설정) | 🔒 | `db-schema.md` 작성. 나머지 예정 |
| `Architecture/` | **현재 구조 설명**: 개요·런타임·파이프라인·모듈 지도 | — | 4종 작성 |
| `Architecture/backend-spec.md`, `frontend-spec.md` | 기존 트랙별 스펙. 맨 위 D25가 본문보다 우선 | 🔒 | 내용을 Contracts·Architecture·Features로 옮긴 뒤 보관 예정 |
| `Features/` | 기능별 문서(같은 양식) | — | 예정 |
| `Decisions/` | 결정 기록(D1~D25). 정책이 바뀌면 고치지 않고 새 결정으로 대체 | 🔒 | `history/design-v1.md`만 있음. 결정별 문서 예정 |
| `Deploy/` | 배포·운영 절차 | — | 기존 유지 |
| `Report/` | 날짜별 조사·구현 보고서. 대체된 보고서는 `Report/Archive/<날짜>/` | — | |

🔒 표시 문서는 수정 전에 파일·항목 단위로 사용자 승인을 받는다. (CLAUDE.md·AGENTS.md의 보호 목록 갱신은 재구성 마지막 단계에서 승인 후 반영한다.)

## 문서 작성 규칙

- **진실원을 하나로**: DB는 마이그레이션 SQL, API·view-model·프리셋 변수는 `src/server/contracts/*.ts`가 진실원이다. 문서는 그 의미를 설명하고, 이름이 어긋나면 테스트가 잡게 한다(예: `test/integration/docs/db-schema-doc.test.ts`).
- **현재와 과거를 섞지 않는다**: Architecture·Contracts·Features에는 현재 동작만 쓴다. 바뀐 이유와 이전 설계는 Decisions에 둔다.
- **머리에 기준을 적는다**: 문서 첫머리에 검증한 커밋과 작성일을 적는다.
- **그림은 Mermaid**: markdown 안에 넣어 diff로 리뷰할 수 있게 한다. 이미지 파일은 쓰지 않는다.
- **언어·이름**: 본문은 한국어, 새 파일 이름은 영문 kebab-case, 디렉터리는 기존 규칙(첫 글자 대문자)을 따른다.

## 재구성 진행 상황

| 단계 | 내용 | 상태 |
| --- | --- | --- |
| 0 | 보호 범위(Contracts + Decisions), 설계 통합본 추적, 작성 주체 결정 | 완료 |
| 1 | 문서 지도, 설계 통합본(`README_DEV.md`) 이관, 대체된 보고서 보관 | 완료 |
| 2 | DB 스키마 계약 + 스키마 일치 테스트 | 완료(테스트 미실행) |
| 3 | Architecture 4종 | 완료 |
| 4 | Contracts: HTTP API, view-model, render context, 설정 | 예정 · 승인 필요 |
| 5 | Features 기능별 문서 | 예정 |
| 6 | Decisions: D1~D25 결정별 문서 | 예정 |
| 7 | 기존 스펙 보관, CLAUDE.md·AGENTS.md 경로·보호 목록 갱신 | 예정 · 승인 필요 |
| 8 | 링크·코드 경로 검사 자동화 | 예정 |
