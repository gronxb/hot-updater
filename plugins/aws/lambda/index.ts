import { NIL_UUID } from "@hot-updater/core";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import { getUpdateInfo } from "./getUpdateInfo";
import { withSignedUrl } from "./withSignedUrl";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    CLOUDFRONT_PRIVATE_KEY_BASE64: string;
  };
}

const CLOUDFRONT_KEY_PAIR_ID = HotUpdater.CLOUDFRONT_KEY_PAIR_ID;
const CLOUDFRONT_PRIVATE_KEY = Buffer.from(
  HotUpdater.CLOUDFRONT_PRIVATE_KEY_BASE64,
  "base64",
).toString("utf-8");

type Bindings = {
  callback: Callback;
  request: CloudFrontRequest;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/check-update", async (c) => {
  try {
    const { headers } = c.env.request;

    const bundleId = headers["x-bundle-id"]?.[0]?.value;
    const appPlatform = headers["x-app-platform"]?.[0]?.value as
      | "ios"
      | "android";
    const appVersion = headers["x-app-version"]?.[0]?.value;
    const minBundleId = headers["x-min-bundle-id"]?.[0]?.value ?? NIL_UUID;
    const channel = headers["x-channel"]?.[0]?.value ?? "production";

    if (!bundleId || !appPlatform || !appVersion) {
      return c.json({ error: "Missing required headers." }, 400);
    }

    const cdnHost = headers["host"]?.[0]?.value;
    if (!cdnHost) {
      return c.json({ error: "Missing host header." }, 500);
    }
    const updateInfo = await getUpdateInfo(
      {
        baseUrl: c.req.url,
        keyPairId: CLOUDFRONT_KEY_PAIR_ID,
        privateKey: CLOUDFRONT_PRIVATE_KEY,
      },
      {
        platform: appPlatform,
        bundleId,
        appVersion,
        minBundleId,
        channel,
      },
    );
    if (!updateInfo) {
      return c.json(null);
    }

    const appUpdateInfo = await withSignedUrl({
      data: updateInfo,
      reqUrl: c.req.url,
      keyPairId: CLOUDFRONT_KEY_PAIR_ID,
      privateKey: CLOUDFRONT_PRIVATE_KEY,
    });

    return c.json(appUpdateInfo);
  } catch {
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("*", async (c) => {
  return c.env.callback(null, c.env.request);
});

export const handler = handle(app) as CloudFrontRequestHandler;
