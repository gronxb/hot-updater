import { createHotUpdater } from "@hot-updater/server";
import { env } from "cloudflare:workers";
import { Hono } from "hono";

import { d1Database, r2Storage } from "../../src/worker";

export type CloudflareWorkerEnv = {
  DB: {
    batch: D1Database["batch"];
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  BUCKET_NAME: string;
  STORAGE_DOWNLOAD_URL_SIGNING_KEY: string;
};

export const HOT_UPDATER_BASE_PATH = "/";

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

const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

app.mount(HOT_UPDATER_BASE_PATH, (request: Request) =>
  hotUpdater.handlers.client(request),
);

export default app;
