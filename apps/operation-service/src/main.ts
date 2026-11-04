import 'reflect-metadata';
import { createOperationHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createOperationHttpServer();
    const port = Number(process.env.PORT ?? 3007);
    server.listen(port, '127.0.0.1', () => console.log(`operation-service HTTP started on ${port}`));
    return;
  }
  console.log('operation-service service started (demo mode)');
}

await bootstrap();
