import { existsSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "../hot-updater-schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
const envFilePath = path.join(__dirname, ".env.hotupdater");
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

// Initialize SQLite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data/hot-updater.db" file
const dbPath =
  process.env.TEST_DB_PATH ||
  path.join(process.cwd(), "data", "hot-updater.db");

export const client = createClient({
  url: `file:${dbPath}`,
});

export const db = drizzle(client, {
  schema,
  casing: "snake_case",
  logger: false,
});
