import { verifyJwtSignedUrl } from "@hot-updater/js";
import type { RequestEnvContext } from "@hot-updater/plugin-core";
import {
  createHotUpdater,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server/runtime";
import { Hono } from "hono";
import { d1WorkerDatabase } from "../../src/cloudflareWorkerDatabase";
import { r2WorkerStorage } from "../../src/cloudflareWorkerStorage";

export type CloudflareWorkerEnv = {
  DB: {
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

export const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

type CloudflareWorkerContext = RequestEnvContext<CloudflareWorkerEnv>;

const resolveRequestOrigin = (context?: CloudflareWorkerContext) => {
  const request = context?.request;

  if (!request) {
    throw new Error(
      "cloudflareWorkerStorage requires a request to resolve publicBaseUrl.",
    );
  }

  return new URL(request.url).origin;
};

const hotUpdater = createHotUpdater({
  database: d1WorkerDatabase<CloudflareWorkerContext>(),
  storages: [
    r2WorkerStorage<CloudflareWorkerContext>({
      publicBaseUrl: resolveRequestOrigin,
    }),
  ],
  basePath: HOT_UPDATER_BASE_PATH,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

app.get(HOT_UPDATER_BASE_PATH, async (c) => {
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
  });

  if (rewrittenRequest instanceof Response) {
    return rewrittenRequest;
  }

  return hotUpdater.handler(rewrittenRequest, {
    request: rewrittenRequest,
    env: c.env,
  });
});

app.on(
  HOT_UPDATER_METHODS,
  wildcardPattern(HOT_UPDATER_BASE_PATH),
  async (c) => {
    return hotUpdater.handler(c.req.raw, {
      request: c.req.raw,
      env: c.env,
    });
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
