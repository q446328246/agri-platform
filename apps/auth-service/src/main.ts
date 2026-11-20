import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';

import { createAuthHttpServer } from './http.js';
import { InMemorySessionRepository, SqlSessionRepository } from './session.repository.js';
import type { SessionRepository } from './session.repository.js';
import { InMemoryLoginAttemptRepository, SqlLoginAttemptRepository } from './login-attempt.repository.js';
import type { LoginAttemptRepository } from './login-attempt.repository.js';
import { InMemoryUserRepository, seedUsers, SqlUserRepository } from './user.repository.js';
import type { UserRepository } from './user.repository.js';

/**
 * 认证服务启动。
 *
 * 有数据库时账号、会话与登录尝试台账均落库（auth_users / auth_user_roles /
 * auth_sessions / auth_login_attempts），启动期幂等写入内置管理员并清理过期会话；
 * 没有数据库时回落到内存实现，本地仍可登录与演示账号管理（重启后会话与台账丢失）。
 */

/** 登录审计上报：经平台内部审计端点落 platform_audit_logs，失败不影响登录主流程 */
function createAuditPoster(platformUrl: string): (input: { tenantId: string; action: string; operator: string; resource: string; detail: string }) => Promise<void> {
  const internalToken = process.env.INTERNAL_TOKEN ?? 'agri-internal';
  return async (input) => {
    try {
      const response = await fetch(`${platformUrl}/api/v1/internal/platform/audit-logs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return;
    } catch {
      // 审计是旁路：平台不可用不阻断登录
    }
  };
}

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE !== 'http') {
    console.log('auth-service service started (demo mode)');
    return;
  }

  const port = Number(process.env.PORT ?? 3001);
  const mode = process.env.AUTH_REPOSITORY_MODE === 'memory' || !process.env.DB_URL ? 'memory' : 'sql';

  let client: PgClientAdapter | undefined;
  let users: UserRepository;
  let sessions: SessionRepository;
  let attempts: LoginAttemptRepository;
  if (mode === 'sql') {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    users = new SqlUserRepository(client);
    sessions = new SqlSessionRepository(client);
    attempts = new SqlLoginAttemptRepository(client);
    await users.seed(seedUsers());
    const pruned = await sessions.prune(new Date().toISOString());
    if (pruned > 0) console.log(`已清理 ${pruned} 条过期会话`);
  } else {
    users = new InMemoryUserRepository(seedUsers());
    sessions = new InMemorySessionRepository();
    attempts = new InMemoryLoginAttemptRepository();
  }

  const server = createAuthHttpServer({
    users,
    sessions,
    attempts,
    audit: createAuditPoster(process.env.PLATFORM_SERVICE_URL ?? 'http://127.0.0.1:3014'),
  });
  server.listen(port, '127.0.0.1', () => console.log(`auth-service HTTP started on ${port}（${mode === 'sql' ? 'SQL 持久化' : '内存实现'}）`));

  const shutdown = async (): Promise<void> => {
    server.close();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
