import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";
import { ValidationError } from "@agri/shared";

import { SqlFileRepository } from "../src/file.repository.js";

/**
 * 真实库冒烟：DB_URL 存在时执行，覆盖迁移 017 的表结构、唯一约束、
 * 单语句分页快照与租户隔离。
 */
const databaseUrl = process.env.DB_URL;

describe.runIf(databaseUrl)("SqlFileRepository（真实库）", () => {
  it("元数据写入、唯一约束、分页快照、租户隔离与删除", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlFileRepository(client);
    const suffix = Date.now();
    const tenantId = `tenant-smoke-file-${suffix}`;
    const otherTenant = `tenant-smoke-file-other-${suffix}`;
    const base = Date.now();
    const ids = [`file-smoke-a-${suffix}`, `file-smoke-b-${suffix}`, `file-smoke-c-${suffix}`, `file-smoke-x-${suffix}`];
    const dupId = `file-smoke-dup-${suffix}`;
    const meta = (id: string, tenant: string, offsetMs: number) => ({
      id, tenantId: tenant, name: `${id}.png`, contentType: "image/png", size: 1024,
      storageKey: `files/${tenant}/${id}`, createdAt: new Date(base + offsetMs).toISOString(),
    });
    try {
      const first = await repository.create(meta(ids[0]!, tenantId, 0));
      expect(first.createdAt).toBe(new Date(base).toISOString());
      expect(first.storageKey).toBe(`files/${tenantId}/${ids[0]}`);
      await repository.create(meta(ids[1]!, tenantId, 1_000));
      await repository.create(meta(ids[2]!, tenantId, 2_000));
      await repository.create(meta(ids[3]!, otherTenant, 0));

      await expect(repository.create(meta(ids[0]!, tenantId, 5_000))).rejects.toThrow();
      await expect(repository.create({ ...meta(dupId, tenantId, 5_000), storageKey: first.storageKey })).rejects.toThrow();

      const page1 = await repository.page({ tenantId, page: 1, size: 2 });
      expect(page1.total).toBe(3);
      expect(page1.pages).toBe(2);
      expect(page1.items.map((file) => file.id)).toEqual([ids[2], ids[1]]);
      const page2 = await repository.page({ tenantId, page: 2, size: 2 });
      expect(page2.items.map((file) => file.id)).toEqual([ids[0]]);
      const beyond = await repository.page({ tenantId, page: 99, size: 2 });
      expect(beyond.items).toEqual([]);
      expect(beyond.total).toBe(3);

      expect((await repository.findById(ids[0]!, tenantId))?.storageKey).toBe(first.storageKey);
      expect(await repository.findById(ids[0]!, otherTenant)).toBeNull();
      expect(await repository.delete(ids[0]!, otherTenant)).toBe(false);
      expect(await repository.delete(ids[0]!, tenantId)).toBe(true);
      expect(await repository.findById(ids[0]!, tenantId)).toBeNull();
      expect((await repository.page({ tenantId, page: 1, size: 10 })).total).toBe(2);

      await expect(repository.page({ tenantId, page: 0, size: 10 })).rejects.toBeInstanceOf(ValidationError);
      await expect(repository.page({ tenantId, page: 1, size: 201 })).rejects.toBeInstanceOf(ValidationError);
      await expect(repository.page({ tenantId: "  ", page: 1, size: 10 })).rejects.toBeInstanceOf(ValidationError);
      await expect(repository.create(meta(`file-smoke-empty-${suffix}`, " ", 0))).rejects.toBeInstanceOf(ValidationError);
    } finally {
      for (const id of [...ids, dupId, `file-smoke-empty-${suffix}`]) {
        await client.$executeRawUnsafe("DELETE FROM file_metadata WHERE id = $1", id);
      }
      await client.$disconnect();
    }
  });
});