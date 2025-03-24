import { NIL_UUID } from "@hot-updater/core";
import { verifyJwtSignedUrl, withJwtSignedUrl } from "@hot-updater/js";
import admin from "firebase-admin";
import functions from "firebase-functions";
import { getUpdateInfo } from "./getUpdateInfo";

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

function getServiceUrl(
  req: functions.https.Request,
  serviceName: string,
): string {
  const hostname = req.hostname || "";

  if (hostname.includes(".run.app")) {
    const parts = hostname.split("-");
    if (parts.length >= 3) {
      const projectHash = parts[parts.length - 2];
      const regionDomain = parts[parts.length - 1];

      return `https://${serviceName}-${projectHash}-${regionDomain}`;
    }
  }

  return "";
}

export const checkUpdateJwt = functions.https.onRequest(
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

      if (updateInfo.id !== NIL_UUID && updateInfo.status !== "ROLLBACK") {
        try {
          const bundleDoc = await db
            .collection("bundles")
            .doc(updateInfo.id)
            .get();
          const bundleData = bundleDoc.data();

          if (bundleData) {
            fileHash = bundleData.file_hash || null;
          }
        } catch (error) {
          console.error("Error fetching bundle data:", error);
        }
      }

      const responseData = {
        ...updateInfo,
        fileHash,
      };

      const baseUrl = getServiceUrl(req, "jwtbundledownload");

      if (!baseUrl) {
        res
          .status(500)
          .json({ error: "Unable to determine download service URL" });
        return;
      }

      const appUpdateInfo = await withJwtSignedUrl({
        data: responseData,
        reqUrl: baseUrl,
        jwtSecret: HotUpdater.JWT_SECRET,
      });

      res.status(200).json(appUpdateInfo);
    } catch (error) {
      console.error("Update check error:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },
);

export const jwtBundleDownload = functions.https.onRequest(
  {
    region: HotUpdater.REGION,
    cors: true,
  },
  async (req, res) => {
    try {
      const result = await verifyJwtSignedUrl({
        path: req.path,
        token: req.query.token as string | undefined,
        jwtSecret: HotUpdater.JWT_SECRET,
        handler: async (key) => {
          try {
            const bucket = admin.storage().bucket(HotUpdater.BUCKET_NAME);
            const file = bucket.file(key);

            const [exists] = await file.exists();
            if (!exists) {
              return null;
            }

            const [metadata] = await file.getMetadata();
            const [fileContent] = await file.download();

            return {
              body: fileContent,
              contentType: metadata.contentType || "application/octet-stream",
            };
          } catch (error) {
            console.error("Error retrieving file from storage:", error);
            return null;
          }
        },
      });

      if (result.status !== 200) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      if (result.responseHeaders) {
        for (const [key, value] of Object.entries(result.responseHeaders)) {
          res.set(key, value);
        }
      }

      res.status(200).send(result.responseBody);
    } catch (error) {
      console.error("Error in bundle download process:", error);
      res.status(500).json({
        error: "Internal Server Error",
      });
    }
  },
);
