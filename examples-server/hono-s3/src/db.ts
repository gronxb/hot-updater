import { s3Database, s3Storage } from "@hot-updater/aws";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load optional .env.hotupdater file for local development
config({ path: path.join(__dirname, ".env.hotupdater") });

export const s3Options: S3ClientConfig & { bucketName: string } =
  process.env.NODE_ENV === "test"
    ? {
        region: process.env.AWS_REGION || "us-east-1",
        endpoint: process.env.AWS_S3_ENDPOINT || "http://localhost:4566",
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
        },
        bucketName:
          process.env.AWS_S3_METADATA_BUCKET || "hot-updater-metadata",
        // localstack s3
        forcePathStyle: true,
      }
    : {
        region: "auto",
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
        bucketName: process.env.R2_BUCKET_NAME!,
      };

export const hotUpdater = createHotUpdater({
  database: s3Database(s3Options),
  storages: [mockStorage({}), s3Storage(s3Options)],
  basePath: "/hot-updater",
});

export const metadataBucketName = s3Options.bucketName;
export const metadataS3Client = new S3Client(s3Options);

export async function closeDatabase() {
  // No persistent database connections to close for S3-backed storage.
}
