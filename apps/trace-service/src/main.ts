import 'reflect-metadata';
import { createTraceHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createTraceHttpServer();
    const port = Number(process.env.PORT ?? 3011);
    server.listen(port, '127.0.0.1', () => console.log(`trace-service HTTP started on ${port}`));
    return;
  }
  console.log('trace-service service started (demo mode)');
}

await bootstrap();
