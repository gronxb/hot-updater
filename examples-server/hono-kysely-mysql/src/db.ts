import path from "path";
import { fileURLToPath } from "url";

import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely, MysqlDialect, sql } from "kysely";
import { createPool } from "mysql2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.hotupdater
config({ path: path.join(__dirname, ".env.hotupdater") });

// MySQL connection configuration
const connectionConfig = {
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3307,
  user: process.env.MYSQL_USER || "hot_updater",
  password: process.env.MYSQL_PASSWORD || "hot_updater_dev",
  database: process.env.MYSQL_DATABASE || "hot_updater",
  // Connection pool settings
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
};

// Create MySQL connection pool
const pool = createPool(connectionConfig);
const dialectPool = pool as unknown as ConstructorParameters<
  typeof MysqlDialect
>[0]["pool"];

// Initialize Kysely with MySQL dialect
export const kysely = new Kysely<object>({
  dialect: new MysqlDialect({
    pool: dialectPool,
  }),
});

let closeDatabasePromise: Promise<void> | null = null;

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "mysql",
  }),
  storage: [
    mockStorage({}),
    s3Storage({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.R2_BUCKET_NAME!,
      downloadUrlSigningKey:
        process.env.HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY ??
        "development-storage-download-url-key",
    }),
  ],
  basePath: "/hot-updater",
  features: {
    updateCheck: true,
    bundles: true,
  },
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  closeDatabasePromise ??= (async () => {
    await kysely.destroy();
  })();

  await closeDatabasePromise;
}

export async function resetDecisionFixtures() {
  await kysely.transaction().execute(async (transaction) => {
    for (const table of [
      "bundle_patches",
      "release_catalogs",
      "releases",
      "bundles",
      "channels",
    ] as const) {
      await sql`DELETE FROM ${sql.table(table)}`.execute(transaction);
    }
  });
}
