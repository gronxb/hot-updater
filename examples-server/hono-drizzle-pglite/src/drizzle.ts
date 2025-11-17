import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/pglite";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "../hot-updater-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

// Initialize PGlite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data" directory
const dbPath = process.env.TEST_DB_PATH || path.join(process.cwd(), "data");
const client = new PGlite(dbPath);

// Wait for PGlite to be ready
await client.waitReady;

export const db = drizzle({ client, schema, casing: "snake_case" });

// Export client for cleanup
export { client };
