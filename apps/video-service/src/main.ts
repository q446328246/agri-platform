import 'reflect-metadata';
import { createVideoHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createVideoHttpServer();
    const port = Number(process.env.PORT ?? 3009);
    server.listen(port, '127.0.0.1', () => console.log(`video-service HTTP started on ${port}`));
    return;
  }
  console.log('video-service service started (demo mode)');
}

await bootstrap();
