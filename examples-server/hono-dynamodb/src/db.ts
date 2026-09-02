import path from "path";

import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { config } from "dotenv";

config({ path: path.resolve(process.cwd(), ".env.hotupdater") });

const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
};
const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;
const insightsDatabaseNamespace =
  process.env.HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE ??
  "00000000-0000-7000-8000-00000000e001";

export const database = dynamoDB({
  region,
  endpoint: process.env.AWS_DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials,
  insightsDatabaseNamespace,
  tableName: process.env.AWS_DYNAMODB_TABLE_NAME ?? "hot-updater-metadata",
});

export const hotUpdater = createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
  storage: [
    mockStorage({}),
    s3Storage({
      region,
      endpoint: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9000",
      credentials,
      bucketName: process.env.AWS_S3_BUCKET_NAME ?? "hot-updater-bundles",
      basePath: providerNamespace,
      forcePathStyle: true,
      downloadUrlSigningKey:
        process.env.HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY ??
        "development-storage-download-url-key",
    }),
  ],
});
