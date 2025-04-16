import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { execa } from "execa";
import admin from "firebase-admin";
import fkill from "fkill";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firebaseDatabase } from "./firebaseDatabase";

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "firebaseDatabase",
  });
}

const firestore = admin.firestore();
firestore.settings({
  host: "localhost:8081",
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

describe("firebaseDatabase plugin", () => {
  let plugin: DatabasePlugin;

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
    plugin = firebaseDatabase({
      projectId: "hot-updater-test",
      storageBucket: "hot-updater-test.appspot.com",
    })({ cwd: "" });
  }, 30000);

  afterAll(async () => {
    if (emulatorProcess?.pid) {
      await fkill(":8081");
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

  it("should return null for a non-existent bundle id", async () => {
    const bundle = await plugin.getBundleById("nonexistent");
    expect(bundle).toBeNull();
  });

  it("should retrieve a bundle by id after inserting into Firestore", async () => {
    const snakeBundle = {
      id: "bundle123",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "abc123",
      gitCommitHash: "commit123",
      message: "test bundle",
      platform: "ios",
      targetAppVersion: "1.0.0",
    } as const;
    await plugin.appendBundle(snakeBundle);
    await plugin.commitBundle();

    const bundle = await plugin.getBundleById("bundle123");
    expect(bundle).toEqual({
      id: "bundle123",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "abc123",
      gitCommitHash: "commit123",
      message: "test bundle",
      platform: "ios",
      targetAppVersion: "1.0.0",
    });
  });

  it("should get bundles with filtering, ordering and pagination", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android",
      targetAppVersion: "2.0.0",
    } as const;

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios",
      targetAppVersion: "1.0.0",
    } as const;

    const bundle3 = {
      id: "bundle3",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android",
      targetAppVersion: "1.5.0",
    } as const;

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const bundles = await plugin.getBundles({
      where: { channel: "production" },
    });
    expect(bundles).toHaveLength(2);
    expect(bundles[0].id).toBe("bundle2");
    expect(bundles[1].id).toBe("bundle1");
  });

  it("should get distinct channels", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android",
      targetAppVersion: "2.0.0",
    } as const;
    const bundle2 = {
      id: "bundle2",
      channel: "staging",
      enabled: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios",
      targetAppVersion: "1.0.0",
      shouldForceUpdate: false,
    } as const;
    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.commitBundle();

    const channels = await plugin.getChannels();
    expect(channels.sort()).toEqual(["production", "staging"].sort());
  });

  it("should commit bundle changes and remove unused target_app_versions", async () => {
    await plugin.appendBundle({
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "ios",
      targetAppVersion: "1.0.0",
    });

    await plugin.commitBundle();

    const bundleDoc = await bundlesCollection.doc("bundle1").get();
    expect(bundleDoc.exists).toBeTruthy();
    const bundleData = bundleDoc.data();
    expect(bundleData?.target_app_version).toBe("1.0.0");

    const versionDocId = "ios_production_1.0.0";
    const targetDoc = await firestore
      .collection("target_app_versions")
      .doc(versionDocId)
      .get();
    expect(targetDoc.exists).toBeTruthy();
    expect(targetDoc.data()?.channel).toBe("production");

    await plugin.updateBundle("bundle1", {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle updated",
      platform: "ios",
      targetAppVersion: "1.0.x",
    });

    await plugin.commitBundle();
    const updatedBundleDoc = await bundlesCollection.doc("bundle1").get();
    expect(updatedBundleDoc.exists).toBeTruthy();
    const updatedData = updatedBundleDoc.data();
    expect(updatedData?.target_app_version).toBe("1.0.x");

    const oldVersionDocId = "ios_production_1.0.0";
    const oldTargetDoc = await firestore
      .collection("target_app_versions")
      .doc(oldVersionDocId)
      .get();
    expect(oldTargetDoc.exists).toBeFalsy();

    const newVersionDocId = "ios_production_1.0.x";
    const newTargetDoc = await firestore
      .collection("target_app_versions")
      .doc(newVersionDocId)
      .get();
    expect(newTargetDoc.exists).toBeTruthy();
    expect(newTargetDoc.data()?.channel).toBe("production");
  });

  it("should retrieve all bundles without filtering in descending order", async () => {
    const bundleA = {
      id: "bundleA",
      channel: "test",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hashA",
      gitCommitHash: "commitA",
      message: "Bundle A",
      platform: "ios",
      targetAppVersion: "1.0.0",
    } as const;
    const bundleB = {
      id: "bundleB",
      channel: "test",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashB",
      gitCommitHash: "commitB",
      message: "Bundle B",
      platform: "ios",
      targetAppVersion: "1.0.0",
    } as const;
    const bundleC = {
      id: "bundleC",
      channel: "test",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hashC",
      gitCommitHash: "commitC",
      message: "Bundle C",
      platform: "ios",
      targetAppVersion: "1.0.0",
    } as const;

    await plugin.appendBundle(bundleA);
    await plugin.appendBundle(bundleB);
    await plugin.appendBundle(bundleC);
    await plugin.commitBundle();

    const bundles = await plugin.getBundles();
    expect(bundles).toHaveLength(3);
    expect(bundles[0].id).toBe("bundleC");
    expect(bundles[1].id).toBe("bundleB");
    expect(bundles[2].id).toBe("bundleA");
  });

  it("should paginate bundles correctly", async () => {
    const bundlesData = [
      {
        id: "bundleA",
        channel: "test",
        enabled: true,
        shouldForceUpdate: true,
        fileHash: "hashA",
        gitCommitHash: "commitA",
        message: "A",
        platform: "ios",
        targetAppVersion: "1.0.0",
      },
      {
        id: "bundleB",
        channel: "test",
        enabled: true,
        shouldForceUpdate: true,
        fileHash: "hashB",
        gitCommitHash: "commitB",
        message: "B",
        platform: "ios",
        targetAppVersion: "1.0.0",
      },
      {
        id: "bundleC",
        channel: "test",
        enabled: true,
        shouldForceUpdate: true,
        fileHash: "hashC",
        gitCommitHash: "commitC",
        message: "C",
        platform: "ios",
        targetAppVersion: "1.0.0",
      },
      {
        id: "bundleD",
        channel: "test",
        enabled: true,
        shouldForceUpdate: true,
        fileHash: "hashD",
        gitCommitHash: "commitD",
        message: "D",
        platform: "ios",
        targetAppVersion: "1.0.0",
      },
      {
        id: "bundleE",
        channel: "test",
        enabled: true,
        shouldForceUpdate: true,
        fileHash: "hashE",
        gitCommitHash: "commitE",
        message: "E",
        platform: "ios",
        targetAppVersion: "1.0.0",
      },
    ] as const;

    for (const b of bundlesData) {
      await plugin.appendBundle(b);
    }
    await plugin.commitBundle();
    const paginatedBundles = await plugin.getBundles({
      where: { channel: "test" },
      limit: 2,
      offset: 1,
    });
    expect(paginatedBundles).toHaveLength(2);
    expect(paginatedBundles[0].id).toBe("bundleD");
    expect(paginatedBundles[1].id).toBe("bundleC");
  });

  it("should filter bundles by both channel and platform", async () => {
    const bundlesData = [
      {
        id: "bundleX",
        channel: "production",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "hashX",
        gitCommitHash: "commitX",
        message: "Bundle X",
        platform: "ios",
        targetAppVersion: "1.1.1",
      },
      {
        id: "bundleY",
        channel: "production",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "hashY",
        gitCommitHash: "commitY",
        message: "Bundle Y",
        platform: "android",
        targetAppVersion: "1.1.1",
      },
      {
        id: "bundleZ",
        channel: "staging",
        enabled: true,
        shouldForceUpdate: false,
        fileHash: "hashZ",
        gitCommitHash: "commitZ",
        message: "Bundle Z",
        platform: "ios",
        targetAppVersion: "1.1.1",
      },
    ] as const;

    for (const bundle of bundlesData) {
      await plugin.appendBundle(bundle);
    }
    await plugin.commitBundle();

    const filteredBundles = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
    });
    expect(filteredBundles).toHaveLength(1);
    expect(filteredBundles[0].id).toBe("bundleX");
  });

  it("should not modify data when commitBundle is called with no pending changes", async () => {
    await plugin.commitBundle();
    const snapshot = await bundlesCollection.get();
    expect(snapshot.empty).toBe(true);
  });

  it("should handle bundles without targetAppVersion by deleting the field", async () => {
    await plugin.appendBundle({
      id: "bundleNoVersion",
      channel: "staging",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hashNoVer",
      gitCommitHash: "commitNoVer",
      message: "Bundle with no target version",
      platform: "ios",
      targetAppVersion: "",
    });
    await plugin.commitBundle();

    const bundleDoc = await bundlesCollection.doc("bundleNoVersion").get();
    expect(bundleDoc.exists).toBeTruthy();
    const data = bundleDoc.data();
    expect(data).not.toHaveProperty("target_app_version");
  });

  it("should fetch the latest bundle data from Firestore via getBundleById", async () => {
    const bundleDirect = {
      id: "bundleDirect",
      channel: "direct",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "directHash",
      gitCommitHash: "directCommit",
      message: "Directly inserted bundle",
      platform: "ios",
      targetAppVersion: "2.0.0",
    } as const;
    await plugin.appendBundle(bundleDirect);
    await plugin.commitBundle();

    const fetched1 = await plugin.getBundleById("bundleDirect");
    expect(fetched1).toBeTruthy();
    expect(fetched1?.id).toBe("bundleDirect");

    await bundlesCollection
      .doc(bundleDirect.id)
      .update({ channel: "updatedDirect" });
    const fetched2 = await plugin.getBundleById("bundleDirect");
    expect(fetched2?.channel).toBe("updatedDirect");
  });

  it("should create a target_app_versions doc on bundle insertion", async () => {
    await plugin.appendBundle({
      id: "bundleTV1",
      channel: "release",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV1",
      gitCommitHash: "commitTV1",
      message: "Test bundle TV1",
      platform: "android",
      targetAppVersion: "4.0.0",
    });
    await plugin.commitBundle();

    const tvDoc = await firestore
      .collection("target_app_versions")
      .doc("android_release_4.0.0")
      .get();
    expect(tvDoc.exists).toBeTruthy();
    const data = tvDoc.data();
    expect(data?.platform).toBe("android");
    expect(data?.target_app_version).toBe("4.0.0");
    expect(data?.channel).toBe("release");
  });

  it("should maintain target_app_versions doc if multiple bundles reference the same version", async () => {
    await plugin.appendBundle({
      id: "bundleTV2",
      channel: "release",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV2",
      gitCommitHash: "commitTV2",
      message: "Test bundle TV2",
      platform: "ios",
      targetAppVersion: "5.0.0",
    });
    await plugin.appendBundle({
      id: "bundleTV3",
      channel: "release",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV3",
      gitCommitHash: "commitTV3",
      message: "Test bundle TV3",
      platform: "ios",
      targetAppVersion: "5.0.0",
    });
    await plugin.commitBundle();

    const tvDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_release_5.0.0")
      .get();
    expect(tvDoc.exists).toBeTruthy();
    expect(tvDoc.data()?.channel).toBe("release");

    await plugin.updateBundle("bundleTV2", {
      id: "bundleTV2",
      channel: "release",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV2",
      gitCommitHash: "commitTV2",
      message: "Test bundle TV2 updated",
      platform: "ios",
      targetAppVersion: "5.1.0",
    });
    await plugin.commitBundle();

    const tvDocOld = await firestore
      .collection("target_app_versions")
      .doc("ios_release_5.0.0")
      .get();
    expect(tvDocOld.exists).toBeTruthy();
    expect(tvDocOld.data()?.channel).toBe("release");

    const tvDocNew = await firestore
      .collection("target_app_versions")
      .doc("ios_release_5.1.0")
      .get();
    expect(tvDocNew.exists).toBeTruthy();
    expect(tvDocNew.data()?.channel).toBe("release");

    await plugin.updateBundle("bundleTV3", {
      id: "bundleTV3",
      channel: "beta",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV3",
      gitCommitHash: "commitTV3",
      message: "Test bundle TV3 updated",
      platform: "ios",
      targetAppVersion: "5.2.0",
    });
    await plugin.commitBundle();

    const tvDocOldAfter = await firestore
      .collection("target_app_versions")
      .doc("ios_release_5.0.0")
      .get();
    expect(tvDocOldAfter.exists).toBeFalsy();
    const tvDocInt = await firestore
      .collection("target_app_versions")
      .doc("ios_release_5.1.0")
      .get();
    expect(tvDocInt.exists).toBeTruthy();
    expect(tvDocInt.data()?.channel).toBe("release");

    const tvDocLatest = await firestore
      .collection("target_app_versions")
      .doc("ios_beta_5.2.0")
      .get();
    expect(tvDocLatest.exists).toBeTruthy();
    expect(tvDocLatest.data()?.channel).toBe("beta");
  });

  it("should delete target_app_versions doc when no bundles reference them", async () => {
    await plugin.appendBundle({
      id: "bundleTV4",
      channel: "beta",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV4",
      gitCommitHash: "commitTV4",
      message: "Test bundle TV4",
      platform: "android",
      targetAppVersion: "2.0.0",
    });
    await plugin.commitBundle();
    const tvDoc = await firestore
      .collection("target_app_versions")
      .doc("android_beta_2.0.0")
      .get();
    expect(tvDoc.exists).toBeTruthy();
    expect(tvDoc.data()?.channel).toBe("beta");

    await plugin.updateBundle("bundleTV4", {
      id: "bundleTV4",
      channel: "beta",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashTV4",
      gitCommitHash: "commitTV4",
      message: "Test bundle TV4 removed version",
      platform: "android",
      targetAppVersion: "",
    });
    await plugin.commitBundle();

    const tvDocAfter = await firestore
      .collection("target_app_versions")
      .doc("android_beta_2.0.0")
      .get();
    expect(tvDocAfter.exists).toBeFalsy();
  });
});
