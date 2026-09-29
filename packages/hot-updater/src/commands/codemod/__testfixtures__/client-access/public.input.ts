import { s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";

import { db } from "./db";

export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db, provider: "postgresql" }),
  clientAccess: { type: "public" },
  storage: [
    s3Storage({
      region: process.env.AWS_REGION!,
      bucketName: process.env.AWS_S3_BUCKET_NAME!,
      downloadUrlSigningKey: process.env.STORAGE_DOWNLOAD_URL_SIGNING_KEY!,
    }),
  ],
});
