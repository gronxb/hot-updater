import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { hotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

console.log(process.env.HOT_UPDATER_AWS_REGION);

// Create Hot Updater API
export const api = hotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "postgresql",
  }),
  storagePlugins: [
    s3Storage({
      region: process.env.HOT_UPDATER_AWS_REGION!,
      credentials: {
        accessKeyId: process.env.HOT_UPDATER_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.HOT_UPDATER_AWS_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.HOT_UPDATER_AWS_S3_BUCKET_NAME!,
    }),
  ],
  basePath: "/hot-updater",
});

// Initialize database schema
export async function initializeDatabase() {
  console.log("Initializing database schema...");
  try {
    const migrator = api.createMigrator();
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
    console.log("Database schema initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
    throw error;
  }
}

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await kysely.destroy();
  await db.close();
}
