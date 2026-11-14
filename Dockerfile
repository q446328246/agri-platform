# 平台镜像：一个 Dockerfile 两个可部署目标
#
#   --target app   ：全部 15 个 HTTP 服务（单容器进程内编排，仅网关对外）
#   --target edge  ：nginx 反代 + 前端静态资源 + HTTPS 终止
#
# 构建上下文必须是仓库根目录：
#   docker build -t agri-platform:local --target app .

FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@11.22.0
WORKDIR /app

# 先拷清单再装依赖，源码变动可复用依赖层
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# 迁移 SQL 随镜像携带，运行容器启动时执行
COPY infra/postgres ./infra/postgres
RUN pnpm install --frozen-lockfile

# 前端地图 Key 由构建参数注入；未传时必须 unset，否则空值会盖掉 apps/web/.env 里的 Key
ARG VITE_TIANDITU_KEY=""
RUN pnpm run build
RUN if [ -z "$VITE_TIANDITU_KEY" ]; then unset VITE_TIANDITU_KEY; fi; pnpm --filter @agri/web build

# 运行镜像按生产依赖重装：不把 tsc/vitest 等开发依赖带进线上
RUN find . -name node_modules -type d -prune -exec rm -rf {} +

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@11.22.0
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc /app/tsconfig.json /app/turbo.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
# 脚本与迁移 SQL 直接取构建上下文
COPY scripts ./scripts
COPY infra/postgres ./infra/postgres
RUN pnpm install --prod --frozen-lockfile

# 系统备份需要 pg_dump/pg_restore：容器内直接连接 postgres 做物理备份与恢复
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
# 迁移与 bucket 初始化都是幂等的，容器启动时先补齐基础设施再拉起服务
CMD ["sh", "-c", "node scripts/migrate-postgres.mjs && node scripts/init-minio.mjs && node scripts/start-services.mjs"]

FROM nginx:1.27-alpine AS edge
# 默认生成自签证书，保证 compose 开箱可访问；生产把正式证书挂到 /etc/nginx/tls 覆盖
RUN apk add --no-cache openssl \
 && mkdir -p /etc/nginx/tls \
 && openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout /etc/nginx/tls/privkey.pem \
      -out /etc/nginx/tls/fullchain.pem \
      -subj "/CN=agri.local" \
      -addext "subjectAltName=DNS:localhost,DNS:agri.local,IP:127.0.0.1" \
 && rm -rf /var/cache/apk/*

COPY infra/edge/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
