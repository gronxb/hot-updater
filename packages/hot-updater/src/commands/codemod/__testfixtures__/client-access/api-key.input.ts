import { d1Database, r2Storage } from "@hot-updater/cloudflare/worker";
import { createHotUpdater } from "@hot-updater/server";
import { env } from "cloudflare:workers";

const hotUpdater = createHotUpdater({
  database: d1Database(env.DB),
  clientAccess: { type: "api-key" },
  storage: [
    r2Storage({
      bucket: env.BUCKET,
      bucketName: env.BUCKET_NAME,
      downloadUrlSigningKey: env.STORAGE_DOWNLOAD_URL_SIGNING_KEY,
    }),
  ],
});

export default {
  fetch: (request: Request) => hotUpdater.handlers.client(request),
};
