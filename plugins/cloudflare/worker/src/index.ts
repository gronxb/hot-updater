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
  PUBLIC_BASE_URL: string;
  STORAGE_DELIVERY_SIGNING_KEY: string;
};

export const HOT_UPDATER_BASE_PATH = "/api/check-update";

const hotUpdater = createHotUpdater({
  database: d1Database(env.DB),
  features: { analytics: true },
  storages: [
    r2Storage({
      bucket: env.BUCKET,
      bucketName: env.BUCKET_NAME,
    }),
  ],
  storageDelivery: {
    publicBaseUrl: env.PUBLIC_BASE_URL,
    signingKey: env.STORAGE_DELIVERY_SIGNING_KEY,
  },
  basePath: HOT_UPDATER_BASE_PATH,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

app.mount(HOT_UPDATER_BASE_PATH, (request: Request) =>
  hotUpdater.handler(request),
);

export default app;
