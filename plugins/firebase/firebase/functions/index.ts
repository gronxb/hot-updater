import { NIL_UUID } from "@hot-updater/core";
import admin from "firebase-admin";
import functions from "firebase-functions";

declare global {
  var HotUpdater: {
    REGION: string;
    BUCKET_NAME?: string;
    JWT_SECRET: string;
  };
}

if (typeof global.HotUpdater === "undefined") {
  global.HotUpdater = {
    REGION: process.env.FUNCTION_REGION || "us-central1",
    BUCKET_NAME: process.env.STORAGE_BUCKET || undefined,
    JWT_SECRET: process.env.JWT_SECRET || "your-secret-key",
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

export function validatePlatform(platform: string): "ios" | "android" | null {
  const validPlatforms = ["ios", "android"];
  return validPlatforms.includes(platform)
    ? (platform as "ios" | "android")
    : null;
}

export const checkUpdateDirect = functions.https.onRequest(
  {
    region: HotUpdater.REGION,
    cors: true,
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, x-app-platform, x-app-version, x-bundle-id, x-min-bundle-id, x-channel",
    );

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    try {
      const platformHeader = req.headers["x-app-platform"] as string;
      const appVersion = req.headers["x-app-version"] as string;
      const bundleId = req.headers["x-bundle-id"] as string;
      const minBundleId = req.headers["x-min-bundle-id"] as string | undefined;
      const channel = req.headers["x-channel"] as string | undefined;

      if (!platformHeader || !appVersion || !bundleId) {
        res.status(400).json({
          error:
            "Missing required headers (x-app-platform, x-app-version, x-bundle-id)",
        });
        return;
      }

      const platform = validatePlatform(platformHeader);
      if (!platform) {
        res.status(400).json({
          error: "Invalid platform. Must be 'ios' or 'android'",
        });
        return;
      }

      const db = admin.firestore();
      const { getUpdateInfo } = require("./getUpdateInfo");
      const updateInfo = await getUpdateInfo(db, {
        platform,
        appVersion,
        bundleId,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
      });

      if (!updateInfo) {
        res.status(200).json(null);
        return;
      }

      let fileHash = null;
      let fileUrl = null;

      if (updateInfo.id !== NIL_UUID && updateInfo.status !== "ROLLBACK") {
        try {
          const bundleDoc = await db
            .collection("bundles")
            .doc(updateInfo.id)
            .get();
          const bundleData = bundleDoc.data();

          if (bundleData) {
            fileHash = bundleData.file_hash || null;
            const region = HotUpdater.REGION;
            const projectId = process.env.GCLOUD_PROJECT || "";
            fileUrl = `https://${region}-${projectId}.cloudfunctions.net/directBundleDownload/${updateInfo.id}`;
          }
        } catch (error) {
          console.error("Error fetching bundle data:", error);
        }
      }

      const responseData = {
        ...updateInfo,
        fileHash,
        fileUrl,
      };

      res.status(200).json(responseData);
    } catch (error) {
      console.error("Update check error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

export const directBundleDownload = functions.https.onRequest(
  {
    region: HotUpdater.REGION,
    cors: true,
  },
  async (req, res) => {
    const pathParts = req.path.split("/").filter((p) => p);
    const bundleId =
      pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;

    if (!bundleId) {
      res.status(400).json({ error: "Bundle ID is required" });
      return;
    }

    try {
      const bucket = admin.storage().bucket(HotUpdater.BUCKET_NAME);
      const filePath = `${bundleId}/bundle.zip`;
      const file = bucket.file(filePath);

      const [exists] = await file.exists();

      if (!exists) {
        res.status(404).json({
          error: "Bundle not found",
          path: filePath,
        });
        return;
      }

      try {
        const [fileContents] = await file.download();

        res.set("Content-Type", "application/zip");
        res.set("Content-Disposition", 'attachment; filename="bundle.zip"');
        res.set(
          "Cache-Control",
          "private, no-cache, no-store, must-revalidate",
        );
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");

        res.send(fileContents);
      } catch (downloadError) {
        console.error("Error downloading file:", downloadError);
        res.status(500).json({
          error: "Download Error",
          message: "An error occurred while downloading the file",
        });
      }
    } catch (error) {
      console.error("Error in bundle download process:", error);
      res.status(500).json({
        error: "Internal Server Error",
      });
    }
  },
);
