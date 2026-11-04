import { S3ObjectStorage } from "../apps/file-service/dist/storage.js";

const storage = new S3ObjectStorage({
  endpoint: process.env.FILE_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  bucket: process.env.FILE_S3_BUCKET ?? "agri",
  region: process.env.FILE_S3_REGION ?? "us-east-1",
  accessKey: process.env.FILE_S3_ACCESS_KEY ?? "minioadmin",
  secretKey: process.env.FILE_S3_SECRET_KEY ?? "minioadmin",
});
await storage.ensureBucket();
console.log(`MinIO bucket 已就绪: ${process.env.FILE_S3_BUCKET ?? "agri"}`);
