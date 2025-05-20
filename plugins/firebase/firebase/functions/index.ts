import { NIL_UUID, type Platform } from "@hot-updater/core";
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

    const updateInfo = fingerprintHash
      ? await getUpdateInfo(db, {
          platform: platform as Platform,
          fingerprintHash,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "fingerprint",
        })
      : await getUpdateInfo(db, {
          platform: platform as Platform,
          appVersion: appVersion!,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "appVersion",
        });

    if (!updateInfo) {
      return c.json(null, 200);
    }

    if (updateInfo.id === NIL_UUID) {
      return c.json({
        ...updateInfo,
        fileUrl: null,
      });
    }

    let signedUrl: string | null = null;
    if (!updateInfo.storageUri) {
      const [_signedUrl] = await admin
        .storage()
        .bucket(admin.app().options.storageBucket)
        .file([updateInfo.id, "bundle.zip"].join("/"))
        .getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 1000,
        });
      signedUrl = _signedUrl;
    } else {
      const storageUrl = new URL(updateInfo.storageUri);
      const [_signedUrl] = await admin
        .storage()
        .bucket(storageUrl.host)
        .file(storageUrl.pathname)
        .getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 1000,
        });
      signedUrl = _signedUrl;
    }

    return c.json(
      {
        ...updateInfo,
        fileUrl: signedUrl,
      },
      200,
    );
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

const hotUpdaterFunction = createFirebaseApp({
  region: HotUpdater.REGION,
})(app);

export const hot = {
  updater: hotUpdaterFunction,
};
