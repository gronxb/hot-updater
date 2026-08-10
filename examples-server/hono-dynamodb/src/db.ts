import path from "path";

import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { createManagedServerPlugins } from "@hot-updater/managed";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { migrateUniversalComponents } from "@hot-updater/server/db";
import { config } from "dotenv";

config({ path: path.resolve(process.cwd(), ".env.hotupdater") });

const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
};
const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;

export const database = dynamoDB({
  region,
  endpoint: process.env.AWS_DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials,
  tableName: process.env.AWS_DYNAMODB_TABLE_NAME ?? "hot-updater-metadata",
});

export const hotUpdater = createHotUpdater({
  database,
  storages: [
    mockStorage({}),
    s3Storage({
      region,
      endpoint: process.env.AWS_S3_ENDPOINT ?? "http://localhost:9000",
      credentials,
      bucketName:
        process.env.AWS_S3_BUCKET_NAME ??
        process.env.AWS_S3_METADATA_BUCKET ??
        "hot-updater-bundles",
      basePath: providerNamespace,
      forcePathStyle: true,
    }),
  ],
  plugins: createManagedServerPlugins({
    managementBearerToken: process.env.HOT_UPDATER_AUTH_TOKEN,
  }),
  basePath: "/hot-updater",
  routes: {
    updateCheck: true,
    bundles: true,
  },
});

await migrateUniversalComponents(hotUpdater);
