import 'reflect-metadata';
import { createWeatherHttpServer } from './http.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const server = createWeatherHttpServer();
    const port = Number(process.env.PORT ?? 3005);
    server.listen(port, '127.0.0.1', () => console.log(`weather-service HTTP started on ${port}`));
    return;
  }
  console.log('weather-service service started (demo mode)');
}

await bootstrap();
