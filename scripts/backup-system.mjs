/**
 * 系统备份：代码 + 数据库 + 配置，统一清单与保留策略。
 *
 * 用法（在仓库根目录执行）：
 *   pnpm backup:system                        全量备份（代码 + 数据库 + 配置）
 *   pnpm backup:system -- --db-only          只备份数据库
 *   pnpm backup:system -- --code-only        只备份代码
 *   pnpm backup:system -- --include-secrets  附带 .env 与私钥等敏感配置
 *   pnpm backup:system -- --list             列出已有备份
 *   pnpm backup:system -- --keep 5           保留最近 5 份（默认 10）
 *
 * 备份产物落在 BACKUP_DIR（默认 <repo>/backups）下的 <时间戳> 目录，附 manifest.json。
 * 代码备份基于当前 Git 提交（git archive），未提交的改动不在代码包内。
 * 数据库备份优先用本机 pg_dump；本机没有时回退到 docker compose exec postgres pg_dump。
 * 仅做备份，恢复见 scripts/restore-system.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const listOnly = hasFlag("--list");
const dbOnly = hasFlag("--db-only");
const codeOnly = hasFlag("--code-only");
const includeSecrets = hasFlag("--include-secrets");
const keep = Number.parseInt(flagValue("--keep") ?? process.env.BACKUP_KEEP ?? "10", 10) || 10;
const backupDir = path.resolve(flagValue("--dir") ?? process.env.BACKUP_DIR ?? path.join(root, "backups"));
const tag = flagValue("--tag") ?? "";

if (dbOnly && codeOnly) {
  console.error("--db-only 与 --code-only 不能同时使用");
  process.exit(1);
}

function log(message) {
  console.log(message);
}

function warn(message) {
  console.warn(message);
}

function fail(message) {
  console.error(message);
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function formatTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") + "-" +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

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

function spawnToFile(command, commandArgs, outFile, env) {
  return new Promise((resolve) => {
    const output = fs.createWriteStream(outFile);
    const child = spawn(command, commandArgs, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      if (!output.write(chunk)) {
        child.stdout.pause();
      }
    });
    output.on("drain", () => child.stdout.resume());
    child.on("error", (error) => {
      output.destroy();
      resolve({ ok: false, code: null, stderr, error });
    });
    child.on("close", (code) => {
      output.end(() => resolve({ ok: code === 0, code, stderr, error: null }));
    });
  });
}

async function gitInfo() {
  const commit = await run("git", ["rev-parse", "HEAD"]);
  if (!commit.ok) {
    return null;
  }
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await run("git", ["status", "--porcelain"]);
  return {
    commit: commit.stdout.trim(),
    branch: branch.ok ? branch.stdout.trim() : "",
    dirty: status.ok && status.stdout.trim().length > 0,
  };
}

async function backupCode(parts, dir) {
  const info = await gitInfo();
  if (!info) {
    warn("代码备份跳过：当前目录不在 Git 仓库内");
    return { ok: false, reason: "not-a-git-repo" };
  }
  const short = info.commit.slice(0, 12);
  const file = path.join(dir, "code-" + short + ".tar.gz");
  const prefix = "agri-platform-" + short + "/";
  const result = await run("git", ["archive", "--format=tar.gz", "--prefix=" + prefix, "-o", file, "HEAD"]);
  if (!result.ok) {
    warn("代码备份失败：" + (result.stderr.trim() || (result.error && result.error.message) || "git archive 执行失败"));
    return { ok: false, reason: "git-archive" };
  }
  const relative = path.basename(file);
  parts.push({ name: relative, path: relative, bytes: fs.statSync(file).size, sha256: sha256File(file) });
  log("代码备份完成：" + relative + "（提交 " + short + "）");
  return { ok: true, info };
}

async function backupConfig(parts, dir, timestamp) {
  const always = [".env.example"];
  const secrets = [".env", "ed25519-private.pem"];
  const selected = always.filter((name) => fs.existsSync(path.join(root, name)));
  if (includeSecrets) {
    selected.push(...secrets.filter((name) => fs.existsSync(path.join(root, name))));
  }
  if (selected.length === 0) {
    warn("配置备份跳过：未找到 .env.example 等配置文件");
    return { ok: false, reason: "no-config" };
  }
  const listFile = path.join(dir, ".config-list-" + timestamp + ".txt");
  fs.writeFileSync(listFile, selected.join("\n"), "utf8");
  const file = path.join(dir, "config-" + timestamp + ".tar.gz");
  const result = await run("tar", ["-czf", file, "-C", root, "-T", listFile]);
  fs.rmSync(listFile, { force: true });
  if (!result.ok) {
    warn("配置备份失败：" + (result.stderr.trim() || "tar 执行失败"));
    return { ok: false, reason: "tar" };
  }
  const relative = path.basename(file);
  parts.push({ name: relative, path: relative, bytes: fs.statSync(file).size, sha256: sha256File(file), secrets: includeSecrets });
  log("配置备份完成：" + relative + (includeSecrets ? "（含敏感配置）" : ""));
  return { ok: true };
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

async function detectDbRunner() {
  if (await commandAvailable("pg_dump")) {
    return { kind: "pg_dump" };
  }
  if (await commandAvailable("docker") && fs.existsSync(path.join(root, "infra/docker-compose.yml"))) {
    return { kind: "docker" };
  }
  return null;
}

async function backupDatabase(parts, dir, timestamp) {
  const databaseUrl = process.env.DB_URL ?? process.env.DATABASE_URL ?? "postgresql://agri:agri@127.0.0.1:5432/agri";
  const database = parseDatabaseUrl(databaseUrl);
  if (!database) {
    fail("无法解析数据库连接串：" + databaseUrl);
    return { ok: false, reason: "bad-url" };
  }
  const runner = await detectDbRunner();
  if (!runner) {
    fail("未找到可用的数据库备份方式：本机既没有 pg_dump，也没有 docker 与 infra/docker-compose.yml");
    return { ok: false, reason: "no-runner" };
  }
  const file = path.join(dir, "db-" + database.database + "-" + timestamp + ".dump");
  if (runner.kind === "pg_dump") {
    const result = await spawnToFile(
      "pg_dump",
      ["-Fc", "-h", database.host, "-p", database.port, "-U", database.user, "-d", database.database, "-f", file],
      file,
      { PGPASSWORD: database.password || "" },
    );
    if (!result.ok) {
      fs.rmSync(file, { force: true });
      fail("数据库备份失败（pg_dump）：" + (result.stderr.trim() || (result.error && result.error.message) || "未知错误"));
      return { ok: false, reason: "pg_dump" };
    }
    log("数据库备份完成：" + path.basename(file) + "（pg_dump，库 " + database.database + "）");
  } else {
    const result = await spawnToFile(
      "docker",
      ["compose", "-f", "infra/docker-compose.yml", "exec", "-T", "postgres", "pg_dump", "-Fc", database.database],
      file,
    );
    if (!result.ok) {
      fs.rmSync(file, { force: true });
      fail("数据库备份失败（docker compose）：" + (result.stderr.trim() || (result.error && result.error.message) || "未知错误"));
      return { ok: false, reason: "docker" };
    }
    log("数据库备份完成：" + path.basename(file) + "（docker compose exec postgres，库 " + database.database + "）");
  }
  const relative = path.basename(file);
  parts.push({ name: relative, path: relative, bytes: fs.statSync(file).size, sha256: sha256File(file) });
  return { ok: true, database, mode: runner.kind };
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
  if (entries.length === 0) {
    log("暂无备份：" + dir);
    return;
  }
  for (const name of entries) {
    const manifestPath = path.join(dir, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      log(name + "  （缺少 manifest.json）");
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const parts = (manifest.parts || []).map((part) => part.name).join(", ") || "（空）";
    log(name + "  commit=" + (manifest.commit ? manifest.commit.slice(0, 12) : "-") + "  内容=" + parts);
  }
}

function prune(dir, keep) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const excess = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of excess) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    warn("已清理超出保留数的旧备份：" + name);
  }
}

async function main() {
  if (listOnly) {
    listBackups(backupDir);
    return;
  }
  const timestamp = formatTimestamp(new Date());
  const dir = path.join(backupDir, timestamp);
  fs.mkdirSync(dir, { recursive: true });
  log("开始系统备份，产物目录：" + dir);
  const parts = [];
  const code = dbOnly ? { ok: false, reason: "skipped" } : await backupCode(parts, dir);
  const config = dbOnly || codeOnly ? { ok: false, reason: "skipped" } : await backupConfig(parts, dir, timestamp);
  const database = codeOnly ? { ok: false, reason: "skipped" } : await backupDatabase(parts, dir, timestamp);

  const git = code && code.info ? code.info : await gitInfo();
  const manifest = {
    id: timestamp,
    createdAt: new Date().toISOString(),
    root,
    host: os.hostname(),
    tag,
    commit: git ? git.commit : null,
    branch: git ? git.branch : null,
    dirty: git ? git.dirty : null,
    includeSecrets,
    parts,
    database: database && database.ok ? { name: database.database.database, mode: database.mode } : null,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const failed = [code, config, database].filter((item) => !item.ok && item.reason !== "skipped");
  prune(backupDir, keep);
  log("备份清单：" + path.join(dir, "manifest.json"));
  if (failed.length > 0) {
    fail("备份完成，但有 " + failed.length + " 项失败：" + failed.map((item) => item.reason).join(", "));
    process.exitCode = 1;
    return;
  }
  log("系统备份完成");
}

await main();
