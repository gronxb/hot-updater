import { S3Client } from "@aws-sdk/client-s3";
import { NIL_UUID } from "@hot-updater/core";
import { verifyJwtToken, withJwtSignedUrl } from "@hot-updater/js";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    S3_BUCKET_NAME: string;
    S3_REGION: string;
    JWT_SECRET: string;
  };
}

const s3 = new S3Client({ region: HotUpdater.S3_REGION });
const bucketName = HotUpdater.S3_BUCKET_NAME;

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

    const updateInfo = await getUpdateInfo(s3, bucketName, {
      platform: appPlatform,
      bundleId,
      appVersion,
      minBundleId,
      channel,
    });
    if (!updateInfo) {
      return c.json(null);
    }

    const appUpdateInfo = await withJwtSignedUrl({
      data: updateInfo,
      reqUrl: c.req.url,
      jwtSecret: HotUpdater.JWT_SECRET,
    });

    return c.json(appUpdateInfo);
  } catch {
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("*", async (c) => {
  const params = new URLSearchParams(c.env.request.querystring || "");
  const token = params.get("token");
  const path = c.env.request.uri;

  if (!token) {
    return c.json({ error: "Missing token" }, 400);
  }

  const verifyResult = await verifyJwtToken({
    path,
    token,
    jwtSecret: process.env.JWT_SECRET || HotUpdater.JWT_SECRET,
  });
  if (!verifyResult.valid) {
    return c.json(
      { error: verifyResult.error },
      verifyResult.error === "Missing token" ? 400 : 403,
    );
  }

  params.delete("token");
  c.env.request.querystring = params.toString();
  c.env.request.uri = ["/", verifyResult.key].join("");

  return c.env.callback(null, c.env.request);
});

export const handler = handle(app) as CloudFrontRequestHandler;
