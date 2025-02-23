import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Bundle } from "@hot-updater/core";
import { filterCompatibleAppVersions, getUpdateInfo } from "@hot-updater/js";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";

const s3 = new S3Client();

const getS3Json = async (bucket: string, key: string) => {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const { Body } = await s3.send(command);

    if (!Body) {
      console.warn(`S3 object not found: ${key}`);
      return null;
    }

    const jsonString = await Body.transformToString();
    return JSON.parse(jsonString);
  } catch (error) {
    if ((error as any).name === "NoSuchKey") {
      console.warn(`No such key: ${key}`);
      return null;
    }
    console.error(`Failed to get S3 object: ${key}`, error);
    throw error;
  }
};

type Bindings = {
  callback: Callback;
  request: CloudFrontRequest;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/check-update", async (c) => {
  try {
    const request = c.env.request;
    const headers = request.headers;

    let bucketName: string | undefined;
    if (request.origin?.s3?.domainName) {
      const domainName = request.origin.s3.domainName;
      [bucketName] = domainName.split(".s3");
    }

    if (!bucketName) {
      return c.json(
        {
          error: "Bucket name not found in request origin.",
        },
        500,
      );
    }

    const bundleId = headers["x-bundle-id"]?.[0]?.value;
    const appPlatform = headers["x-app-platform"]?.[0]?.value as
      | "ios"
      | "android";
    const appVersion = headers["x-app-version"]?.[0]?.value;

    if (!bundleId || !appPlatform || !appVersion) {
      return c.json(
        {
          error: "Missing bundleId, appPlatform, or appVersion",
        },
        400,
      );
    }

    const targetAppVersions = await getS3Json(
      bucketName,
      `${appPlatform}/target-app-versions.json`,
    );
    if (!targetAppVersions) {
      return c.json(null);
    }

    const matchingVersions = filterCompatibleAppVersions(
      targetAppVersions,
      appVersion,
    );
    if (!matchingVersions || matchingVersions.length === 0) {
      return c.json(null);
    }

    const results = await Promise.allSettled(
      matchingVersions.map((version) =>
        getS3Json(bucketName, `${appPlatform}/${version}/update.json`),
      ),
    );

    const bundles = results
      .filter(
        (result): result is PromiseFulfilledResult<Bundle[]> =>
          result.status === "fulfilled",
      )
      .flatMap((result) => result.value ?? []);

    const updateInfo = await getUpdateInfo(bundles, {
      platform: appPlatform,
      bundleId,
      appVersion,
    });

    return c.json(updateInfo);
  } catch (error) {
    console.error("Error in check-update handler:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("*", async (c) => {
  c.env.callback(null, c.env.request);
});

export const handler = handle(app);
