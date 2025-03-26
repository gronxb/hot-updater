import { NIL_UUID } from "@hot-updater/core";
import { verifyJwtSignedUrl, withJwtSignedUrl } from "@hot-updater/js";
import { Hono } from "hono";
import { getUpdateInfo } from "./getUpdateInfo";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/check-update", async (c) => {
  const bundleId = c.req.header("x-bundle-id") as string;
  const appPlatform = c.req.header("x-app-platform") as "ios" | "android";
  const appVersion = c.req.header("x-app-version") as string;
  const minBundleId = c.req.header("x-min-bundle-id") as string | undefined;
  const channel = c.req.header("x-channel") as string | undefined;

  if (!bundleId || !appPlatform || !appVersion) {
    return c.json(
      { error: "Missing bundleId, appPlatform, or appVersion" },
      400,
    );
  }

  const updateInfo = await getUpdateInfo(c.env.DB, {
    appVersion,
    bundleId,
    platform: appPlatform,
    minBundleId: minBundleId || NIL_UUID,
    channel: channel || "production",
  });

  const appUpdateInfo = await withJwtSignedUrl({
    data: updateInfo,
    reqUrl: c.req.url,
    jwtSecret: c.env.JWT_SECRET,
  });

  return c.json(appUpdateInfo, 200);
});

app.get("*", async (c) => {
  const result = await verifyJwtSignedUrl({
    path: c.req.path,
    token: c.req.query("token"),
    jwtSecret: c.env.JWT_SECRET,
    handler: async (key) => {
      const object = await c.env.BUCKET.get(key);
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
