# rss-discord-bridge

RSS·Atom 피드를 주기적으로 읽어 **Discord 웹훅으로 보내는 셀프호스트 도구**입니다. 서비스 장애 공지(status page) 피드를 안정적으로 전달하는 데 맞춰 만들었고, 소스를 등록하거나 웹훅을 바꿨을 때 **지난 글이 다시 전송되지 않도록** 설계했습니다.

## 주요 기능

- **피드 수집** — RSS 2.0·Atom을 소스별 주기로 수집합니다. 바뀌지 않은 피드는 조건부 요청으로 건너뜁니다.
- **중복·재전송 방지** — 처음 등록한 소스나 새로 연결한 웹훅에는 지난 글을 보내지 않습니다. 결과가 불확실한 전송은 자동으로 다시 보내지 않고 관리자가 확인합니다.
- **장애 공지 지원** — incident.io, Atlassian Statuspage 형식을 자동으로 알아보고 장애 단계를 표시합니다.
- **메시지 꾸미기** — 내장 템플릿 4종과 직접 만든 템플릿을 쓸 수 있습니다. 실제 전송과 같은 화면으로 미리 볼 수 있습니다.
- **Discord 옵션** — 조용히 보내기, 멘션, 스레드·포럼 게시, 내용이 바뀌면 기존 메시지 수정.
- **발신 그룹** — 웹훅 하나를 그룹으로 등록해 여러 소스가 함께 씁니다.
- **한국어 번역** — Gemini로 제목·본문을 번역합니다. 결과를 캐시하고, 기본 키가 막히면 대체 키로 바꾸며, 실패하면 원문을 보냅니다.
- **관리 화면** — 운영 현황, 소스·그룹·템플릿 관리, 발송 검토, 실시간 로그를 브라우저에서 다룹니다.
- **설정 이전** — 소스·그룹 설정을 JSON 파일로 내보내고 가져옵니다. 웹훅 같은 비밀값은 빠집니다.

## 빠른 시작

**필요한 것:** Node.js 20 이상

```bash
git clone https://github.com/Genticca/Private-RSS-Delivery.git
cd Private-RSS-Delivery
npm install
cp default.env.example .env
```

`.env`에서 필요한 값을 채웁니다. 번역을 쓰지 않으면 비워 둬도 됩니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8080` | 관리 화면 포트 |
| `DATABASE_PATH` | `./data/rss-discord-bridge.sqlite` | SQLite 파일 위치 |
| `PRIMARY_MODEL_API_KEY` | — | Gemini API 키(번역용) |
| `FALLBACK_MODEL_API_KEY` | — | 선택 대체 키 |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | 번역 모델 |

전체 설정은 [Docs/구조.md](Docs/구조.md#9-설정값)에 있습니다.

**개발 모드로 실행**

```bash
npm run dev
```

**빌드 후 실행**

```bash
npm run build
npm start
```

브라우저에서 `http://127.0.0.1:8080`을 열고 다음 순서로 시작합니다.

1. **발신 그룹**에 Discord 웹훅을 등록합니다.
2. **수집 소스**에 피드 URL을 추가합니다.
3. 소스에 그룹을 연결합니다.

첫 수집에서 받은 글은 저장만 하고, 그 뒤 새로 올라온 글부터 Discord로 보냅니다.

## 테스트

```bash
npm run typecheck   # 타입 검사
npm test            # 전체 테스트
npm run smoke       # 빌드 후 서버를 띄워 주요 API 확인
```

## 서버에 배포

관리 화면은 로그인 기능 없이 `127.0.0.1`에서만 열립니다. 서버에서는 systemd로 실행하고 SSH 터널로 접속합니다. 설치부터 업데이트까지는 [Docs/배포.md](Docs/배포.md)를 참고하세요.

> `better-sqlite3`는 OS별로 빌드되므로, 배포 서버에서 직접 `npm ci`를 실행해야 합니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [기능](Docs/기능.md) | 기능별 동작, HTTP API, 알려진 한계 |
| [구조](Docs/구조.md) | 코드 구성, 수집·발송·번역 흐름, 설정값 |
| [DB 스키마](Docs/DB-스키마.md) | 테이블·컬럼·상태 값 |
| [결정 기록](Docs/결정-기록.md) | 주요 설계 결정과 이유 |
| [배포](Docs/배포.md) | Ubuntu·systemd 설치와 운영 |

## 기술 스택

TypeScript(Node.js) · Fastify · SQLite(better-sqlite3) · Handlebars · htmx · CodeMirror · Gemini(@google/genai)
