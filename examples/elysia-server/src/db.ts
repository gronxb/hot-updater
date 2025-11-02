import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { drizzleAdapter } from "@hot-updater/server/adapters/drizzle";
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../hot-updater-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

// Initialize SQLite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data/hot-updater.db" file
const dbPath =
  process.env.TEST_DB_PATH ||
  path.join(process.cwd(), "data", "hot-updater.db");

const client = createClient({
  url: `file:${dbPath}`,
});

const db = drizzle(client, {
  casing: "snake_case",
  logger: false,
  schema,
});

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: drizzleAdapter({
    db,
    provider: "sqlite",
  }),
  storagePlugins: [
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
export async function closeDatabase() {}
