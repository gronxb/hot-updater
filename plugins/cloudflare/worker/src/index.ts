import { type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { verifyJwtSignedUrl, withJwtSignedUrl } from "@hot-updater/js";
import { Hono } from "hono";
import { getUpdateInfo } from "./getUpdateInfo";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

const decodeMaybe = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const handleUpdateRequest = async (
  db: D1Database,
  updateConfig: GetBundlesArgs,
  reqUrl: string,
  jwtSecret: string,
) => {
  const updateInfo = await getUpdateInfo(db, updateConfig);

  if (!updateInfo) {
    return null;
  }

  return withJwtSignedUrl({
    data: updateInfo,
    reqUrl,
    jwtSecret,
  });
};

app.get("/api/check-update", async (c) => {
  const bundleId = c.req.header("x-bundle-id") as string;
  const appPlatform = c.req.header("x-app-platform") as "ios" | "android";
  const minBundleId = c.req.header("x-min-bundle-id") as string;
  const appVersion = c.req.header("x-app-version") as string | null;
  const channel = c.req.header("x-channel") as string | null;
  const deviceId = c.req.header("x-device-id") as string | null;
  const fingerprintHash =
    c.req.header("x-fingerprint-hash") ?? (null as string | null);

  if (!bundleId || !appPlatform) {
    return c.json(
      { error: "Missing required headers (x-app-platform, x-bundle-id)." },
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

  const updateConfig = fingerprintHash
    ? ({
        fingerprintHash,
        bundleId,
        platform: appPlatform,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        deviceId: deviceId || undefined,
        _updateStrategy: "fingerprint" as const,
      } satisfies GetBundlesArgs)
    : ({
        appVersion: appVersion!,
        bundleId,
        platform: appPlatform,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        deviceId: deviceId || undefined,
        _updateStrategy: "appVersion" as const,
      } satisfies GetBundlesArgs);

  const result = await handleUpdateRequest(
    c.env.DB,
    updateConfig,
    c.req.url,
    c.env.JWT_SECRET,
  );

  return c.json(result, 200);
});

app.get(
  "/api/check-update/app-version/:platform/:app-version/:channel/:minBundleId/:bundleId",
  async (c) => {
    const {
      platform,
      "app-version": appVersion,
      channel,
      minBundleId,
      bundleId,
    } = c.req.param();

    if (!bundleId || !platform) {
      return c.json(
        { error: "Missing required parameters (platform, bundleId)." },
        400,
      );
    }

    const updateConfig = {
      platform: platform as "ios" | "android",
      appVersion,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      _updateStrategy: "appVersion" as const,
    } satisfies GetBundlesArgs;

    const result = await handleUpdateRequest(
      c.env.DB,
      updateConfig,
      c.req.url,
      c.env.JWT_SECRET,
    );

    return c.json(result, 200);
  },
);

app.get(
  "/api/check-update/app-version/:platform/:app-version/:channel/:minBundleId/:bundleId/:deviceId",
  async (c) => {
    const {
      platform,
      "app-version": appVersion,
      channel,
      minBundleId,
      bundleId,
      deviceId,
    } = c.req.param();

    if (!bundleId || !platform) {
      return c.json(
        { error: "Missing required parameters (platform, bundleId)." },
        400,
      );
    }

    const updateConfig = {
      platform: platform as "ios" | "android",
      appVersion,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      deviceId: decodeMaybe(deviceId),
      _updateStrategy: "appVersion" as const,
    } satisfies GetBundlesArgs;

    const result = await handleUpdateRequest(
      c.env.DB,
      updateConfig,
      c.req.url,
      c.env.JWT_SECRET,
    );

    return c.json(result, 200);
  },
);

app.get(
  "/api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  async (c) => {
    const { platform, fingerprintHash, channel, minBundleId, bundleId } =
      c.req.param();

    if (!bundleId || !platform) {
      return c.json(
        { error: "Missing required parameters (platform, bundleId)." },
        400,
      );
    }

    const updateConfig = {
      platform: platform as "ios" | "android",
      fingerprintHash,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      _updateStrategy: "fingerprint" as const,
    } satisfies GetBundlesArgs;

    const result = await handleUpdateRequest(
      c.env.DB,
      updateConfig,
      c.req.url,
      c.env.JWT_SECRET,
    );

    return c.json(result, 200);
  },
);

app.get(
  "/api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:deviceId",
  async (c) => {
    const {
      platform,
      fingerprintHash,
      channel,
      minBundleId,
      bundleId,
      deviceId,
    } = c.req.param();

    if (!bundleId || !platform) {
      return c.json(
        { error: "Missing required parameters (platform, bundleId)." },
        400,
      );
    }

    const updateConfig = {
      platform: platform as "ios" | "android",
      fingerprintHash,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      deviceId: decodeMaybe(deviceId),
      _updateStrategy: "fingerprint" as const,
    } satisfies GetBundlesArgs;

    const result = await handleUpdateRequest(
      c.env.DB,
      updateConfig,
      c.req.url,
      c.env.JWT_SECRET,
    );

    return c.json(result, 200);
  },
);

app.get("*", async (c) => {
  const result = await verifyJwtSignedUrl({
    path: c.req.path,
    token: c.req.query("token"),
    jwtSecret: c.env.JWT_SECRET,
    handler: async (storageUri) => {
      const [, ...key] = storageUri.split("/");
      const object = await c.env.BUCKET.get(key.join("/"));
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
