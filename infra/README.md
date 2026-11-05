# 本地基础设施

在项目根目录执行：

```bash
docker compose -f infra/docker-compose.yml up -d
```

PostgreSQL 使用 `agri/agri` 账号创建 `agri` 数据库，并自动执行 `infra/postgres/001_initial_schema.sql`。后续变更在 `infra/postgres/migrations` 下按编号递增追加（当前已到 006，包含决策/遥测、事件总线、账号角色、控制指令与消息偏好）。MinIO 控制台地址为 `http://127.0.0.1:9001`，默认账号为 `minioadmin/minioadmin`。

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
