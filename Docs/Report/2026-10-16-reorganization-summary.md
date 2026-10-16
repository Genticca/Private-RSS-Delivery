# 프로젝트 개편 현황과 추진 방향

작성일: 2026-10-16 (Asia/Seoul)

이 문서는 현재 코드 조사와 대화에서 논의한 개편 사항을 모은 검토 문서다. 구현 완료 보고서나 기존 보호 설계 문서를 대체하는 계약이 아니다.

## 1. 현재 상태와 결정 수준

| 항목 | 현재 상태 | 논의한 방향 | 결정 수준 |
| --- | --- | --- | --- |
| 애플리케이션 | v0.4.0, Node.js·TypeScript·Fastify, 단일 프로세스 | 현재 기술 구성에서 오류·병목 개선 | 유지 권고 |
| 화면 | Handlebars·htmx·CodeMirror·SSE | 현재 흐름 유지 | 저장소 지침 |
| DB | better-sqlite3, SQLite WAL | PostgreSQL 전환 검토 | 추천안, 미구현 |
| 배포 환경 | 실제 OCI 서버 접속·부하 측정은 하지 않음 | OCI Ampere FLEX, **1 OCPU·RAM 6GB** | 사용자가 지정한 목표 사양 |
| PostgreSQL 운영 | Compose 구성 및 DB 전환 없음 | Docker Compose로 PostgreSQL 1개 운영 | 추천안, 미구현 |
| 외부 접근 | 사용자 설명과 배포 문서 기준 SSH 터널 이용 | Cloudflare Access + Tunnel | 검토안, 미도입 |
| Go 전환 | Go 코드 없음 | 우선 Node.js 유지, 병목 측정 후 워커 분리 검토 | 미확정, 현재 재작성 권고 아님 |
| 코드 변경 | 조사 보고서와 모의 진단 스크립트만 작성 | 아래 순서로 후속 구현 | 아직 구현하지 않음 |

## 2. 최우선 오류: 새 웹훅에 과거 항목 발송

원인은 **RSS 항목 하나의 전송 상태로 현재 목적지 전체를 처리하는 구조**다. 웹훅 URL과 threadId를 구별하지 못해서 발생한 문제는 아니다. 현재 목적지 키에는 URL과 지정 threadId가 반영된다.

재현한 흐름:

1. A에 이미 발송한 항목의 내용 해시가 바뀌면 item 전체가 pending이 된다.
2. dispatcher는 최초 발송 대상이나 큐 생성 당시 대상 대신 현재 그룹의 웹훅들을 조회한다.
3. 새 B에는 해당 버전의 성공 기록과 message ID가 없으므로 새 POST를 한다.
4. 기존 pending 항목은 내용 변경 없이도 새 B로 전송될 수 있다.

웹훅 교체만 하고 내용이 동일한 delivered 항목, 새 소스 첫 poll의 historical 항목은 재현에서 전송되지 않았다. 따라서 실제 운영에서 과거 항목 전체가 발송된 계기를 확정하려면 당시 pending·내용 변경 이력을 추가로 확인해야 한다.

### 권장 개선

발송 단위를 **item × 목적지 × 연결 세대**로 관리한다. 동일 URL이라도 연결이 해제됐다가 재연결되면 별도 세대로 취급한다.

| 데이터 | 역할 |
| --- | --- |
| `items` | RSS 식별자·정규화 내용·historical 여부·증가하는 내용 revision |
| `delivery_bindings` 신규 | 설정으로부터 파생한 목적지 연결·세대·시작/종료·baseline |
| `item_deliveries` 신규 | 목적지별 최초 발송, 영속 message/thread ID, 마지막 반영 버전 |
| `delivery_jobs` 신규 | 목적지와 작업 종류를 고정한 발송·수정·재시도 작업 |
| `delivery_log` | 정리 가능한 감사 로그. 메시지 상태의 유일한 저장소로 사용하지 않음 |

