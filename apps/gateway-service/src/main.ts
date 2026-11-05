import 'reflect-metadata';
import { createGatewayAuthorizer } from './authz.js';
import { createGatewayHttpServer } from './http.js';

/**
 * 网关启动入口。
 *
 * `GATEWAY_AUTH_ENABLED` 未设或非 `false` 时开启鉴权：token 由 auth-service 解析，
 * 角色权限由 platform-service 解析，结果缓存数秒后下发给下游服务。
 */

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const port = Number(process.env.PORT ?? 8080);
    const authEnabled = process.env.GATEWAY_AUTH_ENABLED !== 'false';
    const authorizer = authEnabled
      ? createGatewayAuthorizer({
          authServiceUrl: process.env.AUTH_SERVICE_URL ?? 'http://127.0.0.1:3001',
          platformServiceUrl: process.env.PLATFORM_SERVICE_URL ?? 'http://127.0.0.1:3014',
          internalToken: process.env.INTERNAL_TOKEN ?? 'agri-internal',
          sessionTtlMs: Number(process.env.GATEWAY_AUTH_CACHE_MS ?? 5000),
          roleTtlMs: Number(process.env.GATEWAY_ROLE_CACHE_MS ?? 10000),
        })
      : undefined;
    const server = createGatewayHttpServer(authorizer ? { authorizer } : {});
    // 容器部署时网关是唯一对外入口，需要 SERVICE_HOST=0.0.0.0 才能被反代或端口映射访问；
    // 本机默认仍只监听回环地址，不把接口暴露到局域网。
    const host = process.env.SERVICE_HOST ?? '127.0.0.1';
    server.listen(port, host, () => console.log(`gateway-service HTTP started on ${host}:${port}${authEnabled ? '（鉴权开启）' : '（鉴权关闭）'}`));
    return;
  }
  console.log('gateway-service service started (demo mode)');
}

await bootstrap();
