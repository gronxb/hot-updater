import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { execa } from "execa";
import admin from "firebase-admin";
import type { Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { getUpdateInfo as getUpdateInfoFromIndex } from "./getUpdateInfo";

// biome-ignore lint/suspicious/noImplicitAnyLet: <explanation>
let emulatorProcess;

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "hot-updater-test",
  });
}

const firestore = admin.firestore();

if (process.env.NODE_ENV !== "production") {
  firestore.settings({
    host: "localhost:8080",
    ssl: false,
  });
  console.log("Using Firestore emulator at localhost:8080");
}

const bundlesCollection = firestore.collection("bundles");

const addBundlesToFirestore = async (bundles: Bundle[]) => {
  const snapshot = await bundlesCollection.get();
  const deleteBatch = firestore.batch();
  // biome-ignore lint/complexity/noForEach: <explanation>
  snapshot.docs.forEach((doc) => {
    deleteBatch.delete(doc.ref);
  });
  await deleteBatch.commit();

  const batch = firestore.batch();

  for (const bundle of bundles) {
    const docRef = bundlesCollection.doc(bundle.id);
    batch.set(docRef, {
      id: bundle.id,
      file_hash: bundle.fileHash,
      platform: bundle.platform,
      target_app_version: bundle.targetAppVersion,
      should_force_update: bundle.shouldForceUpdate,
      enabled: bundle.enabled,
      git_commit_hash: bundle.gitCommitHash || null,
      message: bundle.message || null,
    });
  }

  await batch.commit();

  await new Promise((resolve) => setTimeout(resolve, 500));
};

const createGetUpdateInfo =
  (db: Firestore) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    await addBundlesToFirestore(bundles);

    try {
      const result = await getUpdateInfoFromIndex(db, {
        appVersion,
        bundleId,
        platform,
      });
      return result;
    } catch (error) {
      console.error("getUpdateInfo error:", error);
      throw error;
    }
  };

const getUpdateInfo = createGetUpdateInfo(firestore);

describe("getUpdateInfo", () => {
  const shouldManageEmulator = !process.env.EXTERNAL_EMULATOR;

  beforeAll(async () => {
    if (shouldManageEmulator) {
      console.log("Starting Firebase emulator...");

      try {
        emulatorProcess = execa(
          "pnpm",
          ["firebase", "emulators:start", "--only", "firestore"],
          {
            stdio: "inherit",
          },
        );

        await new Promise((resolve) => setTimeout(resolve, 5000));

        console.log("Firebase emulator started successfully");
      } catch (error) {
        console.error("Failed to start Firebase emulator:", error);
        console.log(
          "Please make sure Firebase CLI is installed and run manually:",
        );
        console.log("firebase emulators:start --only firestore");
        throw error;
      }
    } else {
      console.log("Using externally managed Firebase emulator");
    }
  });

  afterAll(async () => {
    if (shouldManageEmulator && emulatorProcess) {
      console.log("Stopping Firebase emulator...");
      emulatorProcess.kill();
    }
  });

  beforeEach(async () => {
    const snapshot = await bundlesCollection.get();
    const batch = firestore.batch();

    // biome-ignore lint/complexity/noForEach: <explanation>
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });
});
