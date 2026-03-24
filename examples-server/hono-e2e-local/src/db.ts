import { PGlite } from "@electric-sql/pglite";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.join(__dirname, ".env.hotupdater") });

const dbPath = process.env.TEST_DB_PATH || path.join(process.cwd(), "data");
const db = new PGlite(dbPath);

await db.waitReady;

const kysely = new Kysely({ dialect: new PGliteDialect(db) });

export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "postgresql",
  }),
  basePath: "/hot-updater",
});

export async function closeDatabase() {
  await kysely.destroy();
  await db.close();
}
