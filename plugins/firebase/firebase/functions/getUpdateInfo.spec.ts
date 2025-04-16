import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { execa } from "execa";
import * as admin from "firebase-admin";
import type { Firestore } from "firebase-admin/firestore";
import fkill from "fkill";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { getUpdateInfo as getUpdateInfoFromIndex } from "./getUpdateInfo";

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "hot-updater-test",
  });
}

const firestore = admin.firestore();
firestore.settings({
  host: "localhost:8080",
  ssl: false,
});

const bundlesCollection = firestore.collection("bundles");
const targetAppVersionsCollection = firestore.collection("target_app_versions");

let emulatorProcess: ReturnType<typeof execa>;

async function waitForEmulator(
  maxRetries = 10,
  retryDelay = 1000,
): Promise<boolean> {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      await firestore.listCollections();
      console.log(`Firebase emulator ready after ${retries + 1} attempt(s)`);
      return true;
    } catch (error) {
      console.log(
        `Waiting for emulator to start (attempt ${retries + 1}/${maxRetries})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retries++;
    }
  }
  return false;
}

async function isEmulatorReady() {
  try {
    await firestore.listCollections();
    return true;
  } catch (error) {
    return false;
  }
}
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

  beforeAll(async () => {
    console.log("Starting Firebase emulator...");
    const isReady = await isEmulatorReady();
    if (!isReady) {
      emulatorProcess = execa(
        "pnpm",
        ["firebase", "emulators:start", "--only", "firestore"],
        { cwd: __dirname, stdio: "inherit", detached: true },
      );

      const emulatorReady = await waitForEmulator();
      if (!emulatorReady) {
        throw new Error("Firebase emulator failed to start");
      }
    }

    console.log("Firebase emulator started successfully");
  }, 30000);

  afterAll(async () => {
    if (emulatorProcess?.pid) {
      await fkill(":8080");
    }
  });

  beforeEach(async () => {
    const collections = [bundlesCollection, targetAppVersionsCollection];
    for (const coll of collections) {
      const snapshot = await coll.get();
      const batch = firestore.batch();
      for (const doc of snapshot.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });
});
