import 'reflect-metadata';
import { createFinanceHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createFinanceHttpServer();
    const port = Number(process.env.PORT ?? 3010);
    server.listen(port, '127.0.0.1', () => console.log(`finance-service HTTP started on ${port}`));
    return;
  }
  console.log('finance-service service started (demo mode)');
}

await bootstrap();
