import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    S3_BUCKET_NAME: string;
    S3_REGION: string;
  };
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const s3 = new S3Client({ region: HotUpdater.S3_REGION });

function parseS3Url(url: string) {
  try {
    const parsedUrl = new URL(url);
    const { hostname, pathname } = parsedUrl;
    if (!hostname.includes(".s3.")) return { isS3Url: false };
    const [bucket] = hostname.split(".s3");
    const key = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    return { isS3Url: true, bucket, key };
  } catch {
    return { isS3Url: false };
  }
}

async function createPresignedUrl(url: string) {
  const { isS3Url, bucket, key } = parseS3Url(url);
  if (!isS3Url || !bucket || !key) {
    return url;
  }
  // @ts-ignore
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 60,
  });
}

async function signUpdateInfoFileUrl(updateInfo: any) {
  if (updateInfo?.fileUrl) {
    updateInfo.fileUrl = await createPresignedUrl(updateInfo.fileUrl);
  }
  return updateInfo;
}

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

    const updateInfo = await getUpdateInfo(s3, HotUpdater.S3_BUCKET_NAME, {
      platform: appPlatform,
      bundleId,
      appVersion,
      minBundleId,
      channel,
    });
    if (!updateInfo) {
      return c.json(null);
    }

    const finalInfo = await signUpdateInfoFileUrl(updateInfo);
    return c.json(finalInfo);
  } catch {
    return c.json(
      {
        error: "Internal Server Error",
      },
      500,
    );
  }
});

app.get("*", async (c) => {
  c.env.callback(null, c.env.request);
});

export const handler = handle(app) as CloudFrontRequestHandler;
