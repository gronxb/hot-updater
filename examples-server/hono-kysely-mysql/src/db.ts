import { s3Storage } from "@hot-updater/aws";
import { mockStorage } from "@hot-updater/mock";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { config } from "dotenv";
import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import path from "path";
import { fileURLToPath } from "url";

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

// Initialize Kysely with MySQL dialect
export const kysely = new Kysely({
  dialect: new MysqlDialect({
    pool: pool,
  }),
});

// Create Hot Updater API
export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "mysql",
  }),
  storages: [
    mockStorage({}),
    s3Storage({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.R2_BUCKET_NAME!,
    }),
  ],
  basePath: "/hot-updater",
});

// Cleanup function for graceful shutdown
export async function closeDatabase() {
  await kysely.destroy();
  // Close the connection pool
  pool.end();
}
