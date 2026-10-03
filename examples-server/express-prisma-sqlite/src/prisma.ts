import { existsSync } from "node:fs";
import { PrismaClient } from "./generated/prisma";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
const envFilePath = path.join(__dirname, ".env.hotupdater");
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

// Initialize SQLite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data/prisma.db" file
const dbPath =
  process.env.TEST_DB_PATH || path.join(process.cwd(), "data", "prisma.db");

// Set DATABASE_URL for Prisma
process.env.DATABASE_URL = `file:${dbPath}`;

export const prisma = new PrismaClient();
