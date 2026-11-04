import 'reflect-metadata';
import { createControlHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createControlHttpServer();
    const port = Number(process.env.PORT ?? 3008);
    server.listen(port, '127.0.0.1', () => console.log(`control-service HTTP started on ${port}`));
    return;
  }
  console.log('control-service service started (demo mode)');
}

await bootstrap();
