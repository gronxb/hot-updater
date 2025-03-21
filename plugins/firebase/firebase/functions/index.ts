import {
  NIL_UUID,
  type Platform,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import admin from "firebase-admin";
import functions from "firebase-functions";
import { getUpdateInfo } from "./getUpdateInfo";

interface UpdateInfoWithUrl extends UpdateInfo {
  fileUrl: string | null;
  fileHash: string | null;
}

declare global {
  var HotUpdater: {
    REGION: string;
    BUCKET_NAME?: string;
  };
}

if (typeof global.HotUpdater === "undefined") {
  global.HotUpdater = {
    REGION: process.env.FUNCTION_REGION || "us-central1",
    BUCKET_NAME: process.env.STORAGE_BUCKET || undefined,
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
      "Content-Type, x-app-platform, x-app-version, x-bundle-id, x-channel",
    );

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    try {
      const platformHeader = req.headers["x-app-platform"] as string;
      const appVersion = req.headers["x-app-version"] as string;
      const bundleId = req.headers["x-bundle-id"] as string;
      const channel = req.headers["x-channel"] as string | undefined;

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
        channel,
      });

      if (!updateInfo) {
        const noUpdateResponse: UpdateInfoWithUrl = {
          id: NIL_UUID,
          shouldForceUpdate: false,
          message: null,
          status: "NO_UPDATE" as UpdateStatus,
          fileUrl: null,
          fileHash: null,
        };
        res.status(200).json(noUpdateResponse);
        return;
      }

      if (updateInfo.id === NIL_UUID || updateInfo.status === "ROLLBACK") {
        const rollbackResponse: UpdateInfoWithUrl = {
          ...updateInfo,
          fileUrl: null,
          fileHash: null,
        };
        res.status(200).json(rollbackResponse);
        return;
      }

      try {
        const bundleDoc = await db
          .collection("bundles")
          .doc(updateInfo.id)
          .get();
        const bundleData = bundleDoc.data();
        const fileHash = bundleData?.file_hash || null;

        const bucket = admin.storage().bucket(HotUpdater.BUCKET_NAME);
        const file = bucket.file(`bundles/${updateInfo.id}/bundle.zip`);

        const [signedUrl] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 60, 
        });

        const responseWithUrl: UpdateInfoWithUrl = {
          ...updateInfo,
          fileUrl: signedUrl,
          fileHash: fileHash,
        };

        res.status(200).json(responseWithUrl);
      } catch (urlError) {
        console.error("Error generating signed URL:", urlError);
        const fallbackResponse: UpdateInfoWithUrl = {
          ...updateInfo,
          fileUrl: null,
          fileHash: null,
        };
        res.status(200).json(fallbackResponse);
      }
    } catch (error) {
      console.error("Update info error:", error);
      res.status(500).send("Internal Server Error");
    }
  },
);
