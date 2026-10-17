# 문서 지도

| 알고 싶은 것 | 문서 |
| --- | --- |
| 구성·런타임·수집/발송 흐름·설정값·기능별 파일 연결 | [architecture.md](architecture.md) |
| 테이블·컬럼·상태 값의 정확한 정의 🔒 | [db-schema.md](db-schema.md) |
| 왜 이렇게 만들었나 (D1~D28) 🔒 | [decisions.md](decisions.md) |
| 배포·운영 | [deploy.md](deploy.md) (systemd 유닛: [rss-discord-bridge.service](rss-discord-bridge.service)) |
| 옛 설계·스펙·조사 보고서 | [Archive/2026-10-17/Docs/history/](../Archive/2026-10-17/Docs/history/) — 현재 기준이 아니다 |

🔒 표시 문서는 수정 전에 사용자 승인을 받는다.

## 작성 규칙

- **현재 동작만 쓴다**: 위 4개 문서에는 현재 동작만 쓴다. 바뀐 이유는 `decisions.md`에 한 줄 추가하고, 긴 조사·계획 보고서는 작업이 끝나면 루트 `Archive/<날짜>/Docs/`로 옮긴다.
- **진실원은 코드**: DB는 마이그레이션 SQL, API·view-model·프리셋 변수는 `src/server/contracts/*.ts`다. 문서와 이름이 어긋나면 테스트가 잡는다(`test/integration/docs/db-schema-doc.test.ts`).
- **새 문서를 늘리지 않는다**: 새 주제는 먼저 기존 문서의 절로 추가한다. 그림은 Mermaid, 본문은 한국어.
