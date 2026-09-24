import { d1Database, r2Storage } from "@hot-updater/cloudflare/worker";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { env } from "cloudflare:workers";

const hotUpdater = createHotUpdater({
  database: d1Database(env.DB),
  plugins: [insights(), apiKeys()],
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
