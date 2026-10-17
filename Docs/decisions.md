# 결정 기록 (D1~D26)

> 정책이 바뀌면 기존 줄을 고치지 않고 새 결정을 추가하고, 대체된 결정에 표시한다. 결정 당시의 상세 논의는 보관본에 있다(D1~D24: [design-v1.md](../Archive/2026-10-17/Docs/history/design-v1.md), D25: [backend-spec.md](../Archive/2026-10-17/Docs/history/backend-spec.md)·[frontend-spec.md](../Archive/2026-10-17/Docs/history/frontend-spec.md) 머리말).

| # | 결정 | 상태 |
| --- | --- | --- |
| D1 | 최상위 `src/` + `test/`, 백엔드 `src/server`, 화면 `src/resources/templates` | 유효 |
| D2 | Discord 템플릿은 DB에 저장하고 런타임에 편집한다 | 유효 |
| D3 | 마이그레이션은 `src/resources/migrations/*.sql` 순번 파일 | 유효 |
| D4 | 순수 로직은 `src/server/domain/`, `services/`는 얇게 | 유효 |
| D5 | DnD 빌더 제거 → 프리셋 + JSON 편집 | 유효 |
| D6 | React/Vite 제거 → 서버 렌더 + htmx + CodeMirror | 유효 |
| D7 | WebSocket 실시간 미리보기 제거 → debounce REST | 유효 |
| D8 | 미리보기는 서버 Handlebars 렌더(전송과 같은 렌더러 1개) | 유효 |
| D9 | 빌드는 `tsc` + 리소스 복사(번들 아님) | 유효 |
| D10 | Status Page 입력은 Atom 규격 | 유효 |
| D11 | incident 식별은 Atom `<id>` 통째 → `(source_id, atom_id)`. `published`(cutoff)와 `updated`(참고) 분리 | 유효 |
| D12 | Provider Profile 자동 감지. 모르는 vendor는 `generic`. 한 번 감지 후 저장, 304에서는 재감지 안 함, 수동 지정 우선 | 유효 |
| D13 | 로그·모델 사용량은 React 없이 JSON 조회 + 라이브 로그 SSE | 유효 |
| D14 | 미리보기에는 번역을 적용하지 않는다(실제 전송 때만) | 유효 |
| D15 | 실제 RSS 미리보기는 서버를 한 번 거친다(피드 fetch·정규화는 서버 전용) | 유효 |
| D16 | 2단계 파싱: Stage 1 Envelope / Stage 2 정규화. 순수·결정적 | 유효 |
| D17 | 프리셋 4종: `incident-active`·`news-article`·`link-discussion`·`minimal` | 유효 |
| D18 | 인코딩 계층 분리: charset=fetch, 엔티티=Stage 1, 태그=Stage 2 | 유효 |
| D19 | 프로필 능력은 플래그 객체 없이 코드 모듈로 표현 | 유효 |
| D20 | Fetch 2계층(연결: TLS·SSRF / 요청: 헤더). 403·핸드셰이크 실패 시 TLS 1.2 재시도 후 `fetch_options`에 저장 | 유효 |
| D21 | Export/Import: 소스·그룹을 JSON 1파일로. 웹훅 URL 제외, 새로 들어온 소스는 신규 등록 취급(과거 재전송 차단) | 유효 |
| D22 | 웹훅 기능 확장: 조용히 보내기·멘션·Forum 스레드/태그·수정(edit-in-place). 메시지 옵션은 소스 소유 | 유효 |
| D23 | 소스가 목적지를 직접 소유(`source_destinations`) | **D24로 폐기** (0019 DROP) |
| D24 | 그룹 = 재사용 전송 채널. 웹훅 URL은 그룹만 가진다. 소스는 그룹 1개 이상 필수, 목적지 0개면 수집 건너뜀 | 유효 |
| D25 | 발송 단위를 항목 × 목적지 연결(세대)로 바꾼다. 새 연결의 첫 수집은 묵음 baseline, 결과 불명 POST·PATCH 404는 자동 재발송하지 않고 관리자 검토, 대량 신규 보류, 공유 번역 캐시, 수집·발송 워커 분리와 종료 drain (2026-10-16, 마이그레이션 0021~0023) | 유효 — 현재 동작은 [architecture.md](architecture.md) |
| D26 | 번역 모델은 Gemini 하나만 쓴다. NVIDIA NIM 대체 모델과 `FALLBACK_MODEL_API_KEY`를 없앤다. 실패하면 원문으로 보낸다 (2026-10-17) | 유효 |
