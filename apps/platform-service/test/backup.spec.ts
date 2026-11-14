import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

import { createPlatformHttpServer } from "../src/http.js";
import { backupDir, backupScript, listBackups, readBackup, removeBackup, restoreScript, runBackup, runRestore } from "../src/backup.js";

// 源码位于 <repo>/apps/platform-service/test，上溯三级即仓库根
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const servers: Server[] = [];
let backupRoot: string;
let argsOut: string;
let saved: Record<string, string | undefined> = {};

function writeManifest(id: string): void {
  const dir = path.join(backupRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id,
      createdAt: "2026-11-13T00:00:00.000Z",
      root: backupRoot,
      host: "test",
      tag: "",
      commit: "abc123",
      branch: "main",
      dirty: false,
      includeSecrets: false,
      parts: [{ name: "code", path: "code.tgz", bytes: 1, sha256: "deadbeef" }],
      database: { name: "agri", mode: "custom" },
    }, null, 2),
  );
}

/** 假脚本：把收到的参数写到 FAKE_ARGS_OUT 并回显，用于校验参数组装 */
function writeFakeScript(name: string): string {
  const file = path.join(backupRoot, name);
  fs.writeFileSync(
    file,
    [
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      'fs.writeFileSync(process.env.FAKE_ARGS_OUT ?? "", JSON.stringify(args));',
      'process.stdout.write("fake:" + args.join(","));',
    ].join("\n"),
  );
  return file;
}

function readArgs(): string[] {
  return JSON.parse(fs.readFileSync(argsOut, "utf8")) as string[];
}

async function start(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未分配端口");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agri-backup-"));
  argsOut = path.join(backupRoot, "args.json");
  saved = {
    BACKUP_DIR: process.env.BACKUP_DIR,
    BACKUP_SCRIPT: process.env.BACKUP_SCRIPT,
    RESTORE_SCRIPT: process.env.RESTORE_SCRIPT,
    FAKE_ARGS_OUT: process.env.FAKE_ARGS_OUT,
    AUTH_GUARD_MODE: process.env.AUTH_GUARD_MODE,
  };
  process.env.BACKUP_DIR = backupRoot;
  process.env.FAKE_ARGS_OUT = argsOut;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
});

describe("系统备份模块", () => {
  it("默认脚本路径与备份目录都解析到仓库根", () => {
    // 临时清掉覆盖项，验证模块默认值落在仓库根（回归 repoRoot 层级）
    const overrides = { BACKUP_DIR: process.env.BACKUP_DIR, BACKUP_SCRIPT: process.env.BACKUP_SCRIPT, RESTORE_SCRIPT: process.env.RESTORE_SCRIPT };
    for (const key of Object.keys(overrides)) delete process.env[key];
    try {
      expect(backupScript()).toBe(path.join(repoRoot, "scripts/backup-system.mjs"));
      expect(restoreScript()).toBe(path.join(repoRoot, "scripts/restore-system.mjs"));
      expect(backupDir()).toBe(path.join(repoRoot, "backups"));
      expect(fs.existsSync(backupScript())).toBe(true);
      expect(fs.existsSync(restoreScript())).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(overrides)) if (value !== undefined) process.env[key] = value;
    }
  });

  it("空目录返回空清单，跳过没有 manifest 的目录，按名称倒序返回", () => {
    expect(listBackups()).toEqual([]);
    fs.mkdirSync(path.join(backupRoot, "no-manifest"), { recursive: true });
    expect(listBackups()).toEqual([]);
    writeManifest("backup-a");
    writeManifest("backup-b");
    expect(listBackups().map((item) => item.id)).toEqual(["backup-b", "backup-a"]);
  });

  it("详情按 id 读取，非法与不存在的 id 一律返回 null", () => {
    writeManifest("backup-a");
    const found = readBackup("backup-a");
    expect(found?.id).toBe("backup-a");
    expect(found?.database).toMatchObject({ name: "agri" });
    expect(readBackup("missing")).toBeNull();
    // 路径穿越与非法字符必须被拒绝
    expect(readBackup("../secret")).toBeNull();
    expect(readBackup("a/b")).toBeNull();
    expect(readBackup("")).toBeNull();
  });

  it("删除备份：存在返回 true，不存在或非法 id 返回 false", () => {
    writeManifest("backup-a");
    expect(removeBackup("backup-a")).toBe(true);
    expect(fs.existsSync(path.join(backupRoot, "backup-a"))).toBe(false);
    expect(removeBackup("backup-a")).toBe(false);
    expect(removeBackup("../secret")).toBe(false);
  });
});

describe("备份/恢复脚本参数组装", () => {
  it("runBackup 把选项转成脚本参数", async () => {
    process.env.BACKUP_SCRIPT = writeFakeScript("backup-fake.mjs");
    const plain = await runBackup();
    expect(plain.exitCode).toBe(0);
    expect(readArgs()).toEqual(["--"]);

    await runBackup({ dbOnly: true, keep: 5 });
    expect(readArgs()).toEqual(["--", "--db-only", "--keep", "5"]);

    await runBackup({ codeOnly: true, includeSecrets: true });
    expect(readArgs()).toEqual(["--", "--code-only", "--include-secrets"]);
  });

  it("runRestore 把选项转成脚本参数", async () => {
    process.env.RESTORE_SCRIPT = writeFakeScript("restore-fake.mjs");
    await runRestore({ from: "backup-1" });
    expect(readArgs()).toEqual(["--from", "backup-1"]);

    await runRestore({ from: "backup-1", only: "db", target: "/srv/restore", db: "agri_prod" });
    expect(readArgs()).toEqual(["--from", "backup-1", "--only", "db", "--target", "/srv/restore", "--db", "agri_prod"]);
  });
});

describe("备份 HTTP 接口", () => {
  it("清单接口按 system:backup 权限放行与拒绝", async () => {
    writeManifest("backup-a");
    process.env.AUTH_GUARD_MODE = "enforce";
    const base = await start(createPlatformHttpServer());

    const anonymous = await fetch(`${base}/api/v1/platform/backups`);
    expect(anonymous.status).toBe(401);

    const noPermission = await fetch(`${base}/api/v1/platform/backups`, { headers: { "x-user-id": "u1", "x-permissions": "system:role" } });
    expect(noPermission.status).toBe(403);

    const ok = await fetch(`${base}/api/v1/platform/backups`, { headers: { "x-user-id": "u1", "x-permissions": "system:backup" } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual(["backup-a"]);
  });

  it("删除接口按权限删除，未知与非法 id 返回 404", async () => {
    writeManifest("backup-a");
    writeManifest("backup-b");
    process.env.AUTH_GUARD_MODE = "enforce";
    const base = await start(createPlatformHttpServer());
    const headers = { "x-user-id": "u1", "x-permissions": "system:backup" };

    const deleted = await fetch(`${base}/api/v1/platform/backups/backup-a`, { method: "DELETE", headers });
    expect(deleted.status).toBe(200);
    expect(listBackups().map((item) => item.id)).toEqual(["backup-b"]);

    const missing = await fetch(`${base}/api/v1/platform/backups/nope`, { method: "DELETE", headers });
    expect(missing.status).toBe(404);

    // 编码后的路径穿越不能命中任何目录
    const illegal = await fetch(`${base}/api/v1/platform/backups/${encodeURIComponent("../secret")}`, { method: "DELETE", headers });
    expect(illegal.status).toBe(404);
  });
});
