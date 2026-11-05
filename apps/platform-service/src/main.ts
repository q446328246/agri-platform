import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';

import { createPlatformHttpServer } from './http.js';
import { InMemoryAuditRepository, InMemoryRoleRepository, seedRoles, SqlAuditRepository, SqlRoleRepository } from './role.repository.js';
import type { AuditRepository, RoleRepository } from './role.repository.js';

/**
 * 平台服务启动。
 *
 * 有数据库时角色与审计日志落库（platform_roles / platform_role_permissions /
 * platform_audit_logs），启动期幂等写入内置角色；没有数据库时回落到内存实现。
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
  if (mode === 'sql') {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    roles = new SqlRoleRepository(client);
    audits = new SqlAuditRepository(client);
    await roles.seed(seedRoles());
  } else {
    roles = new InMemoryRoleRepository(seedRoles());
    audits = new InMemoryAuditRepository();
  }

  const server = createPlatformHttpServer({ roles, audits });
  server.listen(port, '127.0.0.1', () => console.log(`platform-service HTTP started on ${port}（${mode === 'sql' ? 'SQL 持久化' : '内存实现'}）`));

  const shutdown = async (): Promise<void> => {
    server.close();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
