import { defineConfig } from "drizzle-kit";
import path from "path";

// Use TEST_DB_PATH for testing, otherwise use default "data/hot-updater.db" file
const dbPath =
  process.env.TEST_DB_PATH ||
  path.join(process.cwd(), "data", "hot-updater.db");

export default defineConfig({
  schema: "./hot-updater-schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: `file:${dbPath}`,
  },
});
