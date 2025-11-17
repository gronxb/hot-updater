import { s3Database, s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load optional .env.hotupdater file for local development
config({ path: path.join(__dirname, ".env.hotupdater") });

const region = process.env.AWS_REGION || "us-east-1";
const endpoint = process.env.AWS_S3_ENDPOINT || "http://localhost:4566";
const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "test";
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "test";
const metadataBucket =
  process.env.AWS_S3_METADATA_BUCKET || "hot-updater-metadata";
const bundlesBucket =
  process.env.AWS_S3_BUNDLES_BUCKET || "hot-updater-bundles";

export const hotUpdater = createHotUpdater({
  database: s3Database({
    region,
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    bucketName: metadataBucket,
    // localstack s3
    forcePathStyle: true,
  }),
  storagePlugins: [
    mockStorage({}),
    s3Storage({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      bucketName: bundlesBucket,
      // localstack s3
      forcePathStyle: true,
    }),
  ],
  basePath: "/hot-updater",
});

export async function closeDatabase() {
  // No persistent database connections to close for S3-backed storage.
}
