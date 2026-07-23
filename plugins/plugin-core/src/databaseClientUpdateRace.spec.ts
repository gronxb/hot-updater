import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import { createDatabasePlugin } from "./createDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import { bundleToRow } from "./databaseRows";
import type { BundleRow, BundleRowUpdate } from "./types";

const createBundle = (): Bundle => ({
  id: "bundle-1",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash-1",
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: "storage://bundle-1",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

const createFixture = (expectedUpdates: number) => {
  let row = bundleToRow(createBundle());
  let updateCount = 0;
  let releaseUpdates = (): void => undefined;
  const updatesReady = new Promise<void>((resolve) => {
    releaseUpdates = resolve;
  });
  const updateInputs: BundleRowUpdate[] = [];
  let patchDeleteCount = 0;
  let patchCreateCount = 0;
  const plugin = createDatabasePlugin({
    name: "update-race",
    plugin: () => ({
      create: async (input) => {
        if (input.model === "bundle_patches") patchCreateCount += 1;
        return input.data;
      },
      update: async (input) => {
        updateInputs.push(input.update);
        updateCount += 1;
        if (updateCount === expectedUpdates) releaseUpdates();
        await updatesReady;
        row = { ...row, ...input.update };
        return row;
      },
      delete: async (input) => {
        if (input.model === "bundle_patches") patchDeleteCount += 1;
      },
      count: async () => 1,
      findOne: async (input) => (input.model === "bundles" ? { ...row } : null),
      findMany: async () => [],
    }),
  });

  return {
    client: createDatabaseClient(plugin),
    getRow: (): BundleRow => row,
    updateInputs,
    getPatchDeleteCount: () => patchDeleteCount,
    getPatchCreateCount: () => patchCreateCount,
  };
};

describe("database client partial updates", () => {
  it("preserves two disjoint scalar updates that reach the provider together", async () => {
    // Given
    const fixture = createFixture(2);

    // When
    await Promise.all([
      fixture.client.updateBundleById("bundle-1", { enabled: false }),
      fixture.client.updateBundleById("bundle-1", { message: "new" }),
    ]);

    // Then
    expect(fixture.getRow()).toMatchObject({
      enabled: false,
      message: "new",
    });
  });

  it("forwards explicit null without touching omitted scalars or patches", async () => {
    // Given
    const fixture = createFixture(1);

    // When
    await fixture.client.updateBundleById("bundle-1", { message: null });

    // Then
    expect(fixture.updateInputs).toEqual([{ message: null }]);
    expect(fixture.getRow().enabled).toBe(true);
    expect(fixture.getPatchDeleteCount()).toBe(0);
    expect(fixture.getPatchCreateCount()).toBe(0);
  });
});
