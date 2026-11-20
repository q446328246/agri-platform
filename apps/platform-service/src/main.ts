import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';
import { EventLogPublisher, PgEventLogStore } from '@agri/mq';

import { createPlatformHttpServer } from './http.js';
import { InMemoryAuditRepository, InMemoryRoleRepository, resolveAuditRetentionDays, seedRoles, SqlAuditRepository, SqlRoleRepository } from './role.repository.js';
import type { AuditRepository, RoleRepository } from './role.repository.js';
import { InMemoryDataCatalogRepository, seedDataCatalog, SqlDataCatalogRepository } from './data-catalog.repository.js';
import type { DataCatalogRepository } from './data-catalog.repository.js';
import { InMemoryMonitorRepository, seedMonitorRules, SqlMonitorRepository } from './monitor.repository.js';
import type { MonitorRepository } from './monitor.repository.js';
import { buildDefaultTargets, createMonitorEngine } from './monitor.js';
import type { MonitorEngine } from './monitor.js';

/**
 * 平台服务启动。
 *
 * 有数据库时角色与审计日志落库（platform_roles / platform_role_permissions /
 * platform_audit_logs），启动期幂等写入内置角色；没有数据库时回落到内存实现。
 *
 * 审计留存策略（开发方案 14.4）：日志至少留存 180 天（AUDIT_RETENTION_DAYS 可加长），
 * 超过留存期的行由定时清理任务删除；启动即跑一轮，之后按
 * AUDIT_RETENTION_SWEEP_INTERVAL_MS（缺省 24 小时）周期执行。
 */

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== 'http') {
    console.log('platform-service service started (demo mode)');
    return;
  }

  const port = Number(process.env.PORT ?? 3014);
  const mode = process.env.PLATFORM_REPOSITORY_MODE === 'memory' || !process.env.DB_URL ? 'memory' : 'sql';

  let client: PgClientAdapter | undefined;
  let roles: RoleRepository;
  let audits: AuditRepository;
  let catalog: DataCatalogRepository;
  let monitor: MonitorRepository;
  if (mode === 'sql') {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    roles = new SqlRoleRepository(client);
    audits = new SqlAuditRepository(client);
    await roles.seed(seedRoles());
    // 数据目录种子随迁移 058 落库（只写不应用，部署点名后生效），启动期不重复写入
    catalog = new SqlDataCatalogRepository(client);
    monitor = new SqlMonitorRepository(client);
  } else {
    roles = new InMemoryRoleRepository(seedRoles());
    audits = new InMemoryAuditRepository();
    catalog = new InMemoryDataCatalogRepository(seedDataCatalog());
    monitor = new InMemoryMonitorRepository({ rules: seedMonitorRules() });
  }

  // 运维巡检（F3）：SQL 模式告警/恢复经事件日志投递给消息中心；内存模式只更新状态与台账
  const db = client;
  let engine: MonitorEngine | undefined;
  if (process.env.MONITOR_ENABLED !== 'false') {
    const publisher = db
      ? new EventLogPublisher(new PgEventLogStore(db), { tenantId: process.env.TENANT_ID?.trim() || 'tenant-demo', traceId: 'platform-monitor', producer: 'platform' })
      : undefined;
    engine = createMonitorEngine({
      repository: monitor,
      targets: buildDefaultTargets({
        ...(db ? { probeDb: async (): Promise<void> => { await db.$queryRawUnsafe('SELECT 1'); } } : {}),
      }),
      ...(publisher ? { publish: async (topic, payload): Promise<void> => { await publisher.publish(topic, payload); } } : {}),
      intervalMs: Number(process.env.MONITOR_INTERVAL_MS ?? 30_000),
      onError: (error) => console.error('[platform-service] 运维巡检异常', error.message),
    });
    engine.start();
  }

  const server = createPlatformHttpServer({ roles, audits, catalog, monitor, ...(engine ? { monitorCheck: engine.checkNow } : {}) });
  server.listen(port, '127.0.0.1', () => console.log(`platform-service HTTP started on ${port}（${mode === 'sql' ? 'SQL 持久化' : '内存实现'}）`));

  // 审计留存清理：只删超过留存期的行，留存期内的审计一条不动
  const retentionDays = resolveAuditRetentionDays();
  const sweepIntervalMs = Number(process.env.AUDIT_RETENTION_SWEEP_INTERVAL_MS ?? 24 * 3600_000);
  const sweepAudit = async (): Promise<void> => {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString();
    try {
      const removed = await audits.purgeBefore(cutoff);
      if (removed > 0) console.log(`[platform-service] 审计留存清理：删除 ${cutoff} 之前的 ${removed} 条日志（留存 ${retentionDays} 天）`);
    } catch (error) {
      console.error('[platform-service] 审计留存清理失败', error instanceof Error ? error.message : error);
    }
  };
  await sweepAudit();
  const sweepTimer = setInterval(() => void sweepAudit(), sweepIntervalMs);

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepTimer);
    engine?.stop();
    server.close();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
