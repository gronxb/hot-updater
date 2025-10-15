import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";

const PROJECT_ID = "firebase-database-test";

const { firestore, bundlesCollection, channelsCollection, clearCollections } =
  createFirestoreMock(PROJECT_ID);

describe("firebaseDatabase plugin", () => {
  let plugin: DatabasePlugin;

  beforeAll(() => {
    plugin = firebaseDatabase({
      projectId: PROJECT_ID,
      storageBucket: `${PROJECT_ID}.appspot.com`,
    })({ cwd: "" });
  });

  beforeEach(async () => {
    await clearCollections();
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const bundles = await plugin.getBundles({
      where: { channel: "production" },
      limit: 20,
      offset: 0,
    });
    expect(bundles.data).toHaveLength(2);
    expect(bundles.data[0].id).toBe("bundle2");
    expect(bundles.data[1].id).toBe("bundle1");
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    await plugin.appendBundle(bundleA);
    await plugin.appendBundle(bundleB);
    await plugin.appendBundle(bundleC);
    await plugin.commitBundle();

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });
    expect(bundles.data).toHaveLength(3);
    expect(bundles.data[0].id).toBe("bundleC");
    expect(bundles.data[1].id).toBe("bundleB");
    expect(bundles.data[2].id).toBe("bundleA");
  });
  it("should return correct pagination info for single page", async () => {
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const result = await plugin.getBundles({
      where: { channel: "production" },
      limit: 20,
      offset: 0,
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("bundle2");
    expect(result.data[1].id).toBe("bundle1");

    expect(result.pagination).toEqual({
      total: 2,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });
  });

  it("should return correct pagination info for multiple pages", async () => {
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle3 = {
      id: "bundle3",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android",
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const firstPage = await plugin.getBundles({
      where: { channel: "production" },
      limit: 2,
      offset: 0,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
    });

    const secondPage = await plugin.getBundles({
      where: { channel: "production" },
      limit: 2,
      offset: 2,
    });

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
    });
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
        storageUri: "gs://test-bucket/test-key",
        fingerprintHash: null,
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
        storageUri: "gs://test-bucket/test-key",
        fingerprintHash: null,
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
        storageUri: "gs://test-bucket/test-key",
        fingerprintHash: null,
        },
    ] as const;

    for (const bundle of bundlesData) {
      await plugin.appendBundle(bundle);
    }
    await plugin.commitBundle();

    const filteredBundles = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 20,
      offset: 0,
    });
    expect(filteredBundles.data).toHaveLength(1);
    expect(filteredBundles.data[0].id).toBe("bundleX");
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
      targetAppVersion: null,
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    });
    await plugin.commitBundle();

    const bundleDoc = await bundlesCollection.doc("bundleNoVersion").get();
    expect(bundleDoc.exists).toBeTruthy();
    const data = bundleDoc.data();
    expect(data?.target_app_version).toBeNull();
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
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
      targetAppVersion: "2.0.1",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    });
    await plugin.commitBundle();

    const tvDocAfter = await firestore
      .collection("target_app_versions")
      .doc("android_beta_2.0.0")
      .get();
    expect(tvDocAfter.exists).toBeFalsy();
  });

  it("should add channel to channels collection when bundle is added and remove old channel when updated", async () => {
    // Add initial bundle
    await plugin.appendBundle({
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "Test bundle 1",
      platform: "ios",
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    });
    await plugin.commitBundle();

    // Verify channel was added
    const channelDoc = await channelsCollection.doc("production").get();
    expect(channelDoc.exists).toBeTruthy();
    expect(channelDoc.data()?.name).toBe("production");

    // Update bundle with new channel
    await plugin.updateBundle("bundle1", {
      id: "bundle1",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "Test bundle 1 updated",
      platform: "ios",
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    });
    await plugin.commitBundle();

    // Verify old channel was removed and new channel was added
    const oldChannelDoc = await channelsCollection.doc("production").get();
    expect(oldChannelDoc.exists).toBeFalsy();

    const newChannelDoc = await channelsCollection.doc("staging").get();
    expect(newChannelDoc.exists).toBeTruthy();
    expect(newChannelDoc.data()?.name).toBe("staging");
  });

  const bundlesData = [
    {
      id: "bundleX",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashX",
      gitCommitHash: "commitX",
      message: "Bundle X",
      platform: "ios" as const,
      targetAppVersion: "1.1.1",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    },
    {
      id: "bundleY",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashY",
      gitCommitHash: "commitY",
      message: "Bundle Y",
      platform: "android" as const,
      targetAppVersion: "1.1.1",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    },
    {
      id: "bundleZ",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hashZ",
      gitCommitHash: "commitZ",
      message: "Bundle Z",
      platform: "ios" as const,
      targetAppVersion: "1.1.1",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
      metadata: {},
    },
  ];
  it("should delete a single bundle successfully", async () => {
    // Setup: Create bundleX
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify bundle exists
    const bundleBefore = await plugin.getBundleById("bundleX");
    expect(bundleBefore).toBeTruthy();
    expect(bundleBefore?.message).toBe("Bundle X");

    // Delete bundle
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify bundle is deleted
    const bundleAfter = await plugin.getBundleById("bundleX");
    expect(bundleAfter).toBeNull();
  });

  it("should delete orphaned channels when last bundle in channel is deleted", async () => {
    // Setup: Create only bundleZ (staging channel)
    await plugin.appendBundle(bundlesData[2]);
    await plugin.commitBundle();

    // Verify staging channel exists
    const channelsBefore = await plugin.getChannels();
    expect(channelsBefore).toContain("staging");

    // Delete the only bundle in staging channel
    await plugin.deleteBundle(bundlesData[2]);
    await plugin.commitBundle();

    // Verify staging channel is deleted
    const channelsAfter = await plugin.getChannels();
    expect(channelsAfter).not.toContain("staging");
  });

  it("should not delete channels when other bundles still use them", async () => {
    // Setup: Create bundleX and bundleY (both in production channel)
    await plugin.appendBundle(bundlesData[0]);
    await plugin.appendBundle(bundlesData[1]);
    await plugin.commitBundle();

    // Verify production channel exists
    const channelsBefore = await plugin.getChannels();
    expect(channelsBefore).toContain("production");

    // Delete bundleX
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify production channel still exists (used by bundleY)
    const channelsAfter = await plugin.getChannels();
    expect(channelsAfter).toContain("production");

    // Verify bundleY still exists
    const remainingBundle = await plugin.getBundleById("bundleY");
    expect(remainingBundle).toBeTruthy();
    expect(remainingBundle?.message).toBe("Bundle Y");
  });

  it("should delete orphaned target app versions when no bundles use them", async () => {
    // Setup: Create bundleX (ios production 1.1.1)
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify target app version document exists
    const targetVersionDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    expect(targetVersionDoc.exists).toBe(true);

    // Delete bundle
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify target app version document is deleted
    const targetVersionDocAfter = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    expect(targetVersionDocAfter.exists).toBe(false);
  });

  it("should not delete target app versions when other bundles still use them", async () => {
    // Setup: Create bundleX and bundleZ (both ios 1.1.1 but different channels)
    await plugin.appendBundle(bundlesData[0]); // ios production 1.1.1
    await plugin.appendBundle(bundlesData[2]); // ios staging 1.1.1
    await plugin.commitBundle();

    // Verify both target app version documents exist
    const prodTargetDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    const stagingTargetDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_staging_1.1.1")
      .get();
    expect(prodTargetDoc.exists).toBe(true);
    expect(stagingTargetDoc.exists).toBe(true);

    // Delete bundleX (production)
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify production target version is deleted
    const prodTargetDocAfter = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    expect(prodTargetDocAfter.exists).toBe(false);

    // Verify staging target version still exists
    const stagingTargetDocAfter = await firestore
      .collection("target_app_versions")
      .doc("ios_staging_1.1.1")
      .get();
    expect(stagingTargetDocAfter.exists).toBe(true);
  });

  it("should handle bundles with null fingerprintHash", async () => {
    // Setup: All test bundles have null fingerprintHash
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Delete bundle should work without errors
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify bundle is deleted
    const bundle = await plugin.getBundleById("bundleX");
    expect(bundle).toBeNull();
  });

  it("should update local cache after deletion", async () => {
    // Setup: Create all bundles
    for (const bundle of bundlesData) {
      await plugin.appendBundle(bundle);
    }
    await plugin.commitBundle();

    // Get bundles to populate cache
    const bundlesBefore = await plugin.getBundles({ limit: 10, offset: 0 });
    expect(bundlesBefore.data).toHaveLength(3);

    // Delete bundleY
    await plugin.deleteBundle(bundlesData[1]);
    await plugin.commitBundle();

    // Verify cache is updated
    const bundlesAfter = await plugin.getBundles({ limit: 10, offset: 0 });
    expect(bundlesAfter.data).toHaveLength(2);

    const remainingIds = bundlesAfter.data.map((b) => b.id);
    expect(remainingIds).toContain("bundleX");
    expect(remainingIds).toContain("bundleZ");
    expect(remainingIds).not.toContain("bundleY");
  });

  it("should work with updateBundle workflow", async () => {
    // Setup: Create bundleX
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Update bundle message and target version
    await plugin.updateBundle("bundleX", {
      message: "Updated Bundle X",
      targetAppVersion: "1.2.0",
    });
    await plugin.commitBundle();

    // Verify update worked
    const updatedBundle = await plugin.getBundleById("bundleX");
    expect(updatedBundle?.message).toBe("Updated Bundle X");
    expect(updatedBundle?.targetAppVersion).toBe("1.2.0");

    // Delete updated bundle
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify bundle is deleted
    const deletedBundle = await plugin.getBundleById("bundleX");
    expect(deletedBundle).toBeNull();

    // Verify new target version document is also deleted
    const targetVersionDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.2.0")
      .get();
    expect(targetVersionDoc.exists).toBe(false);
  });

  it("should handle platform-specific deletions correctly", async () => {
    // Setup: Create bundleX (ios) and bundleY (android), both production 1.1.1
    await plugin.appendBundle(bundlesData[0]); // ios production
    await plugin.appendBundle(bundlesData[1]); // android production
    await plugin.commitBundle();

    // Verify both platform target versions exist
    const iosTargetDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    const androidTargetDoc = await firestore
      .collection("target_app_versions")
      .doc("android_production_1.1.1")
      .get();
    expect(iosTargetDoc.exists).toBe(true);
    expect(androidTargetDoc.exists).toBe(true);

    // Delete iOS bundle
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Verify iOS target version is deleted
    const iosTargetDocAfter = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    expect(iosTargetDocAfter.exists).toBe(false);

    // Verify Android target version still exists
    const androidTargetDocAfter = await firestore
      .collection("target_app_versions")
      .doc("android_production_1.1.1")
      .get();
    expect(androidTargetDocAfter.exists).toBe(true);

    // Verify production channel still exists (android bundle remains)
    const channels = await plugin.getChannels();
    expect(channels).toContain("production");
  });

  it("should handle complex scenario with all test bundles", async () => {
    // Setup: Create all bundles
    for (const bundle of bundlesData) {
      await plugin.appendBundle(bundle);
    }
    await plugin.commitBundle();

    // Verify initial state
    const bundlesBefore = await plugin.getBundles({ limit: 10, offset: 0 });
    expect(bundlesBefore.data).toHaveLength(3);

    const channelsBefore = await plugin.getChannels();
    expect(channelsBefore).toContain("production");
    expect(channelsBefore).toContain("staging");

    // Verify all target app versions exist
    const targetVersions = [
      "ios_production_1.1.1",
      "android_production_1.1.1",
      "ios_staging_1.1.1",
    ];

    for (const versionId of targetVersions) {
      const doc = await firestore
        .collection("target_app_versions")
        .doc(versionId)
        .get();
      expect(doc.exists).toBe(true);
    }

    // Delete bundleY (android production)
    await plugin.deleteBundle(bundlesData[1]);
    await plugin.commitBundle();

    // Verify selective deletion
    const bundlesAfter = await plugin.getBundles({ limit: 10, offset: 0 });
    expect(bundlesAfter.data).toHaveLength(2);

    // Verify channels still exist (other bundles use them)
    const channelsAfter = await plugin.getChannels();
    expect(channelsAfter).toContain("production"); // bundleX still there
    expect(channelsAfter).toContain("staging"); // bundleZ still there

    // Verify only android production target version is deleted
    const androidTargetDoc = await firestore
      .collection("target_app_versions")
      .doc("android_production_1.1.1")
      .get();
    expect(androidTargetDoc.exists).toBe(false);

    // Verify other target versions still exist
    const iosProductionDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_production_1.1.1")
      .get();
    const iosStagingDoc = await firestore
      .collection("target_app_versions")
      .doc("ios_staging_1.1.1")
      .get();
    expect(iosProductionDoc.exists).toBe(true);
    expect(iosStagingDoc.exists).toBe(true);
  });

  it("should handle deletion of all bundles and cleanup all resources", async () => {
    // Setup: Create all bundles
    for (const bundle of bundlesData) {
      await plugin.appendBundle(bundle);
    }
    await plugin.commitBundle();

    // Delete all bundles one by one
    for (const bundle of bundlesData) {
      await plugin.deleteBundle(bundle);
    }
    await plugin.commitBundle();

    // Verify all bundles are deleted
    const finalBundles = await plugin.getBundles({ limit: 10, offset: 0 });
    expect(finalBundles.data).toHaveLength(0);

    // Verify all channels are deleted
    const finalChannels = await plugin.getChannels();
    expect(finalChannels).toHaveLength(0);

    // Verify all target app versions are deleted
    const targetVersionsSnapshot = await firestore
      .collection("target_app_versions")
      .get();
    expect(targetVersionsSnapshot.empty).toBe(true);
  });
});
