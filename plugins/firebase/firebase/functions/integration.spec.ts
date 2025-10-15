import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoIntegrationTestSuite } from "@hot-updater/core/test-utils";
import * as admin from "firebase-admin";
import { beforeAll, beforeEach, describe } from "vitest";

const PROJECT_ID = "get-update-info-integration-test";
const FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
const FUNCTIONS_EMULATOR_HOST = "127.0.0.1:5001";

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: PROJECT_ID,
  });
}

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;

const firestore = admin.firestore();
const bundlesCollection = firestore.collection("bundles");
const targetAppVersionsCollection = firestore.collection("target_app_versions");

async function clearCollections() {
  const collections = [bundlesCollection, targetAppVersionsCollection];
  for (const coll of collections) {
    const snapshot = await coll.get();
    const batch = firestore.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
}

describe("Firebase Functions Integration Tests", () => {
  beforeAll(async () => {
    await clearCollections();
  });

  beforeEach(async () => {
    await clearCollections();
  });

  setupGetUpdateInfoIntegrationTestSuite({
    setupBundles: async (bundles: Bundle[]) => {
      if (bundles.length === 0) return;

      const writeBatch = firestore.batch();

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
          storage_uri: bundle.storageUri || null,
          fingerprint_hash: bundle.fingerprintHash || null,
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
    },

    cleanup: async () => {
      await clearCollections();
    },

    fetchUpdateInfo: async (args: GetBundlesArgs): Promise<UpdateInfo | null> => {
      const headers: Record<string, string> = {
        "x-bundle-id": args.bundleId,
        "x-app-platform": args.platform,
      };

      if (args._updateStrategy === "appVersion") {
        headers["x-app-version"] = args.appVersion;
      } else {
        headers["x-fingerprint-hash"] = args.fingerprintHash;
      }

      if (args.minBundleId && args.minBundleId !== NIL_UUID) {
        headers["x-min-bundle-id"] = args.minBundleId;
      }

      if (args.channel) {
        headers["x-channel"] = args.channel;
      }

      const response = await fetch(
        `http://${FUNCTIONS_EMULATOR_HOST}/${PROJECT_ID}/us-central1/hot-updater/api/check-update`,
        {
          headers,
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data || !data.id) {
        return null;
      }

      return {
        id: data.id,
        shouldForceUpdate: data.shouldForceUpdate,
        status: data.status,
        message: data.message,
        storageUri: data.fileUrl || null,
      };
    },
  });
});
