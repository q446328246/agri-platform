# 本地基础设施

在项目根目录执行：

```bash
docker compose -f infra/docker-compose.yml up -d
```

PostgreSQL 使用 `agri/agri` 账号创建 `agri` 数据库，并自动执行 `infra/postgres/001_initial_schema.sql`。后续变更在 `infra/postgres/migrations` 下按编号递增追加（当前已到 007，包含决策/遥测、事件总线、账号角色、控制指令、消息偏好与登录会话）。MinIO 控制台地址为 `http://127.0.0.1:9001`，默认账号为 `minioadmin/minioadmin`。

数据库已运行时，也可以使用标准迁移命令：

```powershell
$env:DB_URL = "postgresql://agri:agri@127.0.0.1:5432/agri"
pnpm db:migrate
```

数据库连接串：

```text
postgresql://agri:agri@127.0.0.1:5432/agri
```

文件服务使用 MinIO 时设置 `FILE_STORAGE_MODE=s3`，并按根目录 `.env.example` 配置 S3 参数。MinIO 启动后执行 `pnpm init:minio` 自动创建 `agri` bucket。

服务编排支持端口覆盖，例如：

```powershell
$env:AGRI_AUTH_PORT = "3101"
$env:AGRI_GATEWAY_PORT = "8180"
pnpm start:services
pnpm health:services
```

网关也支持直接使用 `AUTH_SERVICE_URL`、`PLOT_SERVICE_URL` 等环境变量覆盖下游地址。

## 应用部署（应用 + 反代）

镜像由仓库根目录的 `Dockerfile` 构建，两个目标：

| 目标 | 内容 |
| --- | --- |
| `app` | 全部 15 个 HTTP 服务在单容器内由 `scripts/start-services.mjs` 拉起，仅网关对外监听 |
| `edge` | nginx：前端静态资源、`/api` 反代到网关、HTTPS 终止 |

```powershell
# 0) 若 docker.io 不可直连：先把基础镜像经镜像源拉下来，重打成 Dockerfile 里的官方 tag
#    已在本机验证 docker.m.daocloud.io / docker.1ms.run 可用
docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
docker tag  docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim
docker pull docker.m.daocloud.io/library/nginx:1.27-alpine
docker tag  docker.m.daocloud.io/library/nginx:1.27-alpine nginx:1.27-alpine

# 1) 构建（首次包含依赖安装与全量编译，约 3-5 分钟）
$env:VITE_TIANDITU_KEY="<天地图 Key>"; docker compose -f infra/docker-compose.yml --profile app build app edge

# 2) 起服务（基础设施 + 应用 + 反代）
docker compose -f infra/docker-compose.yml --profile app up -d

# 3) 查看状态与日志
docker compose -f infra/docker-compose.yml --profile app ps
docker compose -f infra/docker-compose.yml logs -f app
```

访问 `https://localhost`（镜像内为自签证书，浏览器需确认信任；`http://localhost` 会 301 到 HTTPS）。默认账号 `admin / admin123`，可先用 `curl.exe -k https://localhost/healthz` 与登录接口验证链路。

- 应用容器启动时依次执行 `node scripts/migrate-postgres.mjs`、`node scripts/init-minio.mjs`，再拉起服务，因此首次启动会自动建表与建 bucket。
- 只有网关绑定 `0.0.0.0`（`SERVICE_HOST=0.0.0.0`），其余服务仍监听容器回环地址，不随端口映射暴露。
- 部署环境固定 `AUTH_GUARD_MODE=enforce`、`GATEWAY_AUTH_ENABLED=true`；`INTERNAL_TOKEN`、`AUTH_SESSION_TTL_SECONDS`、`DB_POOL_SIZE` 可由环境变量覆盖。
- 前端地图 Key 通过构建参数传入：`$env:VITE_TIANDITU_KEY="..."; docker compose ... build`；未传时回落到 `apps/web/.env`（Dockerfile 会在参数为空时 `unset`，避免空值覆盖）。
- 生产证书：把 `fullchain.pem` / `privkey.pem` 放到 `infra/certs`，取消 `edge` 服务里 `./certs:/etc/nginx/tls:ro` 的注释。
- 迁移在应用容器启动阶段执行，因此 `app` 按单副本设计；需要多副本时应把迁移拆成独立的 `job` 再扩副本。
- 构建依赖 Docker Hub 与 npm 源：若 `docker pull` 报 `registry-1.docker.io ... EOF`（表现为域名解析到 `198.18.x` 后 TLS 失败），按上面第 0 步用镜像源拉取并重打 tag，无需修改 Dockerfile。
- 本机已实测通过（2026-11-05）：两镜像构建成功、`app`/`edge` healthy、登录与 22 个业务接口 200、`POST /api/v1/plots` 201 并落库、`docker compose restart app` 后旧 token 与数据仍有效。
