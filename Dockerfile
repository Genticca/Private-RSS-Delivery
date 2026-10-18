# syntax=docker/dockerfile:1

# 빌드 단계: better-sqlite3 네이티브 모듈을 실행 단계와 같은 OS·Node로 빌드한다.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.base.json tsconfig.server.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# 실행 단계: 빌드 결과와 운영 의존성만 담는다. 기본값은 직접 설치와 같은 loopback 바인딩이다.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/app/data/rss-discord-bridge.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# npm을 거치지 않고 node를 직접 실행해야 SIGTERM이 앱에 바로 전달된다.
CMD ["node", "dist/server/main.js"]
