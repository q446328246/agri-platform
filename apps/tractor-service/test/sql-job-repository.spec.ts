import { describe, expect, it, vi } from "vitest";
import { PgClientAdapter } from "@agri/db";
import type { PrismaClientLike } from "@agri/db";

import { SqlTractorJobRepository } from "../src/job.repository.js";

const databaseUrl = process.env.DB_URL;

describe("SqlTractorJobRepository 分布式作业锁", () => {
  it("另一实例必须等待当前实例释放 PostgreSQL advisory lock", async () => {
    let locked = false;
    const client = (): PrismaClientLike => ({
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          if (locked) return [{ locked: false }];
          locked = true;
          return [{ locked: true }];
        }
        if (sql.includes("pg_advisory_unlock")) {
          locked = false;
          return [{ unlocked: true }];
        }
        throw new Error("非预期查询");
      }),
    }) as unknown as PrismaClientLike;
    const firstRepository = new SqlTractorJobRepository(client());
    const secondClient = client();
    const secondQuery = vi.mocked(secondClient.$queryRawUnsafe);
    const secondRepository = new SqlTractorJobRepository(secondClient);
    let release!: () => void;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = firstRepository.withJobLock("tenant", "job", async () => {
      entered();
      await blocked;
    });
    await firstEntered;
    let secondEntered = false;
    const second = secondRepository.withJobLock("tenant", "job", async () => { secondEntered = true; });
    await vi.waitFor(() => expect(secondQuery).toHaveBeenCalled());
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    expect(locked).toBe(false);
  });
});

describe.runIf(databaseUrl)("SqlTractorJobRepository 更新与租约（真实库）", () => {
  it("SET/WHERE 参数正确且过期执行者不能覆盖新租约", async () => {
    const client = PgClientAdapter.fromUrl(databaseUrl as string);
    await client.$connect();
    const repository = new SqlTractorJobRepository(client);
    const tenantId = "tenant-smoke-tractor-sql";
    try {
      const job = await repository.createJob(undefined, {
        tenantId, plotCode: "P-SMOKE", deviceId: "tractor-smoke", operationType: "SEEDING",
        parameters: { areaMu: 1, durationMin: 1 }, operator: "smoke", reason: "SQL 回归",
      });
      const stage = await repository.addStage(undefined, {
        tenantId, jobId: job.id, stage: "OPERATION", commandType: "SEEDING",
        parameters: { areaMu: 1, durationMin: 1 }, timeoutMs: 60_000,
      });
      expect(stage.jobId).toBe(job.id);
      const claimed = await repository.claimJob(tenantId, job.id, "owner-a", 60_000);
      expect(claimed).toMatchObject({ status: "PLANNED", revision: 0 });
      const running = await repository.updateJob(tenantId, job.id, { status: "RUNNING" }, { expectedStatus: "PLANNED", expectedRevision: claimed!.revision, owner: "owner-a" });
      expect(running).toMatchObject({ status: "RUNNING", revision: 1, runRevision: 1 });
      expect(await repository.updateJob(tenantId, job.id, { status: "FAILED" }, { expectedStatus: "RUNNING", expectedRevision: claimed!.revision, owner: "owner-a" })).toBeNull();
      expect(await repository.listJobs({ tenantId, status: "RUNNING", limit: 10, offset: 0 })).toMatchObject([{ id: job.id }]);
      expect(await repository.updateStage(tenantId, stage.id, { status: "SENT", commandId: "cmd-smoke" }, { expectedStatus: "PENDING", owner: "owner-a" })).toMatchObject({ status: "SENT", commandId: "cmd-smoke" });
      expect(await repository.updateJob(tenantId, job.id, { status: "FAILED" }, { expectedStatus: "RUNNING", owner: "owner-b" })).toBeNull();
      expect(await repository.updateStage(tenantId, stage.id, { status: "FAILED" }, { expectedStatus: "SENT", owner: "owner-b" })).toBeNull();

      await client.$executeRawUnsafe("UPDATE tractor_jobs SET execution_until = now() - interval '1 second' WHERE id = $1", job.id);
      expect(await repository.claimJob(tenantId, job.id, "owner-b", 60_000, "RUNNING")).not.toBeNull();
      expect(await repository.renewJobClaim(tenantId, job.id, "owner-b", 60_000)).toBe(true);
      expect(await repository.renewJobClaim(tenantId, job.id, "owner-a", 60_000)).toBe(false);
      expect(await repository.updateJob(tenantId, job.id, { status: "FAILED" }, { expectedStatus: "RUNNING", owner: "owner-a" })).toBeNull();
      expect(await repository.updateStage(tenantId, stage.id, { status: "DONE" }, { expectedStatus: "SENT", owner: "owner-b" })).toMatchObject({ status: "DONE" });
      expect(await repository.updateJob(tenantId, job.id, { status: "COMPLETED", currentStage: 1 }, { expectedStatus: "RUNNING", owner: "owner-b" })).toMatchObject({ status: "COMPLETED", currentStage: 1 });
      expect(await repository.updateJob("tenant-other", job.id, { status: "FAILED" })).toBeNull();
    } finally {
      await client.$executeRawUnsafe("DELETE FROM tractor_job_stages WHERE job_id IN (SELECT id FROM tractor_jobs WHERE tenant_id = $1)", tenantId);
      await client.$executeRawUnsafe("DELETE FROM tractor_jobs WHERE tenant_id = $1", tenantId);
      await client.$disconnect();
    }
  });
});
