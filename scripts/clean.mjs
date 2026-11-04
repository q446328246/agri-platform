import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 清理各子工程的构建产物。
 * node_modules 由包管理器负责，本脚本只处理 dist 与增量编译信息，
 * 避免「清理」意外删除依赖导致需要重新安装。
 */
const root = dirname(fileURLToPath(new URL(".", import.meta.url)));

async function cleanProject(dir) {
  await rm(join(dir, "dist"), { recursive: true, force: true });
  await rm(join(dir, "tsconfig.tsbuildinfo"), { force: true });
}

async function main() {
  for (const group of ["packages", "apps"]) {
    let entries = [];
    try {
      entries = await readdir(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await cleanProject(join(root, group, entry.name));
      }
    }
  }
  process.stdout.write("已清理各子工程的 dist 与 tsconfig.tsbuildinfo\n");
}

await main();
