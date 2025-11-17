import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import path from "path";
import { fileURLToPath } from "url";

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
const kysely = new Kysely({ dialect: new PGliteDialect(db) });

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "postgresql",
  }),
  storages: [
    mockStorage({}),
    s3Storage({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.R2_BUCKET_NAME!,
    }),
  ],
  basePath: "/hot-updater",
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await kysely.destroy();
  await db.close();
}
