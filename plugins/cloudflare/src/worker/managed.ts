import type { HotUpdaterHandlers } from "@hot-updater/server";
import { env } from "cloudflare:workers";
import { Hono } from "hono";

import { r2WorkerStorage } from "../r2WorkerStorage";
import { d1Database as d1BindingDatabase } from "./d1Database";

export { D1ExecutionError } from "../d1Executor";
export { plugins } from "../plugins";

/** The bindings `wrangler.json` gives the managed Worker. */
export type CloudflareWorkerEnv = {
  DB: {
    batch: D1Database["batch"];
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  BUCKET_NAME: string;
  STORAGE_DOWNLOAD_URL_SIGNING_KEY: string;
};

const bindings = () => env as unknown as CloudflareWorkerEnv;

/*
 * The managed Worker runs the project's server definition with this module
 * in place of `@hot-updater/cloudflare`: the definition's database and
 * storage are the Worker's own D1 and R2 bindings, and the credentials it
 * passes, which are the CLI's, go unused.
 */

/** The server definition's database in the managed Worker: D1 through its `DB` binding. */
export const d1Database = (_config?: unknown) =>
  d1BindingDatabase(bindings().DB);

/** The server definition's storage in the managed Worker: R2 through its `BUCKET` binding. */
export const r2Storage = (_config?: unknown) =>
  r2WorkerStorage({
    bucket: bindings().BUCKET,
    bucketName: bindings().BUCKET_NAME,
    downloadUrlSigningKey: bindings().STORAGE_DOWNLOAD_URL_SIGNING_KEY,
  });

export const HOT_UPDATER_BASE_PATH = "/";

/** The managed Worker: the server definition's client routes. */
export const serveManagedWorker = (hotUpdater: {
  readonly handlers: Pick<HotUpdaterHandlers, "client">;
}) => {
  const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();
  app.mount(HOT_UPDATER_BASE_PATH, (request: Request) =>
    hotUpdater.handlers.client(request),
  );
  return app;
};
