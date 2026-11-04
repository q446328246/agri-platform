import 'reflect-metadata';
import { createMessageHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createMessageHttpServer();
    const port = Number(process.env.PORT ?? 3012);
    server.listen(port, '127.0.0.1', () => console.log(`message-service HTTP started on ${port}`));
    return;
  }
  console.log('message-service service started (demo mode)');
}

await bootstrap();
