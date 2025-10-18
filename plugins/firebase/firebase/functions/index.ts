import {
  type GetBundlesArgs,
  NIL_UUID,
  type Platform,
} from "@hot-updater/core";
import * as admin from "firebase-admin";
import { Hono } from "hono";
import { createFirebaseApp } from "./createFirebaseApp";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

const app = new Hono();

app.get("/ping", (c) => {
  return c.text("pong");
});

const handleUpdateRequest = async (
  db: FirebaseFirestore.Firestore,
  updateConfig: GetBundlesArgs,
) => {
  const updateInfo = await getUpdateInfo(db, updateConfig);

  if (!updateInfo) {
    return null;
  }

  const { storageUri, ...rest } = updateInfo;

  if (rest.id === NIL_UUID) {
    return {
      ...rest,
      fileUrl: null,
    };
  }

  let signedUrl: string | null = null;
  if (!storageUri) {
    // Fallback: Try to find bundle file by listing with prefix
    // This handles old bundles that don't have storageUri set
    const bucket = admin.storage().bucket(admin.app().options.storageBucket);
    const [files] = await bucket.getFiles({ prefix: rest.id });

    // Find the bundle file (should end with .zip, .tar.gz, or .tar.br)
    const bundleFile = files.find(
      (file) =>
        file.name.endsWith(".zip") ||
        file.name.endsWith(".tar.gz") ||
        file.name.endsWith(".tar.br"),
    );

    if (!bundleFile) {
      throw new Error(`Bundle file not found for id: ${rest.id}`);
    }

    const [_signedUrl] = await bundleFile.getSignedUrl({
      action: "read",
      expires: Date.now() + 60 * 1000,
    });
    signedUrl = _signedUrl;
  } else {
    const storageUrl = new URL(storageUri);
    const [_signedUrl] = await admin
      .storage()
      .bucket(storageUrl.host)
      .file(storageUrl.pathname.slice(1))
      .getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 1000,
      });
    signedUrl = _signedUrl;
  }

  return {
    ...rest,
    fileUrl: signedUrl,
  };
};

app.get("/api/check-update", async (c) => {
  try {
    const platform = c.req.header("x-app-platform");
    const appVersion = c.req.header("x-app-version");
    const bundleId = c.req.header("x-bundle-id");
    const minBundleId = c.req.header("x-min-bundle-id");
    const channel = c.req.header("x-channel");
    const fingerprintHash = c.req.header("x-fingerprint-hash");

    if (!bundleId || !platform) {
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

    const db = admin.firestore();

    const updateConfig = fingerprintHash
      ? ({
          platform: platform as Platform,
          fingerprintHash,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "fingerprint" as const,
        } satisfies GetBundlesArgs)
      : ({
          platform: platform as Platform,
          appVersion: appVersion!,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "appVersion" as const,
        } satisfies GetBundlesArgs);

    const result = await handleUpdateRequest(db, updateConfig);
    return c.json(result, result ? 200 : 200);
  } catch (error) {
    if (error instanceof Error) {
      return c.json(
        {
          error: error.message,
        },
        500,
      );
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get(
  "/api/check-update/app-version/:platform/:app-version/:channel/:minBundleId/:bundleId",
  async (c) => {
    try {
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

      const db = admin.firestore();

      const updateConfig = {
        platform: platform as Platform,
        appVersion,
        bundleId,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        _updateStrategy: "appVersion" as const,
      } satisfies GetBundlesArgs;

      const result = await handleUpdateRequest(db, updateConfig);
      return c.json(result, result ? 200 : 200);
    } catch (error) {
      if (error instanceof Error) {
        return c.json(
          {
            error: error.message,
          },
          500,
        );
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  },
);

app.get(
  "/api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  async (c) => {
    try {
      const { platform, fingerprintHash, channel, minBundleId, bundleId } =
        c.req.param();

      if (!bundleId || !platform) {
        return c.json(
          { error: "Missing required parameters (platform, bundleId)." },
          400,
        );
      }

      const db = admin.firestore();

      const updateConfig = {
        platform: platform as Platform,
        fingerprintHash,
        bundleId,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        _updateStrategy: "fingerprint" as const,
      } satisfies GetBundlesArgs;

      const result = await handleUpdateRequest(db, updateConfig);
      return c.json(result, result ? 200 : 200);
    } catch (error) {
      if (error instanceof Error) {
        return c.json(
          {
            error: error.message,
          },
          500,
        );
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  },
);

const hotUpdaterFunction = createFirebaseApp({
  region: HotUpdater.REGION,
})(app);

export const hot = {
  updater: hotUpdaterFunction,
};
