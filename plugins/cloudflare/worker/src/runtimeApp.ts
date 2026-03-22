import { verifyJwtSignedUrl } from "@hot-updater/js";
import {
  type createHotUpdater,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server";
import { Hono } from "hono";

export type CloudflareWorkerEnv = {
  DB: {
    prepare: D1Database["prepare"];
  };
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

type HotUpdaterRuntime = Pick<
  ReturnType<typeof createHotUpdater>,
  "basePath" | "handler"
>;

export const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

export interface CreateCloudflareWorkerAppOptions {
  basePath?: string;
  getHotUpdater: (
    env: CloudflareWorkerEnv,
    requestUrl: string,
  ) => HotUpdaterRuntime;
  verifySignedUrlImpl?: typeof verifyJwtSignedUrl;
}

export const createCloudflareWorkerApp = ({
  basePath = HOT_UPDATER_BASE_PATH,
  getHotUpdater,
  verifySignedUrlImpl = verifyJwtSignedUrl,
}: CreateCloudflareWorkerAppOptions) => {
  const app = new Hono<{ Bindings: CloudflareWorkerEnv }>();

  app.get(basePath, async (c) => {
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

  app.on(HOT_UPDATER_METHODS, wildcardPattern(basePath), async (c) => {
    return getHotUpdater(c.env, c.req.url).handler(c.req.raw);
  });

  app.get("*", async (c) => {
    const result = await verifySignedUrlImpl({
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

  return app;
};
