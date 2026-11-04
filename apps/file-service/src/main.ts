import 'reflect-metadata';
import { createFileHttpServer } from './http.js';
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
    const server = createFileHttpServer(storage);
    const port = Number(process.env.PORT ?? 3013);
    server.listen(port, '127.0.0.1', () => console.log(`file-service HTTP started on ${port}`));
    return;
  }
  console.log('file-service service started (demo mode)');
}

await bootstrap();
