import 'reflect-metadata';
import { PgClientAdapter, resolveDatabaseUrl } from '@agri/db';
import { createFileHttpServer } from './http.js';
import { SqlFileRepository } from './file.repository.js';
import { S3ObjectStorage } from './storage.js';

async function bootstrap(): Promise<void> {
  if (process.env.SERVICE_MODE === 'http') {
    const storage = process.env.FILE_STORAGE_MODE === 's3'
      ? new S3ObjectStorage({
        endpoint: process.env.FILE_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
        bucket: process.env.FILE_S3_BUCKET ?? 'agri',
        region: process.env.FILE_S3_REGION ?? 'us-east-1',
        accessKey: process.env.FILE_S3_ACCESS_KEY ?? '',
        secretKey: process.env.FILE_S3_SECRET_KEY ?? '',
      })
      : undefined;
    const sql = Boolean(process.env.DB_URL) && process.env.FILE_REPOSITORY_MODE !== 'memory';
    const client = sql ? PgClientAdapter.fromUrl(resolveDatabaseUrl()) : undefined;
    await client?.$connect();
    const server = createFileHttpServer({
      ...(storage ? { storage } : {}),
      ...(client ? { repository: new SqlFileRepository(client) } : {}),
    });
    const port = Number(process.env.PORT ?? 3013);
    server.listen(port, '127.0.0.1', () => console.log(`file-service HTTP started on ${port} (${sql ? 'SQL' : 'memory demo, not persistent'})`));
    const shutdown = async (): Promise<void> => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client?.$disconnect();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    return;
  }
  console.log('file-service service started (demo mode)');
}

await bootstrap();