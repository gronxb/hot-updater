import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

const databasePath = process.env.HOT_UPDATER_E2E_VAULT_DB_PATH;
if (!databasePath) {
  throw new Error(
    "HOT_UPDATER_E2E_VAULT_DB_PATH names the vault console's PGlite directory.",
  );
}

// PGlite opens its directory in one process at a time: migrate and issue
// tokens before the console starts, and write through the console after.
const db = new PGlite(databasePath);
await db.waitReady;

export const database = {
  ...kyselyAdapter({
    db: new Kysely<object>({ dialect: new PGliteDialect(db) }),
    provider: "postgresql",
  }),
  // A command exits once it disposes the database, so PGlite closes here.
  dispose: () => db.close(),
};

// The vault reads no storage, but a console needs one. The bundles live on
// the E2E server's storage, which this console never lists.
export const storage = s3Storage({
  region: "us-east-1",
  bucketName: "hot-updater-e2e-vault-console",
  credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
});
