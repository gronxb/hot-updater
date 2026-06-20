import path from "path";
import { fileURLToPath } from "url";

import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../hot-updater-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

// Initialize PGlite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data" directory
const dbPath = process.env.TEST_DB_PATH || path.join(process.cwd(), "data");

let client: PGlite | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;
let dbPromise: Promise<ReturnType<typeof drizzle<typeof schema>>> | undefined;

export const getDB = async () => {
  dbPromise ??= (async () => {
    const nextClient = new PGlite(dbPath);
    await nextClient.waitReady;
    client = nextClient;
    db = drizzle({ client: nextClient, schema, casing: "snake_case" });
    return db;
  })();

  return dbPromise;
};

export const closeClient = async () => {
  await client?.close();
  client = undefined;
  db = undefined;
  dbPromise = undefined;
};

export { schema };
