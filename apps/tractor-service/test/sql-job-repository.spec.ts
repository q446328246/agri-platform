import { describe, expect, it } from "vitest";
import { PgClientAdapter } from "@agri/db";

import { SqlTractorJobRepository } from "../src/job.repository.js";

const databaseUrl = process.env.DB_URL;

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
      expect(await repository.claimJob(tenantId, job.id, "owner-a", 60_000)).not.toBeNull();
      expect(await repository.updateJob(tenantId, job.id, { status: "RUNNING" }, { expectedStatus: "PLANNED", owner: "owner-a" })).toMatchObject({ status: "RUNNING" });
      expect(await repository.updateStage(tenantId, stage.id, { status: "SENT", commandId: "cmd-smoke" }, { expectedStatus: "PENDING", owner: "owner-a" })).toMatchObject({ status: "SENT", commandId: "cmd-smoke" });
      expect(await repository.updateJob(tenantId, job.id, { status: "FAILED" }, { expectedStatus: "RUNNING", owner: "owner-b" })).toBeNull();
      expect(await repository.updateStage(tenantId, stage.id, { status: "FAILED" }, { expectedStatus: "SENT", owner: "owner-b" })).toBeNull();

      await client.$executeRawUnsafe("UPDATE tractor_jobs SET execution_until = now() - interval '1 second' WHERE id = $1", job.id);
      expect(await repository.claimJob(tenantId, job.id, "owner-b", 60_000, "RUNNING")).not.toBeNull();
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
