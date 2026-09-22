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

// Use TEST_DATABASE_URL for testing, otherwise use default DATABASE_URL
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

export const prisma = new PrismaClient();
