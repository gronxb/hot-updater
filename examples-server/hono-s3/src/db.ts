import path from "path";

import { s3Database, s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server/node";
import { config } from "dotenv";

// Load optional .env.hotupdater file for local development
config({ path: path.resolve(process.cwd(), ".env.hotupdater") });

const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;

const options =
  process.env.NODE_ENV === "test"
    ? {
        region: process.env.AWS_REGION || "us-east-1",
        endpoint: process.env.AWS_S3_ENDPOINT || "http://localhost:9000",
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || "minioadmin",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "minioadmin",
        },
        bucketName:
          process.env.AWS_S3_METADATA_BUCKET || "hot-updater-metadata",
        basePath: providerNamespace,
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
        basePath: providerNamespace,
      };

export const hotUpdater = createHotUpdater({
  database: s3Database(options),
  storages: [mockStorage({}), s3Storage(options)],
  basePath: "/hot-updater",
  routes: {
    updateCheck: true,
    bundles: true,
  },
});

export async function closeDatabase() {
  // No persistent database connections to close for S3-backed storage.
}
