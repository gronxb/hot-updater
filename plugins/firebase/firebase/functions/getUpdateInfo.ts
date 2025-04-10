import type {
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
  UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  id: NIL_UUID,
  shouldForceUpdate: true,
  message: null,
  status: "ROLLBACK",
};

const convertToBundle = (data: any): Bundle => ({
  id: data.id,
  enabled: Boolean(data.enabled),
  shouldForceUpdate: Boolean(data.should_force_update),
  message: data.message || null,
  targetAppVersion: data.target_app_version,
  platform: data.platform,
  channel: data.channel || "production",
  fileHash: data.file_hash || "",
  gitCommitHash: data.git_commit_hash || "",
});

export const getUpdateInfo = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    let currentBundle: Bundle | null = null;
    let currentBundleExists = false;
    let currentBundleEnabled = false;
    let currentBundleChannel = "production";

    if (bundleId !== NIL_UUID) {
      const currentBundleDoc = await db
        .collection("bundles")
        .doc(bundleId)
        .get();
      currentBundleExists = currentBundleDoc.exists;

      if (currentBundleExists) {
        const data = currentBundleDoc.data()!;
        currentBundleEnabled = Boolean(data.enabled);
        currentBundleChannel = data.channel || "production";
        currentBundle = convertToBundle(data);
      }

      if (currentBundleExists && currentBundleChannel !== channel) {
        return null;
      }
    }

    const bundlesQuery = db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel);

    const bundlesSnapshot = await bundlesQuery.get();

    if (bundlesSnapshot.empty) {
      if (bundleId === minBundleId) {
        return null;
      }
      return bundleId === NIL_UUID ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    const allBundles: Bundle[] = [];

    for (const doc of bundlesSnapshot.docs) {
      const data = doc.data();

      const isCompatible =
        filterCompatibleAppVersions([data.target_app_version], appVersion)
          .length > 0;

      if (isCompatible) {
        allBundles.push(convertToBundle(data));
      }
    }

    const enabledBundles = allBundles.filter((b) => b.enabled);

    const candidateBundles = enabledBundles.filter(
      (b) => b.id.localeCompare(minBundleId) >= 0,
    );

    const sortedCandidates = candidateBundles
      .slice()
      .sort((a, b) => b.id.localeCompare(a.id));

    const makeResponse = (
      bundle: Bundle,
      status: UpdateStatus,
    ): UpdateInfo => ({
      id: bundle.id,
      message: bundle.message,
      shouldForceUpdate:
        status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
      status,
    });

    if (candidateBundles.length === 0) {
      if (enabledBundles.length === 0) {
        return bundleId === NIL_UUID ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
      }

      if (bundleId.localeCompare(minBundleId) <= 0) {
        return null;
      }

      return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    if (bundleId === NIL_UUID) {
      if (sortedCandidates.length > 0) {
        return makeResponse(sortedCandidates[0], "UPDATE");
      }
      return null;
    }

    const currentBundleInCandidates = sortedCandidates.find(
      (b) => b.id === bundleId,
    );

    if (currentBundleInCandidates) {
      if (sortedCandidates[0].id !== currentBundleInCandidates.id) {
        return makeResponse(sortedCandidates[0], "UPDATE");
      }
      return null;
    }

    if (currentBundleExists && !currentBundleEnabled) {
      if (sortedCandidates.length > 0) {
        return makeResponse(sortedCandidates[0], "ROLLBACK");
      }
      return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    const higherBundles = sortedCandidates.filter(
      (b) => b.id.localeCompare(bundleId) > 0,
    );
    const lowerBundles = sortedCandidates.filter(
      (b) => b.id.localeCompare(bundleId) < 0,
    );

    if (higherBundles.length > 0) {
      return makeResponse(higherBundles[0], "UPDATE");
    }

    if (lowerBundles.length > 0) {
      const highestLowerBundle = lowerBundles.sort((a, b) =>
        b.id.localeCompare(a.id),
      )[0];
      return makeResponse(highestLowerBundle, "ROLLBACK");
    }

    if (bundleId.localeCompare(minBundleId) === 0) {
      return null;
    }

    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};
