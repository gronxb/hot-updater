import { s3Storage } from "@hot-updater/aws";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/**
 * The backend's own credentials, as the Console host has them. The CLI gets
 * them from the vault's deploy-credentials, which load into process.env
 * before the config does; a command that doesn't touch the backend, such as
 * `channel set`, loads the config without them, and the clients read them
 * only on first use.
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
    accessKeyId: env("HOT_UPDATER_S3_ACCESS_KEY_ID"),
    secretAccessKey: env("HOT_UPDATER_S3_SECRET_ACCESS_KEY"),
  },
});