- 작업 생성 때 목적지를 고정하고, 웹훅 교체·연결 해제 때 원래 작업을 취소한다. 새 대상으로 대기열을 자동 이전하지 않는다.
- 과거 글의 갱신은 원래 발송했던 연결 중 현재 유효한 연결에만 적용한다.
- 첫 신규 연결의 성공적인 피드 스냅샷을 묵음 baseline으로 삼는 기본안을 검토한다. 연결 직후 첫 수집까지 발생한 새 글도 묵음이 될 수 있다는 절충점을 함께 확정해야 한다.
- message ID 미상·PATCH 404일 때 자동 새 POST를 만들지 않는다.
- 내용 H1→H2→H1 복귀 시 옛 성공 로그로 필요한 수정을 생략하지 않도록 contentHash와 반영 revision을 구분한다.
- 그룹·소스 일반 편집뿐 아니라 import overwrite에도 같은 연결 갱신 규칙을 적용한다.
- 기존 `editInPlace` OFF의 의미를 신규 전용으로 조용히 바꾸지 않는다. 최초 발송·기존 메시지 수정·기존 대상의 추가 알림을 작업 종류로 구분한다.

상세: [원인 조사](2026-10-16-webhook-history-investigation.md), [개선 구조·이관·회귀 테스트](2026-10-16-webhook-delivery-improvement-plan.md).

## 3. AI 번역 API 절감

현재도 같은 item의 번역은 여러 목적지 발송과 Discord 재시도에서 재사용한다. 추가 최적화는 다음 순서로 검토한다.

1. 실제 사용하는 필드만 번역한다. `minimal`은 본문을 표시하지 않는데 현재는 본문도 번역한다.
2. item·소스를 넘어 **동일한 실제 원문 입력의 성공 번역을 공유**한다.
3. 제목·본문을 필드별 캐시로 관리해 변경된 필드만 번역한다. 같은 요청에서 미스인 필드들은 한 API 요청으로 묶는다.
4. 같은 캐시 키에 진행 중인 요청을 공유해 동시 중복 호출을 막는다.
5. 빈 내용·확실한 한국어·고정 상태 라벨은 가능한 범위에서 로컬 처리한다.
6. 실패 원문과 성공 번역 상태를 구분하고, cooldown·보조 모델 호출 예산을 둔다.
7. Gemini에 취소 신호를 전달하고 timeout 이후 주·보조 모델의 중복 진행을 제한한다. 클라이언트 취소가 서버 생성 비용 취소까지 보장하는 것은 아니다.

번역 캐시 키는 발송용 contentHash와 별도로 둔다. generic 해시는 본문을, incident 해시는 제목을 모두 포함하지 않기 때문이다. 원문이 되돌아오면 옛 번역을 재사용해도 되지만, 그 사실을 Discord 수정 생략의 근거로 삼지 않는다.

뉴스 본문 발췌·짧은 동기 묶음 번역은 품질과 지연을 비교한 후 적용한다. 비동기 Batch API는 실시간 장애 공지의 기본 경로로 삼지 않는다. 목적지별 발송 작업으로 전환하더라도 번역을 웹훅마다 반복하지 않는다.

상세: [번역 절감 조사·캐시 설계·검증](2026-10-16-translation-api-optimization.md).

## 4. Node.js 유지와 수집·발송 성능

현재 권고는 **수집과 발송의 책임을 분리하되 Node.js를 유지하는 것**이다. 수집·제어는 Go, REST는 Node.js로 나누기로 결정한 상태가 아니다.

현재 poller는 피드를 순차 확인하고, 같은 tick에서 번역·Discord 발송까지 기다린다. 외부 응답 지연이 다음 작업을 늦출 수 있으므로 다음을 먼저 개선한다.

