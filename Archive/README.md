# Archive

현행 구현에서 교체되거나 참조가 사라진 파일을 날짜별 원래 경로로 보관한다. 런타임·빌드·테스트 입력이 아니다(`tsconfig` include와 Vitest exclude 적용).

## 2026-10-16

- `src/server/scheduler/poller.ts`: 수집·발송을 한 tick에서 실행하던 구현. 현행은 PollWorker + PollService다.
- `src/server/dispatcher/webhook.ts`: item 전체 상태와 delivery_log로 대상을 재계산하던 구현. 현행은 DeliveryWorker + DeliveryService + DiscordClient다.
- `src/server/scheduler/change-detect.ts`: item 전체 재큐를 결정하던 규칙. 목적지별 revision 작업 계획으로 대체했다.
- `src/server/domain/detect-profile.ts`: 참조가 없는 호환 재수출. 현행 프로필 구현은 `domain/normalize/profile.ts`다.
- 발송·번역·수집 테스트: D25 이전 계약의 기록. 현행 `test/integration/dispatcher/{delivery-jobs,translation-cache}.test.ts`와 `test/integration/scheduler/poll-service.test.ts`로 대체했다. 보관본을 현재 정상 동작의 근거로 사용하지 않는다.
- `Docs/Report/*-repro.mjs`: D25 이전 결함 재현용 스크립트. 당시 코드용 자료이며 현재 회귀 검증은 `test/integration`으로 대체했다.

마이그레이션, 운영 DB, 비밀값, 현재 조사 보고서는 이 Archive로 이동하지 않는다.
