import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import { getUpdateInfo } from "./getUpdateInfo";

const s3 = new S3Client();

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
    const { headers, origin } = c.env.request;
    let bucketName: string | undefined;
    if (origin?.s3?.domainName) {
      const domainName = origin.s3.domainName;
      [bucketName] = domainName.split(".s3");
    }
    if (!bucketName) {
      return c.json({ error: "Bucket name not found." }, 500);
    }

    const bundleId = headers["x-bundle-id"]?.[0]?.value;
    const appPlatform = headers["x-app-platform"]?.[0]?.value as
      | "ios"
      | "android";

    const appVersion = headers["x-app-version"]?.[0]?.value;
    if (!bundleId || !appPlatform || !appVersion) {
      return c.json({ error: "Missing required headers." }, 400);
    }

    const updateInfo = await getUpdateInfo(s3, bucketName, {
      platform: appPlatform,
      bundleId,
      appVersion,
    });
    if (!updateInfo) {
      return c.json(null);
    }

    const finalInfo = await signUpdateInfoFileUrl(updateInfo);
    return c.json(finalInfo);
  } catch {
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("*", async (c) => {
  c.env.callback(null, c.env.request);
});

export const handler = handle(app) as CloudFrontRequestHandler;
