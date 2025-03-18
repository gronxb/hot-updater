import functions from "@google-cloud/functions-framework";
import type { Bundle, Platform } from "@hot-updater/core";



async function signUpdateInfoFileUrl(updateInfo) {
    if (updateInfo?.fileUrl) {
      updateInfo.fileUrl = await createPresignedUrl(updateInfo.fileUrl);
    }
    return updateInfo;
  }




export const getUpdateInfo = async (
    bucketName: string,
    {
      platform,
      appVersion,
      bundleId,
    }: {
      platform: Platform;
      appVersion: string;
      bundleId: string;
    },
  ) => {
    const targetAppVersions = await getS3Json(
      s3,
      bucketName,
      `${platform}/target-app-versions.json`,
    );
  
    const matchingVersions = filterCompatibleAppVersions(
      targetAppVersions ?? [],
      appVersion,
    );
  
    const results = await Promise.allSettled(
      matchingVersions.map((targetAppVersion) =>
        getS3Json(s3, bucketName, `${platform}/${targetAppVersion}/update.json`),
      ),
    );
  
    const bundles = results
      .filter(
        (r): r is PromiseFulfilledResult<Bundle[]> => r.status === "fulfilled",
      )
      .flatMap((r) => r.value ?? []);
  
    return getUpdateInfoJS(bundles, {
      platform,
      bundleId,
      appVersion,
    });
  };
  
functions.http("helloHttp", async (req, res) => {
  try {
    const bundleId = req.headers["x-bundle-id"] as string | undefined;
    const appPlatform = req.headers["x-app-platform"] as
      | "ios"
      | "android"
      | undefined;

    const appVersion = req.headers["x-app-version"] as string | undefined;

    if (!bundleId || !appPlatform || !appVersion) {
      return res.status(400).send({ error: "Missing required headers." });
    }

    const updateInfo = await getUpdateInfo(bundleId, appPlatform, appVersion);
    if (!updateInfo) {
      return res.status(404).send();
    }

    const finalInfo = await signUpdateInfoFileUrl(updateInfo);
    res.json(finalInfo);
  } catch (error) {
    console.error('Internal Server Error:', error);
    res.status(500).send({ error: 'Internal Server Error' });
});

/*


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

    const appVersion = headers["x-app-versioanyn"]?.[0]?.value;
    if (!bundleId || !appPlatform || !appVersion) {
      return c.json({ error: "Missing required headers." }, 400);
    }

    const updateInfo = await getUpdateInfo(s3, HotUpdater.S3_BUCKET_NAME, {
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
*/
