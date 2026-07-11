import { describe, expect, it, vi } from "vitest";

import { createBundleEventResource } from "./databaseBundleEventResources";
import { buildBundlePatchRowResource } from "./databaseBundlePatchResources";
import type { BundlePatchRow } from "./databaseBundlePatchRows";
import { createBundleResource } from "./databaseBundleResources";
import type { DatabaseBundleEvent, DatabaseBundleRecord } from "./types";

const bundle = (id: string, channel: string): DatabaseBundleRecord => ({
  id,
  channel,
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: `hash-${id}`,
  storageUri: `s3://bucket/${id}.zip`,
  gitCommitHash: null,
  message: null,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
});

const patchRow = (bundleId: string): BundlePatchRow => ({
  id: `${bundleId}:base`,
  bundle_id: bundleId,
  base_bundle_id: "base",
  base_file_hash: "base-hash",
  patch_file_hash: `patch-${bundleId}`,
  patch_storage_uri: `s3://bucket/${bundleId}.patch`,
  order_index: 0,
});

const event = (id: string, installId: string): DatabaseBundleEvent => ({
  id,
  kind: "APP_READY",
  installId,
  activeBundleId: bundle("bundle", "production").id,
  platform: "ios",
  channel: "production",
  payload: {
    status: "STABLE",
    sdkVersion: "0.32.0",
    defaultChannel: "production",
    isChannelSwitched: false,
  },
});

describe("database resource read isolation", () => {
  it("does not leak a bundle list snapshot into a different count query", async () => {
    // Given
    const records = [bundle("bundle-production", "production")];
    const findRecords = vi.fn(async () => [...records]);
    const resource = createBundleResource({
      getById: async () => null,
      findRecords,
      insert: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    });
    await resource.findMany({
      where: { channel: "production" },
      window: { offset: 0, limit: 1 },
    });
    records.splice(0, records.length, bundle("bundle-staging", "staging"));

    // When
    const count = await resource.count({ where: { channel: "staging" } });

    // Then
    expect(count).toBe(1);
    expect(findRecords).toHaveBeenCalledTimes(2);
  });

  it("does not leak a patch list snapshot into a different count query", async () => {
    // Given
    const rows = [patchRow("bundle-1")];
    const findRows = vi.fn(async () => [...rows]);
    const resource = buildBundlePatchRowResource({
      findRows,
      getRowById: async () => null,
      insertRow: async () => undefined,
      updateRow: async () => undefined,
      deleteRow: async () => undefined,
    });
    await resource.findMany({
      where: { bundleId: "bundle-1" },
      window: { offset: 0, limit: 1 },
    });
    rows.splice(0, rows.length, patchRow("bundle-2"));

    // When
    const count = await resource.count({ where: { bundleId: "bundle-2" } });

    // Then
    expect(count).toBe(1);
    expect(findRows).toHaveBeenCalledTimes(2);
  });

  it("does not leak an event list snapshot into a different count query", async () => {
    // Given
    const events = [event("event-1", "install-1")];
    const findEvents = vi.fn(async () => [...events]);
    const resource = createBundleEventResource({
      findEvents,
      append: async () => undefined,
    });
    await resource.findMany({
      where: { installId: "install-1" },
      window: { offset: 0, limit: 1 },
    });
    events.splice(0, events.length, event("event-2", "install-2"));

    // When
    const count = await resource.count({ where: { installId: "install-2" } });

    // Then
    expect(count).toBe(1);
    expect(findEvents).toHaveBeenCalledTimes(2);
  });
});
