import { PGlite } from "@electric-sql/pglite";
import { HotUpdaterDB, hotUpdater } from "@hot-updater/server";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { kyselyAdapter } from "fumadb/adapters/kysely";
import { s3Storage } from "@hot-updater/aws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize PGlite with file-based storage for persistence
const dbPath = path.join(process.cwd(), "data");
const db = new PGlite(dbPath);

// Initialize Kysely with PGlite dialect
const kysely = new Kysely({ dialect: new PGliteDialect(db) });

// Configure adapter for FumaDB
const adapterConfig = {
  db: kysely,
  provider: "postgresql" as const,
} as unknown as Parameters<typeof kyselyAdapter>[0];

// Create HotUpdaterDB client
const client = HotUpdaterDB.client(kyselyAdapter(adapterConfig));

// Storage plugin configuration (example with S3)
// In production, use environment variables for credentials
const storagePlugin = s3Storage(
  {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test-access-key",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test-secret-key",
    },
    bucketName: process.env.AWS_BUCKET_NAME || "hot-updater-bundles",
  },
  {},
)({ cwd: process.cwd() });

// Create Hot Updater API
export const api = hotUpdater(client, {
  storagePlugins: [storagePlugin],
});

// Initialize database schema
export async function initializeDatabase() {
  console.log("Initializing database schema...");
  const migrator = client.createMigrator();
  const result = await migrator.migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();
  console.log("Database schema initialized successfully");
}

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await kysely.destroy();
  await db.close();
}
