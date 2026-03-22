import type {
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import { DEFAULT_ROLLOUT_COHORT_COUNT } from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  id: NIL_UUID,
  shouldForceUpdate: true,
  message: null,
  status: "ROLLBACK",
  storageUri: null,
  fileHash: null,
};

const convertToBundle = (data: any): Bundle => ({
  id: data.id,
  enabled: Boolean(data.enabled),
  shouldForceUpdate: Boolean(data.should_force_update),
  message: data.message || null,
  targetAppVersion: data.target_app_version,
  platform: data.platform,
  channel: data.channel || "production",
  fileHash: data.file_hash,
  gitCommitHash: data.git_commit_hash,
  fingerprintHash: data.fingerprint_hash,
  storageUri: data.storage_uri,
  rolloutCohortCount: data.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  targetCohorts: data.target_cohorts || null,
});

export const getUpdateInfo = async (
  db: Firestore,
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy(db, args);
    case "fingerprint":
      return fingerprintStrategy(db, args);
    default:
      return null;
  }
};

const fingerprintStrategy = async (
  db: Firestore,
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    if (bundleId.localeCompare(minBundleId) < 0) {
      return null;
    }

    const snapshot = await db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .where("enabled", "==", true)
      .where("id", ">=", minBundleId)
      .where("fingerprint_hash", "==", fingerprintHash)
      .get();

    const bundles = snapshot.docs.map((doc) => convertToBundle(doc.data()));

    return getUpdateInfoJS(bundles, {
      platform,
      fingerprintHash,
      bundleId,
      minBundleId,
      channel,
      cohort,
      _updateStrategy: "fingerprint",
    });
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};

const appVersionStrategy = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    if (bundleId.localeCompare(minBundleId) < 0) {
      return null;
    }

    const appVersionsSnapshot = await db
      .collection("target_app_versions")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .select("target_app_version")
      .get();

    const appVersions = Array.from(
      new Set(
        appVersionsSnapshot.docs.map(
          (doc) => doc.data().target_app_version as string,
        ),
      ),
    );

    const targetAppVersionList = filterCompatibleAppVersions(
      appVersions,
      appVersion,
    );

    if (targetAppVersionList.length === 0) {
      return bundleId === minBundleId ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    const snapshot = await db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .where("enabled", "==", true)
      .where("id", ">=", minBundleId)
      .where("target_app_version", "in", targetAppVersionList)
      .get();

    const bundles = snapshot.docs.map((doc) => convertToBundle(doc.data()));

    return getUpdateInfoJS(bundles, {
      platform,
      appVersion,
      bundleId,
      minBundleId,
      channel,
      cohort,
      _updateStrategy: "appVersion",
    });
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};
