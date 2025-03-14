import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import type { UpdateInfoLayer } from "../../../packages/core/src/types";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    S3_BUCKET_NAME: string;
    S3_REGION: string;
  };
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const s3 = new S3Client({ region: HotUpdater.S3_REGION });
const bucketName = HotUpdater.S3_BUCKET_NAME;

async function createPresignedUrl(id: string) {
  return getSignedUrl(
    // @ts-ignore
    s3,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: [id, "build.zip"].join("/"),
    }),
    {
      expiresIn: 60,
    },
  );
}

async function signUpdateInfoFileUrl(updateInfoLayer: UpdateInfoLayer) {
  const fileUrl = await createPresignedUrl(updateInfoLayer.id);
  return { ...updateInfoLayer, fileUrl };
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

    const updateInfoLayer = await getUpdateInfo(s3, HotUpdater.S3_BUCKET_NAME, {
      platform: appPlatform,
      bundleId,
      appVersion,
      minBundleId,
      channel,
    });
    if (!updateInfoLayer) {
      return c.json(null);
    }

    const finalInfo = await signUpdateInfoFileUrl(updateInfoLayer);
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
