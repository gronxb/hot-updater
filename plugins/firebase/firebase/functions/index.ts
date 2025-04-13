import { NIL_UUID, type Platform } from "@hot-updater/core";
import { signToken, verifyJwtSignedUrl } from "@hot-updater/js";
import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { Hono } from "hono";
import { createFirebaseApp } from "./createFirebaseApp";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    REGION: string;
    JWT_SECRET: string;
    PROJECT_ID: string;
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

  const path = `${updateInfo.id}/bundle.zip`;
  const fileUrl = new URL(
    `hot-updater/${path}`,
    `https://${HotUpdater.REGION}-${HotUpdater.PROJECT_ID}.cloudfunctions.net`,
  );
  const token = await signToken(path, HotUpdater.JWT_SECRET);
  fileUrl.searchParams.append("token", token);

  const appUpdateInfo = {
    ...updateInfo,
    fileUrl: fileUrl.toString(),
  };

  return c.json(appUpdateInfo, 200);
});

app.get("*", async (c) => {
  const path = c.req.path.substring(1);
  const token = c.req.query("token");
  const result = await verifyJwtSignedUrl({
    path,
    token,
    jwtSecret: HotUpdater.JWT_SECRET,
    handler: async (key) => {
      const bucket = admin.storage().bucket(admin.app().options.storageBucket);

      const file = bucket.file(key);
      const [exists] = await file.exists();

      if (!exists) {
        console.error(`File not found: ${key}`);
        return null;
      }

      const [metadata] = await file.getMetadata();
      const [fileContent] = await file.download();

      return {
        body: fileContent,
        contentType: metadata.contentType,
      };
    },
  });

  if (result.status !== 200) {
    return c.json({ error: result.error }, result.status);
  }
  return c.body(result.responseBody, 200, result.responseHeaders);
});

const hotUpdaterFunction = createFirebaseApp(functions, {
  region: HotUpdater.REGION,
})(app);

export const hot = {
  updater: hotUpdaterFunction,
};
