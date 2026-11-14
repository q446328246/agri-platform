/**
 * 系统恢复：从 scripts/backup-system.mjs 产出的备份恢复代码与数据库。
 *
 * 用法（在仓库根目录执行）：
 *   pnpm restore:system -- --list                                    列出可用备份
 *   pnpm restore:system -- --from 20261114-120000 --only code       恢复代码
 *   pnpm restore:system -- --from 20261114-120000 --target ./out   指定代码恢复目录
 *   pnpm restore:system -- --from 20261114-120000 --db agri_test   恢复到指定数据库
 *
 * 代码恢复解压备份包到目标目录；数据库恢复用 pg_restore（本机优先，其次 docker compose exec）。
 * 仅做恢复，备份见 scripts/backup-system.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const listOnly = args.includes("--list");
const from = flagValue("--from");
const only = flagValue("--only");
const target = path.resolve(flagValue("--target") ?? path.join(root, "restore"));
const targetDb = flagValue("--db");
const backupDir = path.resolve(flagValue("--dir") ?? process.env.BACKUP_DIR ?? path.join(root, "backups"));

function log(message) { console.log(message); }
function warn(message) { console.warn(message); }
function fail(message) { console.error(message); }

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, code: null, stdout, stderr, error }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr, error: null }));
  });
}

async function commandAvailable(command) {
  const probe = await run(command, ["--version"]);
  return probe.error === null;
}

function resolveBackup(id) {
  const candidate = path.resolve(id);
  if (fs.existsSync(path.join(candidate, "manifest.json"))) {
    return candidate;
  }
  const nested = path.join(backupDir, id);
  if (fs.existsSync(path.join(nested, "manifest.json"))) {
    return nested;
  }
  return null;
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) {
    log("暂无备份目录：" + dir);
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of entries) {
    const manifestPath = path.join(dir, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) { continue; }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    log(name + "  commit=" + (manifest.commit ? manifest.commit.slice(0, 12) : "-"));
  }
}

function parseDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port || "5432",
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, "") || "agri",
    };
  } catch {
    return null;
  }
}

async function restoreCode(manifest, backupPath) {
  const codePart = (manifest.parts || []).find((part) => part.name.startsWith("code-"));
  if (!codePart) {
    fail("该备份不含代码包");
    return false;
  }
  const archive = path.join(backupPath, codePart.path);
  fs.mkdirSync(target, { recursive: true });
  const result = await run("tar", ["-xzf", archive, "-C", target]);
  if (!result.ok) {
    fail("代码恢复失败：" + (result.stderr.trim() || "tar 执行失败"));
    return false;
  }
  log("代码已恢复到：" + target);
  return true;
}

async function restoreDatabase(manifest, backupPath) {
  const dbPart = (manifest.parts || []).find((part) => part.name.startsWith("db-"));
  if (!dbPart) {
    fail("该备份不含数据库包");
    return false;
  }
  const dumpFile = path.join(backupPath, dbPart.path);
  const databaseUrl = process.env.DB_URL ?? process.env.DATABASE_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
  const database = parseDatabaseUrl(databaseUrl);
  if (!database) {
    fail("无法解析数据库连接串：" + databaseUrl);
    return false;
  }
  const targetDatabase = targetDb || database.database;

  if (await commandAvailable("pg_restore")) {
    const result = await run(
      "pg_restore",
      ["-h", database.host, "-p", database.port, "-U", database.user, "-d", targetDatabase, "-f", dumpFile],
      { env: { ...process.env, PGPASSWORD: database.password || "" } },
    );
    if (!result.ok) {
      fail("数据库恢复失败（pg_restore）：" + (result.stderr.trim() || "未知错误"));
      return false;
    }
    log("数据库已恢复到：" + targetDatabase + "（pg_restore）");
    return true;
  }

  if (await commandAvailable("docker") && fs.existsSync(path.join(root, "infra/docker-compose.yml"))) {
    const child = spawn(
      "docker",
      ["compose", "-f", "infra/docker-compose.yml", "exec", "-T", "postgres", "pg_restore", "-d", targetDatabase],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PGPASSWORD: database.password || "" },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const input = fs.createReadStream(dumpFile);
    input.on("error", () => child.kill());
    input.pipe(child.stdin);
    return new Promise((resolve) => {
      child.on("error", (error) => {
        fail("数据库恢复失败（docker compose）：" + error.message);
        resolve(false);
      });
      child.on("close", (code) => {
        if (code === 0) {
          log("数据库已恢复到：" + targetDatabase + "（docker compose exec postgres）");
          resolve(true);
        } else {
          fail("数据库恢复失败（docker compose）：" + (stderr.trim() || "未知错误"));
          resolve(false);
        }
      });
    });
  }

  fail("未找到可用的数据库恢复方式：本机既没有 pg_restore，也没有 docker 与 infra/docker-compose.yml");
  return false;
}

async function main() {
  if (listOnly) {
    listBackups(backupDir);
    return;
  }
  if (!from) {
    fail("请用 --from 指定备份目录名或路径（先执行 pnpm restore:system -- --list 查看）");
    process.exit(1);
    return;
  }
  const backupPath = resolveBackup(from);
  if (!backupPath) {
    fail("未找到备份：" + from);
    process.exit(1);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, "manifest.json"), "utf8"));
  log("使用备份：" + backupPath);
  const results = [];
  if (only !== "db") {
    results.push(await restoreCode(manifest, backupPath));
  }
  if (only !== "code") {
    results.push(await restoreDatabase(manifest, backupPath));
  }
  if (results.every(Boolean)) {
    log("系统恢复完成");
    return;
  }
  process.exitCode = 1;
}

await main();
