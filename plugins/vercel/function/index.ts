import { postgres } from "@hot-updater/postgres";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";
import { attachDatabasePool } from "@vercel/functions";
import { PostgresDialect } from "kysely";
import pg from "pg";

import { vercelBlobStorage } from "../src/vercelBlobStorage";
import { withoutEncodingVary } from "./withoutEncodingVary";

/** The project environment variables init sets for the production target. */
const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set on the Vercel project. Run \`hot-updater init\` again to configure it.`,
    );
  }
  return value;
};

const access = requireEnv("HOT_UPDATER_VERCEL_BLOB_ACCESS");
if (access !== "public" && access !== "private") {
  throw new Error(
    'HOT_UPDATER_VERCEL_BLOB_ACCESS must be "public" or "private".',
  );
}

const pool = new pg.Pool({
  connectionString: requireEnv("HOT_UPDATER_VERCEL_DATABASE_URL"),
  idleTimeoutMillis: 5_000,
  max: 5,
});
// Closes idle connections before Vercel suspends the instance.
attachDatabasePool(pool);

const hotUpdater = createHotUpdater({
  database: postgres({ dialect: new PostgresDialect({ pool }) }),
  plugins: [insights(), apiKeys(), remoteConfig()],
  storage: vercelBlobStorage({
    access,
    token: requireEnv("HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN"),
  }),
});

/** Every route of the client handler; `vercel.json` rewrites every path here. */
const handler = async (request: Request) =>
  withoutEncodingVary(await hotUpdater.handlers.client(request));

export {
  handler as DELETE,
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
