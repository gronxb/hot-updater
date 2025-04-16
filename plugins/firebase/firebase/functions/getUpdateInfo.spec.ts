import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import type { Firestore } from "firebase-admin/firestore";
import { beforeEach, describe } from "vitest";
import { createFirestoreMock } from "../../test-utils/createFirestoreMock";
import { getUpdateInfo as getUpdateInfoFromIndex } from "./getUpdateInfo";

const PROJECT_ID = "get-update-info-test";

const {
  firestore,
  bundlesCollection,
  targetAppVersionsCollection,
  clearCollections,
} = createFirestoreMock(PROJECT_ID);

const createGetUpdateInfo =
  (db: Firestore) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform, minBundleId, channel }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    const collections = [bundlesCollection, targetAppVersionsCollection];
    for (const coll of collections) {
      const snapshot = await coll.get();
      const batch = firestore.batch();
      for (const doc of snapshot.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }

    if (bundles.length > 0) {
      const writeBatch = db.batch();

      for (const bundle of bundles) {
        const docRef = bundlesCollection.doc(bundle.id);
        writeBatch.set(docRef, {
          id: bundle.id,
          file_hash: bundle.fileHash,
          platform: bundle.platform,
          target_app_version: bundle.targetAppVersion || "",
          should_force_update: bundle.shouldForceUpdate,
          enabled: bundle.enabled,
          git_commit_hash: bundle.gitCommitHash || null,
          message: bundle.message || null,
          channel: bundle.channel || "production",
        });

        if (bundle.targetAppVersion) {
          const versionDocId = `${bundle.platform}_${bundle.channel}_${bundle.targetAppVersion}`;
          writeBatch.set(
            targetAppVersionsCollection.doc(versionDocId),
            {
              target_app_version: bundle.targetAppVersion,
              platform: bundle.platform,
              channel: bundle.channel,
            },
            { merge: true },
          );
        }
      }

      await writeBatch.commit();
    }

    return await getUpdateInfoFromIndex(db, {
      appVersion,
      bundleId,
      platform,
      minBundleId,
      channel,
    });
  };

describe("getUpdateInfo", () => {
  const getUpdateInfo = createGetUpdateInfo(firestore);

  beforeEach(async () => {
    await clearCollections();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });
});
