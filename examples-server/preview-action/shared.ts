import { s3Storage } from "@hot-updater/aws";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { secret } from "hot-updater";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/**
 * The backend, as the proof's job environment sets it. The storage's keys
 * come through `secret()`, which reads them from the job's environment
 * only when the storage first needs them; a command that doesn't touch the
 * backend, such as `channel set`, loads the config without them.
 */
const env = (name: string) => process.env[name]!;

export const database = kyselyAdapter({
  db: new Kysely<object>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: env("HOT_UPDATER_DATABASE_URL") }),
    }),
  }),
  provider: "postgresql",
});

export const storage = s3Storage({
  bucketName: env("HOT_UPDATER_S3_BUCKET_NAME"),
  region: env("HOT_UPDATER_S3_REGION"),
  endpoint: env("HOT_UPDATER_S3_ENDPOINT"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: secret("HOT_UPDATER_S3_ACCESS_KEY_ID"),
    secretAccessKey: secret("HOT_UPDATER_S3_SECRET_ACCESS_KEY"),
  },
});
