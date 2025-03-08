import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type Platform,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import admin from "firebase-admin";
import functions from "firebase-functions";

declare global {
  var HotUpdater: {
    REGION: string;
  };
}

admin.initializeApp();
const db = admin.firestore();

export const isAppVersionCompatible = (
  targetAppVersion: string,
  appVersion: string,
): boolean => {
  if (targetAppVersion === "*") {
    return true;
  }

  if (targetAppVersion.includes("x")) {
    const targetParts = targetAppVersion.split(".");
    const appParts = appVersion.split(".");

    for (let i = 0; i < targetParts.length && i < appParts.length; i++) {
      if (targetParts[i] === "x") continue;
      if (targetParts[i] !== appParts[i]) return false;
    }

    return true;
  }

  return appVersion >= targetAppVersion;
};

export function validatePlatform(platform: string): Platform | null {
  const validPlatforms: Platform[] = ["ios", "android"];
  return validPlatforms.includes(platform as Platform)
    ? (platform as Platform)
    : null;
}

export const getUpdateInfo = async ({
  platform,
  bundleId,
  appVersion,
}: GetBundlesArgs): Promise<UpdateInfo | null> => {
  const bundlesRef = db.collection("bundles");

  const query = bundlesRef
    .where("enabled", "==", true)
    .where("platform", "==", platform);

  const bundlesSnapshot = await query.get();

  const bundles: Bundle[] = bundlesSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: data.id,
      fileUrl: data.file_url,
      fileHash: data.file_hash,
      platform: data.platform as Platform,
      targetAppVersion: data.target_app_version,
      shouldForceUpdate: Boolean(data.should_force_update),
      enabled: Boolean(data.enabled),
      gitCommitHash: data.git_commit_hash || null,
      message: data.message || null,
    };
  });

  const compatibleBundles = bundles.filter((bundle) =>
    isAppVersionCompatible(bundle.targetAppVersion, appVersion),
  );

  const isRollback =
    bundleId !== NIL_UUID && !compatibleBundles.some((b) => b.id === bundleId);

  if (compatibleBundles.length === 0) {
    if (isRollback) {
      return {
        id: NIL_UUID,
        shouldForceUpdate: true,
        fileUrl: null,
        fileHash: null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }
    return null;
  }

  const latestBundle = compatibleBundles.sort((a, b) =>
    b.id.localeCompare(a.id),
  )[0];

  if (isRollback) {
    return {
      id: latestBundle.id,
      shouldForceUpdate: true,
      fileUrl: latestBundle.fileUrl,
      fileHash: latestBundle.fileHash,
      status: "ROLLBACK" as UpdateStatus,
    };
  }

  if (bundleId === NIL_UUID || latestBundle.id.localeCompare(bundleId) > 0) {
    return {
      id: latestBundle.id,
      shouldForceUpdate: Boolean(latestBundle.shouldForceUpdate),
      fileUrl: latestBundle.fileUrl,
      fileHash: latestBundle.fileHash,
      status: "UPDATE" as UpdateStatus,
    };
  }

  return null;
};

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

      const result = await getUpdateInfo({
        platform,
        appVersion,
        bundleId,
      });

      const responseData = result || {
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