- 수집과 발송 실행 흐름을 분리하고 제한된 개수로 동시 처리한다.
- 1 OCPU에서는 무제한 병렬 실행 대신 실제 지연·CPU·메모리·큐 적체를 보고 동시성을 조정한다.
- 다중 프로세스로 늘릴 때는 프로세스별 메모리 Set만 믿지 않고 DB의 작업 선점·완료·복구를 설계한다.
- 실제 CPU/메모리 병목이 남으면 Go 워커 분리를 검토한다. 언어 변경만으로 외부 API 지연·발송 상태 오류·번역 API 비용이 해결되지는 않는다.
- Go 이식 시에는 정규화 결과와 contentHash의 완전한 호환성을 검증해야 한다. 출력 차이가 과거 항목의 대량 변경 판정을 유발할 수 있다.

운영 런타임은 Node.js 24 LTS를 권장한다. 현재 배포 문서의 Node 20 권장은 갱신 검토 대상이며, 공식 릴리스 표에서 Node 20은 EOL로 표시된다. [Node.js 릴리스 현황](https://nodejs.org/en/about/previous-releases)

## 5. PostgreSQL과 Docker 운영 검토

PostgreSQL을 선택하는 근거는 목적지별 상태와 작업 큐를 트랜잭션으로 저장하고, 향후 여러 워커가 공유하기 편하다는 점이다. `FOR UPDATE SKIP LOCKED`는 여러 소비자가 큐 형태 테이블의 작업을 나눠 가져가는 데 활용할 수 있다. [PostgreSQL 공식 설명](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

SQLite도 제안한 발송 모델을 구현할 수 있다. **현재 오류의 원인은 SQLite가 아니며 DB 변경만으로 해결되지 않는다.** PostgreSQL 전환은 별도의 구현·데이터 이관 작업이다.

| 운영 항목 | 초기 제안 |
| --- | --- |
| 목표 서버 | OCI Ampere FLEX, 1 OCPU·RAM 6GB |
| DB 운영 | Docker Compose의 PostgreSQL 컨테이너 1개 |
| 이미지 | ARM64 지원 공식 이미지, `postgres:18` 등 메이저 버전 고정 |
| 데이터 | Named volume 사용. PostgreSQL 18 공식 이미지의 마운트 위치는 `/var/lib/postgresql` |
| 앱 연결 | 호스트 Node.js 기준 PostgreSQL 포트는 `127.0.0.1:5432`에만 공개 |
| 연결 풀 | 앱당 우선 5개 정도로 시작하고 전체 연결 수·실측 결과에 맞춰 조정 |
| 백업·갱신 | 정기 백업과 복원 검증. 메이저 업그레이드는 별도 이관 |
| Redis | 첫 구성의 필수 항목으로 추가하지 않음. 캐시·큐는 우선 PostgreSQL에서도 관리 가능 |

공식 이미지의 ARM64 지원과 PostgreSQL 18 볼륨 경로: [PostgreSQL Docker 이미지](https://hub.docker.com/_/postgres).

호스트 앱 + 호스트 `cloudflared` + Docker PostgreSQL 구성이 현재 loopback 제약을 유지하기 쉽다. Node.js까지 컨테이너화한다면 각 컨테이너의 localhost가 서로 다르므로 네트워크·바인딩 방식을 따로 설계해야 한다.

현재 DB 코드는 better-sqlite3의 동기 쿼리/트랜잭션에 의존한다. PostgreSQL 전환에는 드라이버만 교체하는 것 이상으로 repository·서비스의 비동기 트랜잭션 경계, SQLite 전용 SQL, 설정·마이그레이션·통합 테스트 변경이 필요하다. 기존 SQLite 마이그레이션을 PostgreSQL에서 그대로 실행하는 방안은 아니다.

이 사양에서의 적합성은 소규모 운영을 전제로 한 판단이다. 실제 OCI 인스턴스에서 부하 테스트하거나 최대 처리량을 확인하지 않았다.

## 6. Cloudflare Access와 외부 접근

외부 브라우저 접속을 허용하되 앱·DB 포트는 비공개로 유지하는 **Cloudflare Access + Tunnel** 구성을 검토했다. Access는 사용자 인증/권한, Tunnel은 내부 서비스 연결을 담당한다.

Access의 무료 플랜은 공식 안내 기준 US$0이며 50명 미만 소규모 팀을 대상으로 한다. 본인 또는 소수 관리자 용도는 무료 플랜으로 시작할 수 있다. 유료 Pay-as-you-go는 사용자당 월 US$7, 연간 결제 기준으로 안내된다. 도메인 등록·갱신 비용은 별도다. 확인일: 2026-10-16. [공식 Access 요금 안내](https://www.cloudflare.com/en-gb/sase/products/access/)

공개 도메인·Cloudflare 계정·허용 관리자 계정·인증 제공자·세션 정책은 아직 정하지 않았으며 실제 설정도 하지 않았다.

상세: [Cloudflare Access 도입안](../Deploy/CLOUDFLARE_ACCESS_PLAN.md).

## 7. 구현 순서와 미확정 사항

1. 신규 연결 baseline, 기존 갱신/실패 처리, 이관 시 미확정 작업 정책을 확정한다.
2. DB 전환 여부와 시점을 정하고 보호 설계 문서의 해당 계약 변경을 검토한다.
3. 목적지별 연결·메시지 상태·작업 모델을 구현한다. 기존 pending을 현재 그룹 전체로 복제하지 않는다.
4. 공유 번역 캐시·필드 선택·실패 상태를 구현한다.
5. 수집·발송 동시성과 작업 복구를 정비한다. PostgreSQL을 선택했다면 실제 DB 기반 통합 테스트와 이관 검증을 수행한다.
6. Access·Host/Origin·JWT 검증·SSE 세션 동작을 구현/검증한 후 외부 도메인을 연결한다.
7. OCI에서 자원 사용량·발송 지연·중복/누락·번역 사용량을 측정한다.

보호 문서 변경 검토 대상은 [backend-spec](../Architecture/backend-spec.md)의 DB/스케줄러/dispatcher/번역/서비스/접근 제어 계약과 [frontend-spec](../Architecture/frontend-spec.md)의 번역·재시도·Access 세션 안내다. AGENTS.md에 따라 파일·항목 단위의 명시 승인 없이 수정하지 않는다. 이 요약 문서 작성은 해당 보호 문서 편집 승인으로 취급하지 않는다.

## 8. 검증 상태와 관련 자료

- 발송 진단: 현재 source 기반 메모리 SQLite·모의 HTTP로 9개 시나리오 assertion 통과.
- 번역 진단: 모의 번역기·모의 SDK HTTP로 6개 시나리오 assertion 통과.
- 서버·테스트 타입검사는 앞선 조사에서 통과했다. 현재 Windows 네이티브 의존성 문제로 기존 Vitest 전체 통과를 확인하지 못했다.
- 로컬 기본 DB에는 운영 판단에 사용할 소스/발송/번역 사용 이력이 없었다. 실제 운영 사건과 비용 절감률은 미확정이다.
- OCI 접속, PostgreSQL 설치/이관, Cloudflare 설정, 실제 Discord/번역 API 호출은 수행하지 않았다.

관련 자료:

- [발송 원인 조사](2026-10-16-webhook-history-investigation.md)
- [발송 개선 상세안](2026-10-16-webhook-delivery-improvement-plan.md)
- [번역 API 절감 상세안](2026-10-16-translation-api-optimization.md)
- [발송 재현 스크립트](../../Archive/2026-10-16/Docs/Report/2026-10-16-webhook-history-repro.mjs)
- [번역 재현 스크립트](../../Archive/2026-10-16/Docs/Report/2026-10-16-translation-usage-repro.mjs)
- [현재 SSH 터널 배포 가이드](../Deploy/DEPLOY.md)
- [Cloudflare Access 도입안](../Deploy/CLOUDFLARE_ACCESS_PLAN.md)
