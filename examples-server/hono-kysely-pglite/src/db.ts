import path from "path";
import { fileURLToPath } from "url";

import { PGlite } from "@electric-sql/pglite";
import { r2Storage } from "@hot-updater/cloudflare";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    provider: "postgresql",
  }),
  storage: [
    mockStorage({}),
    r2Storage({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
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
  basePath: "/hot-updater",
  features: {
    updateCheck: true,
    bundles: true,
    analytics: { queryAccess: "public" },
  },
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
