import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import path from "path";
import { fileURLToPath } from "url";

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

// Try to load schema, use empty object if not generated yet
let schema: any = {};
try {
  schema = await import("../hot-updater-schema");
} catch {
  // Schema not generated yet, use empty schema
}

export const db = drizzle(client, {
  schema,
  casing: "snake_case",
  logger: false,
});
