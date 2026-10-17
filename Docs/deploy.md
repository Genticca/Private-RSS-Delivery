# Ubuntu Server 배포 런북 (Production / 시범 운용)

대상: 단일 관리자용 내부 도구. **production 에서는 앱이 loopback(`127.0.0.1`)에만 바인딩**되며,
비-loopback HOST 로는 기동 자체가 거부된다(`src/server/config.ts`). 외부 접속은 **SSH 터널**로 한다.

핵심 전제 3가지(과거에 실제로 막혔던 지점):
1. **네이티브 모듈은 배포 서버에서 직접 빌드한다.** `better-sqlite3` 의 `.node` 바이너리는 OS/ABI 종속이다.
   다른 머신의 `node_modules` 를 복사해 옮기면 `invalid ELF header` 로 DB 오픈에 실패한다 → 반드시 그 서버에서 `npm ci`.
2. **`.env` 와 `./data/...sqlite` 는 cwd(=WorkingDirectory) 기준 상대경로**다. systemd `WorkingDirectory` 를 앱 루트로 정확히 둔다.
3. **API 키는 환경변수에만**(`.env`), DB 저장 금지. 키가 비어도 기동은 되고 번역만 OFF 된다.

---

## 0. 사전 준비 (Ubuntu Server, 1회)

```bash
# Node 20 LTS (NodeSource). 이미 node>=20 이면 생략.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 네이티브 모듈 소스 빌드 폴백용(미리빌드를 못 받을 때 대비). 보통 prebuild 로 충분하지만 안전하게.
sudo apt-get install -y build-essential python3 git

node -v   # v20+ 확인
```

## 1. 코드 배치

```bash
sudo useradd --system --create-home --home-dir /opt/rss-discord-bridge --shell /usr/sbin/nologin rssbridge

# 방법 A) git
sudo -u rssbridge git clone <REPO_URL> /opt/rss-discord-bridge
# 방법 B) rsync (node_modules/dist/.env/data 는 제외하고 전송)
#   rsync -av --exclude node_modules --exclude dist --exclude .env --exclude data/ ./ user@server:/tmp/app/
#   그 뒤 서버에서 sudo mv /tmp/app /opt/rss-discord-bridge && sudo chown -R rssbridge:rssbridge /opt/rss-discord-bridge

cd /opt/rss-discord-bridge
```

## 2. 의존성 설치 + 빌드 (반드시 이 서버에서)

```bash
sudo -u rssbridge npm ci            # better-sqlite3 를 이 머신용으로 빌드/미리빌드
sudo -u rssbridge npm run build     # tsc + 리소스 copy → dist/
```

## 3. .env 작성 (production)

```bash
sudo -u rssbridge cp default.env.example .env
sudo -u rssbridge nano .env
```
```ini
NODE_ENV=production
HOST=127.0.0.1          # production 에서는 loopback 외 값이면 기동 거부됨
PORT=8080
DATABASE_PATH=./data/rss-discord-bridge.sqlite
PRIMARY_MODEL_API_KEY=   # (선택) 비우면 번역 OFF
FALLBACK_MODEL_API_KEY=  # (선택)
```
```bash
sudo -u rssbridge mkdir -p data
sudo chmod 600 /opt/rss-discord-bridge/.env   # 키 보호
```

## 4. 수동 스모크 테스트 (systemd 등록 전 1회)

```bash
cd /opt/rss-discord-bridge
sudo -u rssbridge env NODE_ENV=production node dist/server/main.js &
sleep 2
curl -s http://127.0.0.1:8080/healthz   # {"status":"ok"}
curl -s http://127.0.0.1:8080/ready     # {"status":"ready"}  ← DB·마이그레이션 정상
kill %1
```

## 5. systemd 서비스 등록

```bash
sudo cp /opt/rss-discord-bridge/Docs/rss-discord-bridge.service /etc/systemd/system/
# ExecStart 의 node 경로 확인: which node  (다르면 유닛 파일 수정)
sudo systemctl daemon-reload
sudo systemctl enable --now rss-discord-bridge
sudo systemctl status rss-discord-bridge --no-pager
sudo journalctl -u rss-discord-bridge -f      # 로그 추적
```

## 6. 접속 (관리자 노트북에서 SSH 터널)

```bash
ssh -L 8080:127.0.0.1:8080 <user>@<server>
# 터널 유지한 채 브라우저에서:  http://localhost:8080
```

## 7. 업데이트 절차

```bash
cd /opt/rss-discord-bridge
sudo -u rssbridge git pull            # 또는 rsync 재전송
sudo -u rssbridge npm ci              # 의존성 변경 시
sudo -u rssbridge npm run build
sudo systemctl restart rss-discord-bridge
```

새 마이그레이션이 들어간 업데이트는 먼저 정지된 운영 DB 사본으로 이관을 확인하고 백업한 뒤 적용한다. 0021~0023은 기존 pending/failed를 `legacy_unknown`으로 옮기며 자동 발송하지 않는다(관리 화면 `/delivery-jobs`에서 처리).

## 8. 운영 메모

- **백업**: 런타임 DB 는 `data/rss-discord-bridge.sqlite`(+ `-wal`/`-shm`). 정지 또는 일관 스냅샷 후 백업.
- **번역 켜기**: `.env` 에 키 입력 후 `systemctl restart`. (역할 기반: primary / fallback)
- **HOST 변경 금지**: production 에서 `127.0.0.1`/`localhost`/`::1` 외 값이면 기동이 실패한다(의도된 안전장치).
  외부 노출이 꼭 필요하면 앱이 아니라 **앞단에 리버스 프록시**(nginx 등)를 두고 TLS·인증을 별도로 구성한다.
- **포트 충돌**: 8080 사용 중이면 `.env` PORT 변경 후 재시작(터널 포트도 함께 조정).
