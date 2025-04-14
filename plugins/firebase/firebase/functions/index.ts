import { NIL_UUID, type Platform } from "@hot-updater/core";
import * as admin from "firebase-admin";
import { cert } from "firebase-admin/app";
import * as functions from "firebase-functions/v1";
import { Hono } from "hono";
import { createFirebaseApp } from "./createFirebaseApp";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    REGION: string;
    PROJECT_ID: string;
    CLIENT_EMAIL: string;
    PRIVATE_KEY: string;
  };
}

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: HotUpdater.PROJECT_ID,
    storageBucket: `${HotUpdater.PROJECT_ID}.firebasestorage.app`,
    credential: cert({
      clientEmail: HotUpdater.CLIENT_EMAIL,
      privateKey: HotUpdater.PRIVATE_KEY,
      projectId: HotUpdater.PROJECT_ID,
    }),
  });
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
    if (!platform || !appVersion || !bundleId) {
      return c.json(
        {
          error:
            "Missing required headers (x-app-platform, x-app-version, x-bundle-id)",
        },
        400,
      );
    }
    const db = admin.firestore();

    const updateInfo = await getUpdateInfo(db, {
      platform: platform as Platform,
      appVersion,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
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

    const signedUrl = await admin
      .storage()
      .bucket(admin.app().options.storageBucket)
      .file([updateInfo.id, "bundle.zip"].join("/"))
      .getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 1000,
      });

    return c.json({ ...updateInfo, fileUrl: signedUrl }, 200);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 500);
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

const hotUpdaterFunction = createFirebaseApp(functions, {
  region: HotUpdater.REGION,
})(app);

export const hot = {
  updater: hotUpdaterFunction,
};
