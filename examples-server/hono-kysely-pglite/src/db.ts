import path from "path";
import { fileURLToPath } from "url";

import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const insightsDatabaseNamespace =
  process.env.HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE ??
  "00000000-0000-7000-8000-00000000e001";

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

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
    insightsDatabaseNamespace,
    provider: "postgresql",
  }),
  clientAccess: { type: "public" },
  storage: [
    mockStorage({}),
    s3Storage({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.R2_BUCKET_NAME!,
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
      channels
    CASCADE
  `.execute(kysely);
}
