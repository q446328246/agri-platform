import 'reflect-metadata';
import { createGatewayHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createGatewayHttpServer();
    const port = Number(process.env.PORT ?? 8080);
    server.listen(port, '127.0.0.1', () => console.log(`gateway-service HTTP started on ${port}`));
    return;
  }
  console.log('gateway-service service started (demo mode)');
}

await bootstrap();
