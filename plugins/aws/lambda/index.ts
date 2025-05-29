import {
  type GetBundlesArgs,
  NIL_UUID,
  type Platform,
  type UpdateStrategy,
} from "@hot-updater/core";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { type Context, Hono } from "hono";
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

interface UpdateRequestParams {
  platform: Platform;
  bundleId: string;
  channel: string;
  minBundleId: string;
  appVersion?: string;
  fingerprintHash?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

const validatePlatform = (platform: string): platform is Platform => {
  return ["ios", "android"].includes(platform);
};

const validateRequiredParams = (
  params: Record<string, any>,
  required: string[],
) => {
  const missing = required.filter((key) => !params[key]);
  if (missing.length > 0) {
    return `Missing required parameters: ${missing.join(", ")}`;
  }
  return null;
};

const processDefaultValues = (channel: string, minBundleId: string) => ({
  actualChannel: channel === "default" ? "production" : channel,
  actualMinBundleId: minBundleId === "default" ? NIL_UUID : minBundleId,
});

const handleUpdateRequest = async (
  c: Context<{ Bindings: Bindings }>,
  params: UpdateRequestParams,
  strategy: UpdateStrategy,
) => {
  try {
    const cdnHost = c.req.header("host");
    if (!cdnHost) {
      return c.json({ error: "Missing host header." }, 500);
    }

    const updateConfig: GetBundlesArgs = {
      platform: params.platform,
      bundleId: params.bundleId,
      minBundleId: params.minBundleId,
      channel: params.channel,
      ...(strategy === "appVersion"
        ? { appVersion: params.appVersion!, _updateStrategy: "appVersion" }
        : {
            fingerprintHash: params.fingerprintHash!,
            _updateStrategy: "fingerprint",
          }),
    };

    const updateInfo = await getUpdateInfo(
      {
        baseUrl: c.req.url,
        keyPairId: CLOUDFRONT_KEY_PAIR_ID,
        privateKey: CLOUDFRONT_PRIVATE_KEY,
      },
      updateConfig,
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
  } catch (error) {
    console.error("Update request error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
};

app.get("/api/check-update", async (c) => {
  try {
    const { headers } = c.env.request;

    const bundleId = headers["x-bundle-id"]?.[0]?.value;
    const platform = headers["x-app-platform"]?.[0]?.value;
    const appVersion = headers["x-app-version"]?.[0]?.value;
    const minBundleId = headers["x-min-bundle-id"]?.[0]?.value ?? NIL_UUID;
    const channel = headers["x-channel"]?.[0]?.value ?? "production";
    const fingerprintHash = headers["x-fingerprint-hash"]?.[0]?.value;

    // Validation
    const requiredError = validateRequiredParams({ bundleId, platform }, [
      "bundleId",
      "platform",
    ]);
    if (requiredError) {
      return c.json({ error: requiredError }, 400);
    }

    if (!validatePlatform(platform)) {
      return c.json(
        { error: "Invalid platform. Must be 'ios' or 'android'." },
        400,
      );
    }

    if (!appVersion && !fingerprintHash) {
      return c.json(
        {
          error:
            "Missing required headers (x-app-version or x-fingerprint-hash).",
        },
        400,
      );
    }

    const params: UpdateRequestParams = {
      platform,
      bundleId,
      channel,
      minBundleId,
      ...(fingerprintHash ? { fingerprintHash } : { appVersion }),
    };

    return handleUpdateRequest(
      c,
      params,
      fingerprintHash ? "fingerprint" : "appVersion",
    );
  } catch (error) {
    console.error("Legacy endpoint error:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get(
  "/api/check-update/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
  async (c) => {
    const { platform, appVersion, channel, minBundleId, bundleId } =
      c.req.param();

    const requiredError = validateRequiredParams(
      { platform, appVersion, bundleId },
      ["platform", "appVersion", "bundleId"],
    );
    if (requiredError) {
      return c.json({ error: requiredError }, 400);
    }

    if (!validatePlatform(platform)) {
      return c.json(
        { error: "Invalid platform. Must be 'ios' or 'android'." },
        400,
      );
    }

    const { actualChannel, actualMinBundleId } = processDefaultValues(
      channel,
      minBundleId,
    );

    const params: UpdateRequestParams = {
      platform,
      bundleId,
      channel: actualChannel,
      minBundleId: actualMinBundleId,
      appVersion,
    };

    return handleUpdateRequest(c, params, "appVersion");
  },
);

app.get(
  "/api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  async (c) => {
    const { platform, fingerprintHash, channel, minBundleId, bundleId } =
      c.req.param();

    // Validation
    const requiredError = validateRequiredParams(
      { platform, fingerprintHash, bundleId },
      ["platform", "fingerprintHash", "bundleId"],
    );
    if (requiredError) {
      return c.json({ error: requiredError }, 400);
    }

    if (!validatePlatform(platform)) {
      return c.json(
        { error: "Invalid platform. Must be 'ios' or 'android'." },
        400,
      );
    }

    const { actualChannel, actualMinBundleId } = processDefaultValues(
      channel,
      minBundleId,
    );

    const params: UpdateRequestParams = {
      platform,
      bundleId,
      channel: actualChannel,
      minBundleId: actualMinBundleId,
      fingerprintHash,
    };

    return handleUpdateRequest(c, params, "fingerprint");
  },
);

app.get("*", async (c) => {
  return c.env.callback(null, c.env.request);
});

export const handler = handle(app) as CloudFrontRequestHandler;
