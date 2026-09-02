import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import {
  createDatabasePlugin,
  createDatabasePluginAdapter,
} from "./createDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import { bundleToRow } from "./databaseRows";
import type { BundleRow, BundleRowUpdate, InsightsModel } from "./types";

const unusedInsights = {
  append: async () => {},
  pageEvents: async () => {
    throw new Error("not implemented");
  },
  pageInstallations: async () => {
    throw new Error("not implemented");
  },
  getReport: async () => {
    throw new Error("not implemented");
  },
  pageReport: async () => {
    throw new Error("not implemented");
  },
} satisfies InsightsModel;

const createBundle = (): Bundle => ({
  id: "bundle-1",
  platform: "ios",
  fileHash: "hash-1",
  gitCommitHash: null,
  storageUri: "storage://bundle-1",
  archiveByteSize: 3_000_000_001,
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
  const name = "update-race";
  const plugin = createDatabasePlugin({
    name,
    ...createDatabasePluginAdapter(name, {
      insights: unusedInsights,
      create: async (input) => {
        if (input.model === "bundle_patches") patchCreateCount += 1;
        return input.data;
      },
      update: async (input) => {
        if (input.model !== "bundles") return null;
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
      insertChannel: async (input) => ({
        row: input.row,
        inserted: true,
      }),
      deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
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
    const fixture = createFixture(2);

    await Promise.all([
      fixture.client.updateBundleById("bundle-1", { fileHash: "new-hash" }),
      fixture.client.updateBundleById("bundle-1", { gitCommitHash: "new" }),
    ]);

    expect(fixture.getRow()).toMatchObject({
      file_hash: "new-hash",
      git_commit_hash: "new",
    });
  });

  it("forwards explicit null without touching omitted scalars or patches", async () => {
    const fixture = createFixture(1);

    await fixture.client.updateBundleById("bundle-1", { gitCommitHash: null });

    expect(fixture.updateInputs).toEqual([{ git_commit_hash: null }]);
    expect(fixture.getRow().file_hash).toBe("hash-1");
    expect(fixture.getPatchDeleteCount()).toBe(0);
    expect(fixture.getPatchCreateCount()).toBe(0);
  });
});
