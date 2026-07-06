import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import {
  getDatabaseBundlePatchId,
  splitDatabaseBundle,
  toBundleReadModel,
  toDatabaseBundlePatches,
  toDatabaseBundleRecord,
} from "./databaseBundle";

const bundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: ["device-1"],
  patches: [
    {
      baseBundleId: "base-2",
      baseFileHash: "base-hash-2",
      patchFileHash: "patch-hash-2",
      patchStorageUri: "s3://bucket/patch-2.zip",
    },
    {
      baseBundleId: "base-1",
      baseFileHash: "base-hash-1",
      patchFileHash: "patch-hash-1",
      patchStorageUri: "s3://bucket/patch-1.zip",
    },
  ],
  patchBaseBundleId: "legacy-base",
  patchBaseFileHash: "legacy-base-hash",
  patchFileHash: "legacy-patch-hash",
  patchStorageUri: "s3://bucket/legacy.patch",
};

describe("database bundle helpers", () => {
  it("splits full bundle read models into bundle records and patch records", () => {
    const { bundle: record, patches } = splitDatabaseBundle(bundle);

    expect(record).toStrictEqual({
      id: bundle.id,
      channel: bundle.channel,
      platform: bundle.platform,
      enabled: bundle.enabled,
      shouldForceUpdate: bundle.shouldForceUpdate,
      fileHash: bundle.fileHash,
      storageUri: bundle.storageUri,
      gitCommitHash: bundle.gitCommitHash,
      message: bundle.message,
      targetAppVersion: bundle.targetAppVersion,
      fingerprintHash: bundle.fingerprintHash,
      rolloutCohortCount: bundle.rolloutCohortCount,
      targetCohorts: bundle.targetCohorts,
    });
    expect(patches).toStrictEqual([
      {
        id: getDatabaseBundlePatchId(bundle.id, "base-2"),
        bundleId: bundle.id,
        baseBundleId: "base-2",
        baseFileHash: "base-hash-2",
        patchFileHash: "patch-hash-2",
        patchStorageUri: "s3://bucket/patch-2.zip",
        orderIndex: 0,
      },
      {
        id: getDatabaseBundlePatchId(bundle.id, "base-1"),
        bundleId: bundle.id,
        baseBundleId: "base-1",
        baseFileHash: "base-hash-1",
        patchFileHash: "patch-hash-1",
        patchStorageUri: "s3://bucket/patch-1.zip",
        orderIndex: 1,
      },
    ]);
  });

  it("rebuilds full bundle read models with ordered patch descriptors", () => {
    const record = toDatabaseBundleRecord(bundle);
    const patches = toDatabaseBundlePatches(bundle).slice().reverse();

    expect(toBundleReadModel(record, patches)).toStrictEqual({
      ...record,
      patches: bundle.patches,
      patchBaseBundleId: "base-2",
      patchBaseFileHash: "base-hash-2",
      patchFileHash: "patch-hash-2",
      patchStorageUri: "s3://bucket/patch-2.zip",
    });
  });
});
