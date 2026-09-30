import { d1Database, plugins, r2Storage } from "@hot-updater/cloudflare";
import { createHotUpdater } from "@hot-updater/server";

import { sample } from "./samplePlugin";

/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  storage: [
    r2Storage({
      bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
      accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
      credentials: {
        accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
        secretAccessKey:
          process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
      },
    }),
  ],
  plugins: [...plugins, sample()],
});
