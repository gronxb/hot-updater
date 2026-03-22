import { verifyJwtSignedUrl } from "@hot-updater/js";
import {
  createHotUpdater,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server";
import { Hono } from "hono";
import { cloudflareWorkerDatabase } from "../../src/cloudflareWorkerDatabase";
import { cloudflareWorkerStorage } from "../../src/cloudflareWorkerStorage";

type Env = {
  DB: {
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
const HOT_UPDATER_BASE_PATH = "/api/check-update";
const app = new Hono<{ Bindings: Env }>();

const hotUpdaterCache = new Map<string, ReturnType<typeof createHotUpdater>>();

const getHotUpdater = (env: Env, requestUrl: string) => {
  const publicBaseUrl = new URL(requestUrl).origin;
  const cached = hotUpdaterCache.get(publicBaseUrl);

  if (cached) {
    return cached;
  }

  const hotUpdater = createHotUpdater({
    database: cloudflareWorkerDatabase({
      db: env.DB,
    }),
    storages: [
      cloudflareWorkerStorage({
        jwtSecret: env.JWT_SECRET,
        publicBaseUrl,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
  });

  hotUpdaterCache.set(publicBaseUrl, hotUpdater);
  return hotUpdater;
};

app.get(HOT_UPDATER_BASE_PATH, async (c) => {
  const hotUpdater = getHotUpdater(c.env, c.req.url);
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
  });

  if (rewrittenRequest instanceof Response) {
    return rewrittenRequest;
  }

  return hotUpdater.handler(rewrittenRequest);
});

app.on(
  HOT_UPDATER_METHODS,
  wildcardPattern(HOT_UPDATER_BASE_PATH),
  async (c) => {
    return getHotUpdater(c.env, c.req.url).handler(c.req.raw);
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
