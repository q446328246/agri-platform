import 'reflect-metadata';

import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';

import { createAuthHttpServer } from './http.js';
import { InMemorySessionRepository, SqlSessionRepository } from './session.repository.js';
import type { SessionRepository } from './session.repository.js';
import { InMemoryUserRepository, seedUsers, SqlUserRepository } from './user.repository.js';
import type { UserRepository } from './user.repository.js';

/**
 * 认证服务启动。
 *
 * 有数据库时账号与会话均落库（auth_users / auth_user_roles / auth_sessions），
 * 启动期幂等写入内置管理员并清理过期会话；没有数据库时回落到内存实现，
 * 本地仍可登录与演示账号管理（重启后会话丢失）。
 */

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
  if (mode === 'sql') {
    client = PgClientAdapter.fromUrl(resolveDatabaseUrl(process.env.DB_URL));
    await client.$connect();
    users = new SqlUserRepository(client);
    sessions = new SqlSessionRepository(client);
    await users.seed(seedUsers());
    const pruned = await sessions.prune(new Date().toISOString());
    if (pruned > 0) console.log(`已清理 ${pruned} 条过期会话`);
  } else {
    users = new InMemoryUserRepository(seedUsers());
    sessions = new InMemorySessionRepository();
  }

  const server = createAuthHttpServer({ users, sessions });
  server.listen(port, '127.0.0.1', () => console.log(`auth-service HTTP started on ${port}（${mode === 'sql' ? 'SQL 持久化' : '内存实现'}）`));

  const shutdown = async (): Promise<void> => {
    server.close();
    await client?.$disconnect();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

await bootstrap();
