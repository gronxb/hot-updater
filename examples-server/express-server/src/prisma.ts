import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

// Initialize SQLite with file-based storage for persistence
// Use TEST_DB_PATH for testing, otherwise use default "data/prisma.db" file
const dbPath =
  process.env.TEST_DB_PATH || path.join(process.cwd(), "data", "prisma.db");

// Set DATABASE_URL for Prisma
process.env.DATABASE_URL = `file:${dbPath}`;

export const prisma = new PrismaClient();
