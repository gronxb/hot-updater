import { createHotUpdater } from "@hot-updater/server";
import { Hono } from "hono";

import { d1Database, r2Storage, verifyJwtSignedUrl } from "../../src/worker";

export type CloudflareWorkerEnv = {
  DB: {
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

export const HOT_UPDATER_BASE_PATH = "/api/check-update";

const createHotUpdaterHandler = (request: Request, env: CloudflareWorkerEnv) =>
  createHotUpdater({
    database: d1Database(),
    storages: [
      r2Storage({
        bucket: env.BUCKET,
        jwtSecret: env.JWT_SECRET,
        publicBaseUrl: new URL(request.url).origin,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
    routes: {
      updateCheck: true,
      bundles: false,
    },
  });

const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

app.mount(
  HOT_UPDATER_BASE_PATH,
  (request: Request, env: CloudflareWorkerEnv) => {
    const hotUpdater = createHotUpdaterHandler(request, env);
    return hotUpdater.handler(request, {
      request,
      env,
    });
  },
  {
    optionHandler: (c) => [c.env],
  },
);

app.get("*", async (c) => {
  const result = await verifyJwtSignedUrl({
    path: c.req.path,
    token: c.req.query("token"),
    jwtSecret: c.env.JWT_SECRET,
    handler: async (storageUri) => {
      const [, ...key] = storageUri.split("/");
      const object = await c.env.BUCKET.get(key.join("/"));
      if (!object) {
        return null;
      }

      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType,
      };
    },
  });

  if (result.status !== 200) {
    return c.json({ error: result.error }, result.status);
  }

  return c.body(result.responseBody, 200, result.responseHeaders);
});

export default app;
