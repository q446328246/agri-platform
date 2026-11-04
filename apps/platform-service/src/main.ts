import 'reflect-metadata';
import { createPlatformHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createPlatformHttpServer();
    const port = Number(process.env.PORT ?? 3014);
    server.listen(port, '127.0.0.1', () => console.log(`platform-service HTTP started on ${port}`));
    return;
  }
  console.log('platform-service service started (demo mode)');
}

await bootstrap();
