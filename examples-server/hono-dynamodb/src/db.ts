import { existsSync } from "node:fs";
import path from "path";

import { dynamoDB, migrateDynamoDB, s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";

const envFilePath = path.resolve(process.cwd(), ".env.hotupdater");
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
};
const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;

const dynamoDBConfig = {
  region,
  endpoint: process.env.AWS_DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials,
  tableName: process.env.AWS_DYNAMODB_TABLE_NAME ?? "hot-updater-metadata",
};

export const database = dynamoDB({ ...dynamoDBConfig });

/** Creates the table when it is missing and writes the schema settings the plugin checks first. */
export const migrateDatabase = () => migrateDynamoDB(dynamoDBConfig);

export const hotUpdater = createHotUpdater({
  database,
  clientAccess: { type: "api-key" },
  storage: [
    process.env.NODE_ENV === "test"
      ? (
          await import("@hot-updater/test-utils/node")
        ).createReleaseCatalogTestStorage()
      : mockStorage({}),
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
