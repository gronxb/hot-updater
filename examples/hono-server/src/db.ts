import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { HotUpdaterDB, hotUpdater } from "@hot-updater/server";
import { config } from "dotenv";
import { kyselyAdapter } from "fumadb/adapters/kysely";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: ".env.hotupdater" });

// Initialize PGlite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data" directory
const dbPath = process.env.TEST_DB_PATH || path.join(process.cwd(), "data");
const db = new PGlite(dbPath);

// Wait for PGlite to be ready
await db.waitReady;

// Initialize Kysely with PGlite dialect
const kysely = new Kysely({ dialect: new PGliteDialect(db) });

// Configure adapter for FumaDB
const adapterConfig = {
  db: kysely,
  provider: "postgresql" as const,
} as unknown as Parameters<typeof kyselyAdapter>[0];

// Create HotUpdaterDB client
const client = HotUpdaterDB.client(kyselyAdapter(adapterConfig));

// Mock storage plugin for "storage://" protocol (used in tests)
const mockStoragePlugin = {
  name: "mockStorage",
  supportedProtocol: "storage",
  async getDownloadUrl(storageUri: string) {
    return {
      fileUrl: storageUri.replace("storage://", "https://mock-storage.com/"),
    };
  },
  async uploadBundle() {
    throw new Error("uploadBundle not implemented in mock");
  },
  async deleteBundle() {
    throw new Error("deleteBundle not implemented in mock");
  },
};

// Storage plugin configuration (example with S3)
// In production, use environment variables for credentials
const storagePlugin = s3Storage(
  {
    region: process.env.HOT_UPDATER_AWS_REGION!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.HOT_UPDATER_AWS_S3_BUCKET_NAME!,
  },
  {},
)({ cwd: process.cwd() });

// Create Hot Updater API
export const api = hotUpdater(client, {
  storagePlugins: [mockStoragePlugin, storagePlugin],
  basePath: "/hot-updater",
});

// Initialize database schema
export async function initializeDatabase() {
  console.log("Initializing database schema...");
  try {
    const migrator = client.createMigrator();
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
