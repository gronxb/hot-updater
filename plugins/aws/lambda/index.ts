import { SSM } from "@aws-sdk/client-ssm";
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
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
  };
}

const CLOUDFRONT_KEY_PAIR_ID = HotUpdater.CLOUDFRONT_KEY_PAIR_ID;
const SSM_PARAMETER_NAME = HotUpdater.SSM_PARAMETER_NAME;
const SSM_REGION = HotUpdater.SSM_REGION;

// Global cache for private key (persists across warm Lambda invocations)
let cachedPrivateKey: string | null = null;

/**
 * Retrieves CloudFront private key from SSM Parameter Store
 * Uses global cache to avoid repeated SSM calls on warm Lambda invocations
 */
async function getPrivateKey(): Promise<string> {
  if (cachedPrivateKey !== null) {
    return cachedPrivateKey;
  }

  // Validate SSM region format
  if (!SSM_REGION) {
    throw new Error(
      `Invalid AWS region format: ${SSM_REGION}. Expected format like 'us-east-1' or 'ap-southeast-1'`,
    );
  }

  const ssmClient = new SSM({ region: SSM_REGION });
  const response = await ssmClient.getParameter({
    Name: SSM_PARAMETER_NAME,
    WithDecryption: true,
  });

  if (!response.Parameter?.Value) {
    throw new Error(
      `Failed to retrieve private key from SSM parameter: ${SSM_PARAMETER_NAME}`,
    );
  }

  // Parse the stored key pair JSON with error handling
  let keyPair: { privateKey?: unknown };
  try {
    keyPair = JSON.parse(response.Parameter.Value);
  } catch (error) {
    throw new Error(
      `Invalid JSON format in SSM parameter: ${SSM_PARAMETER_NAME}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const privateKey = keyPair.privateKey;

  if (!privateKey || typeof privateKey !== "string") {
    throw new Error(
      `Invalid private key format in SSM parameter: ${SSM_PARAMETER_NAME}`,
    );
  }

  cachedPrivateKey = privateKey;
  return privateKey;
}

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
  expiresSeconds: number,
) => {
  try {
    const cdnHost = c.req.header("host");
    if (!cdnHost) {
      return c.json({ error: "Missing host header." }, 500);
    }

    // Retrieve private key from SSM (or cache)
    const privateKey = await getPrivateKey();

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
        privateKey: privateKey,
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
      privateKey: privateKey,
      expiresSeconds,
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

    const expiresSeconds = 60;
    return handleUpdateRequest(
      c,
      params,
      fingerprintHash ? "fingerprint" : "appVersion",
      expiresSeconds,
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

    // Since the signedUrl is also cached due to caching,
    // we set a sufficiently long expiration time for the signedUrl in this endpoint.
    const expiresSeconds = 60 * 60 * 24 * 365; // 1 year
    return handleUpdateRequest(c, params, "appVersion", expiresSeconds);
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

    // Since the signedUrl is also cached due to caching,
    // we set a sufficiently long expiration time for the signedUrl in this endpoint.
    const expiresSeconds = 60 * 60 * 24 * 365; // 1 year
    return handleUpdateRequest(c, params, "fingerprint", expiresSeconds);
  },
);

app.get("*", async (c) => {
  return c.env.callback(null, c.env.request);
});

export const handler = handle(app) as CloudFrontRequestHandler;
