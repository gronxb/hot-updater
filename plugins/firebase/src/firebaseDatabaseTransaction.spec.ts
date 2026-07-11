import type {
  DatabaseBundlePatch,
  DatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import type admin from "firebase-admin";
import { describe, expect, it } from "vitest";

import {
  beginFirebaseDatabaseTransaction,
  type FirebaseTransactionBundle,
  type FirebaseTransactionContext,
} from "./firebaseDatabaseTransaction";

type FakeTransactionWrite =
  | {
      readonly kind: "bundle.set";
      readonly bundleId: string;
      readonly bundle: FirebaseTransactionBundle;
    }
  | { readonly kind: "bundle.delete"; readonly bundleId: string }
  | { readonly kind: "channel.set"; readonly channel: string }
  | { readonly kind: "channel.delete"; readonly channel: string }
  | {
      readonly kind: "targetAppVersion.set";
      readonly docId: string;
      readonly bundle: DatabaseBundleRecord;
    }
  | { readonly kind: "targetAppVersion.delete"; readonly docId: string };

type FakeTransactionAttempt = {
  readonly context: FirebaseTransactionContext;
  readonly writes: readonly FakeTransactionWrite[];
};

const bundleRecord = (
  overrides: Partial<DatabaseBundleRecord> = {},
): DatabaseBundleRecord => ({
  id: "retry-bundle",
  channel: "old-channel",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "bundle-file-hash",
  gitCommitHash: "bundle-commit-hash",
  message: "first snapshot",
  platform: "ios",
  targetAppVersion: "1.0.0",
  storageUri: "gs://test-bucket/retry-bundle",
  fingerprintHash: null,
  ...overrides,
});

const patchRecord = (
  baseBundleId: string,
  orderIndex: number,
): DatabaseBundlePatch => ({
  id: `retry-bundle:${baseBundleId}`,
  bundleId: "retry-bundle",
  baseBundleId,
  baseFileHash: `${baseBundleId}-file-hash`,
  patchFileHash: `${baseBundleId}-patch-hash`,
  patchStorageUri: `gs://test-bucket/${baseBundleId}.patch`,
  orderIndex,
});

describe("beginFirebaseDatabaseTransaction", () => {
  it("reapplies bundle, patch, and index operations from a fresh snapshot when Firestore retries", async () => {
    // Given
    const decodedBundles = new WeakMap<object, FirebaseTransactionBundle>();
    const encodedBundles = new WeakMap<object, FirebaseTransactionBundle>();
    const toDocumentData = (
      bundle: FirebaseTransactionBundle,
    ): admin.firestore.DocumentData => {
      const data = {};
      decodedBundles.set(data, bundle);
      return data;
    };
    const createAttempt = (
      snapshotBundle: FirebaseTransactionBundle,
    ): FakeTransactionAttempt => {
      const writes: FakeTransactionWrite[] = [];
      return {
        writes,
        context: {
          readBundles: async () => [
            {
              id: snapshotBundle.record.id,
              data: toDocumentData(snapshotBundle),
            },
          ],
          setBundle: (bundleId, data) => {
            const bundle = encodedBundles.get(data);
            if (!bundle) {
              throw new Error("Encoded bundle fixture not found");
            }
            writes.push({ kind: "bundle.set", bundleId, bundle });
          },
          deleteBundle: (bundleId) => {
            writes.push({ kind: "bundle.delete", bundleId });
          },
          setChannel: (channel) => {
            writes.push({ kind: "channel.set", channel });
          },
          deleteChannel: (channel) => {
            writes.push({ kind: "channel.delete", channel });
          },
          setTargetAppVersion: (docId, bundle) => {
            writes.push({ kind: "targetAppVersion.set", docId, bundle });
          },
          deleteTargetAppVersion: (docId) => {
            writes.push({ kind: "targetAppVersion.delete", docId });
          },
        },
      };
    };
    const originalPatch = patchRecord("base-original", 0);
    const insertedPatch = patchRecord("base-inserted", 1);
    const concurrentPatch = patchRecord("base-concurrent", 2);
    const firstAttempt = createAttempt({
      record: bundleRecord(),
      patches: [originalPatch],
    });
    const retryRecord = bundleRecord({ message: "fresh retry snapshot" });
    const retryAttempt = createAttempt({
      record: retryRecord,
      patches: [originalPatch, concurrentPatch],
    });
    let callbackCount = 0;
    const transaction = await beginFirebaseDatabaseTransaction({
      runTransaction: async (callback) => {
        callbackCount += 1;
        await callback(firstAttempt.context);
        callbackCount += 1;
        await callback(retryAttempt.context);
      },
      decodeBundle: (data) => {
        const bundle = decodedBundles.get(data);
        if (!bundle) {
          throw new Error("Decoded bundle fixture not found");
        }
        return bundle;
      },
      encodeBundle: (bundle) => {
        const data = {};
        encodedBundles.set(data, bundle);
        return data;
      },
    });
    const connection = transaction.connection;
    if ("storage" in connection) {
      throw new Error("Expected a resource database transaction");
    }
    if (connection.patches.storage !== "rows") {
      throw new Error("Expected transaction patch rows");
    }
    await connection.bundles.update({
      bundleId: "retry-bundle",
      patch: {
        channel: "retry-channel",
        enabled: false,
        targetAppVersion: "2.0.0",
      },
    });
    await connection.patches.insertRow({
      row: {
        id: insertedPatch.id ?? "retry-bundle:base-inserted",
        bundle_id: insertedPatch.bundleId,
        base_bundle_id: insertedPatch.baseBundleId,
        base_file_hash: insertedPatch.baseFileHash,
        patch_file_hash: insertedPatch.patchFileHash,
        patch_storage_uri: insertedPatch.patchStorageUri,
        order_index: insertedPatch.orderIndex,
      },
    });

    // When
    await transaction.commit();

    // Then
    expect(callbackCount).toBe(2);
    expect(retryAttempt.writes).toEqual([
      {
        kind: "bundle.set",
        bundleId: "retry-bundle",
        bundle: {
          record: {
            ...retryRecord,
            channel: "retry-channel",
            enabled: false,
            targetAppVersion: "2.0.0",
          },
          patches: [originalPatch, insertedPatch, concurrentPatch],
        },
      },
      { kind: "channel.delete", channel: "old-channel" },
      { kind: "channel.set", channel: "retry-channel" },
      {
        kind: "targetAppVersion.delete",
        docId: "ios_old-channel_1.0.0",
      },
      {
        kind: "targetAppVersion.set",
        docId: "ios_retry-channel_2.0.0",
        bundle: {
          ...retryRecord,
          channel: "retry-channel",
          enabled: false,
          targetAppVersion: "2.0.0",
        },
      },
    ]);
  });
});
