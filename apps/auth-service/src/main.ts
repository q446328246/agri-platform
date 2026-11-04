import 'reflect-metadata';
import { createAuthHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createAuthHttpServer();
    const port = Number(process.env.PORT ?? 3001);
    server.listen(port, '127.0.0.1', () => console.log(`auth-service HTTP started on ${port}`));
    return;
  }
  console.log('auth-service service started (demo mode)');
}

await bootstrap();
