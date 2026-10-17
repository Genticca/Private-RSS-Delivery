# 2026-09-07 구조 조사: 설계 문서 관련 발견

요청한 상세 보고서는 워크스페이스 루트 `/RSS_Monite/PROJECT_STRUCTURE_REVIEW.md`에 작성했다. 애플리케이션 및 보호된 설계 문서는 수정하지 않았다.

- AGENTS.md의 `Docs/README.md`, `stage2-normalize.md` 참조는 현재 파일 배치와 맞지 않는다. 실제 스펙은 `Docs/Architecture/backend-spec.md`, `frontend-spec.md`에 있다. 문서 진입점 및 참조 복구를 제안한다.
- backend-spec §4.4·§4.6의 변경된 delivered 항목 전체 목적지 재전송 및 PATCH 404 POST 폴백은 사용자의 과거 항목 비소급 요구와 조정이 필요하다. `new_only`/`edit_existing` 및 명시적 재전송 정책을 제안한다.
- backend-spec §4.7의 파싱 실패·잘림 시 즉시 원문 반환, 번역 캐시 정책과 실패 후 복구 정책을 함께 검토해야 한다. 현재 실패 원문 캐시는 기존 테스트에서도 기대하는 동작이다.
- frontend-spec에는 새 전송 정책 옵션 및 모델의 키 존재/최근 호출 성공 여부를 구별하는 표시가 필요할 수 있다.

위 내용은 변경 제안이다. 보호 문서 편집에는 해당 파일·항목의 명시적 사용자 승인이 필요하다.
