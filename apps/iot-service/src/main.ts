import 'reflect-metadata';
import { createIotHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createIotHttpServer();
    const port = Number(process.env.PORT ?? 3003);
    server.listen(port, '127.0.0.1', () => console.log(`iot-service HTTP started on ${port}`));
    return;
  }
  console.log('iot-service service started (demo mode)');
}

await bootstrap();
