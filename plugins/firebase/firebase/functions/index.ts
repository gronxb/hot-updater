import { NIL_UUID, type Platform, type UpdateStatus } from "@hot-updater/core";
import admin from "firebase-admin";
import functions from "firebase-functions";
import { getUpdateInfo } from "./getUpdateInfo";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

if (typeof global.HotUpdater === "undefined") {
  global.HotUpdater = {
    REGION: process.env.FUNCTION_REGION || "us-central1",
  };
}

if (!admin.apps.length) {
  admin.initializeApp();
}

export function validatePlatform(platform: string): Platform | null {
  const validPlatforms: Platform[] = ["ios", "android"];
  return validPlatforms.includes(platform as Platform)
    ? (platform as Platform)
    : null;
}

export const updateInfoFunction = functions.https.onRequest(
  {
    region: HotUpdater.REGION,
    cors: true,
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, x-app-platform, x-app-version, x-bundle-id",
    );

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    try {
      const platformHeader = req.headers["x-app-platform"] as string;
      const appVersion = req.headers["x-app-version"] as string;
      const bundleId = req.headers["x-bundle-id"] as string;

      if (!platformHeader || !appVersion || !bundleId) {
        res
          .status(400)
          .send(
            "Missing required headers (x-app-platform, x-app-version, x-bundle-id)",
          );
        return;
      }

      const platform = validatePlatform(platformHeader);
      if (!platform) {
        res.status(400).send("Invalid platform. Must be 'ios', 'android'");
        return;
      }

      const db = admin.firestore();
      const updateInfo = await getUpdateInfo(db, {
        platform,
        appVersion,
        bundleId,
      });

      const responseData = updateInfo || {
        id: NIL_UUID,
        shouldForceUpdate: false,
        fileUrl: null,
        fileHash: null,
        status: "NO_UPDATE" as UpdateStatus,
      };

      res.status(200).json(responseData);
    } catch (error) {
      console.error("Update info error:", error);
      res.status(500).send("Internal Server Error");
    }
  },
);
