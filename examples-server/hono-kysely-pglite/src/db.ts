import { existsSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { insights, remoteConfig } from "@hot-updater/server/plugins";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
const envFilePath = path.join(__dirname, ".env.hotupdater");
const localProvider = process.env.HOT_UPDATER_E2E_LOCAL_PROVIDER === "1";
if (!localProvider && existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

// Initialize PGlite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data" directory
const dbPath = process.env.TEST_DB_PATH || path.join(process.cwd(), "data");
const db = new PGlite(dbPath);

// Wait for PGlite to be ready
await db.waitReady;

// Initialize Kysely with PGlite dialect
const kysely = new Kysely<object>({ dialect: new PGliteDialect(db) });

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "postgresql",
  }),
  plugins: [insights(), remoteConfig()],
  clientAccess: "public",
  storage: [
    process.env.NODE_ENV === "test"
      ? (
          await import("@hot-updater/test-utils/node")
        ).createReleaseCatalogTestStorage()
      : mockStorage({}),
    s3Storage({
      region: localProvider ? process.env.AWS_REGION : "auto",
      endpoint: localProvider
        ? process.env.AWS_S3_ENDPOINT
        : process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: localProvider
          ? process.env.AWS_ACCESS_KEY_ID!
          : process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: localProvider
          ? process.env.AWS_SECRET_ACCESS_KEY!
          : process.env.R2_SECRET_ACCESS_KEY!,
      },
      bucketName: localProvider
        ? process.env.AWS_S3_METADATA_BUCKET!
        : process.env.R2_BUCKET_NAME!,
      ...(localProvider
        ? {
            basePath: process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE,
            forcePathStyle: true,
          }
        : {}),
      downloadUrlSigningKey:
        process.env.HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY ??
        "development-storage-download-url-key",
    }),
  ],
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await kysely.destroy();
  await db.close();
}

export async function resetDecisionFixtures() {
  await sql`
    TRUNCATE TABLE
      bundle_patches,
      release_catalogs,
      releases,
      bundles,
      channels,
      bundle_totals
    CASCADE
  `.execute(kysely);
}
