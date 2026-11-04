/**
 * PostgreSQL 版本化迁移。
 *
 * 迁移文件统一放在 infra/postgres/migrations 目录，按文件名的版本号升序执行；
 * 已应用的版本记录在 schema_migrations 表，重复执行只跑未应用的部分。
 * 每个迁移文件在单个事务中执行，失败即整体回滚，不会留下半套表结构。
 *
 * 用法：
 *   pnpm db:migrate                     按顺序执行全部未应用迁移
 *   pnpm db:migrate -- --status         仅查看迁移状态
 *   pnpm db:migrate -- --target 002_x   只执行到指定版本（含）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DB_URL ?? process.env.DATABASE_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
const migrationsDir = path.join(root, "infra/postgres/migrations");

if (!fs.existsSync(migrationsDir)) {
  console.error(`未找到迁移目录: ${migrationsDir}`);
  process.exitCode = 1;
  process.exit(process.exitCode || 0);
}

let Client;
try {
  ({ Client } = await import("pg"));
} catch {
  console.error("未找到 pg 驱动，请先执行 pnpm install");
  process.exitCode = 1;
  process.exit(1);
}

const files = fs
  .readdirSync(migrationsDir)
  .filter((name) => /\.sql$/i.test(name))
  .sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));

const showStatus = args.includes("--status");
const targetIndex = args.indexOf("--target");
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((row) => String(row.version)));
  const pending = files.filter((name) => !applied.has(name) && (target === undefined || name <= target));
  if (showStatus) {
    console.log(`迁移目录: ${migrationsDir}`);
    for (const name of files) console.log(`${applied.has(name) ? "已应用" : "待应用"}  ${name}`);
    process.exitCode = 0;
  } else if (pending.length === 0) {
    console.log("数据库迁移已是最新，无需执行");
  } else {
    for (const name of pending) {
      const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
      const started = Date.now();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log(`已应用 ${name}（${Date.now() - started} ms）`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(`迁移失败 ${name}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        break;
      }
    }
  }
} catch (error) {
  console.error(`迁移执行失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
