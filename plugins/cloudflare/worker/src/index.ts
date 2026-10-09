import { createHotUpdater } from "@hot-updater/server";
import { env } from "cloudflare:workers";
import { Hono } from "hono";

import { d1Database, plugins, r2Storage } from "../../src/worker";

export type CloudflareWorkerEnv = {
  DB: {
    batch: D1Database["batch"];
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  BUCKET_NAME: string;
  ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

export const HOT_UPDATER_BASE_PATH = "/";

const hotUpdater = createHotUpdater({
  database: d1Database(env.DB),
  plugins,
  storage: r2Storage({
    bucket: env.BUCKET,
    bucketName: env.BUCKET_NAME,
    // Presign download URLs, so devices download from R2.
    accountId: env.ACCOUNT_ID,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  }),
});

const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

app.mount(HOT_UPDATER_BASE_PATH, (request: Request) =>
  hotUpdater.handlers.client(request),
);

export default app;
