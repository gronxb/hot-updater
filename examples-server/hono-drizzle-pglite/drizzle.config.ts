import { defineConfig } from "drizzle-kit";
import path from "path";

// Use TEST_DB_PATH for testing, otherwise use default "data" directory
const dbPath = process.env.TEST_DB_PATH || path.join(process.cwd(), "data");

export default defineConfig({
  schema: "./hot-updater-schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: dbPath,
  },
});
