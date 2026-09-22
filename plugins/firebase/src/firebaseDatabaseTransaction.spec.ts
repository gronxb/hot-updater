import type { BundleRow, ReleaseRow } from "@hot-updater/plugin-core";
import type { Transaction } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FirebaseDatabaseCollections } from "./firebaseDatabasePersistence";
import { createFirebaseTransaction } from "./firebaseDatabaseTransaction";

const { reads, persist } = vi.hoisted(() => ({
  reads: { findOne: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  persist: vi.fn(),
}));
vi.mock("./firebaseDatabaseReads", () => ({
  createFirebaseReads: () => reads,
}));
vi.mock("./firebaseDatabasePersistence", () => ({
  persistFirebaseDatabaseSnapshot: persist,
}));

const row: BundleRow = {
  id: "bundle",
  platform: "ios",
  git_commit_hash: null,
  metadata: {},
  manifest_storage_uri: "storage://bundle/manifest.json",
  manifest_file_hash: "hash",
  asset_base_storage_uri: "storage://assets",
};
const open = () =>
  createFirebaseTransaction(
    {} as Transaction,
    {} as FirebaseDatabaseCollections,
  );
const key = {
  model: "bundles" as const,
  where: [{ field: "id" as const, value: row.id }],
};

const release: ReleaseRow = {
  id: "release",
  revision: 1,
  scope_key: "scope",
  channel_id: "channel",
  platform: "ios",
  kind: "BUNDLE",
  bundle_id: row.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1,
  target_cohorts: ["0"],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 1,
  updated_at_ms: 1,
};

describe("Firebase transaction staging", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    reads.findOne.mockResolvedValue(null);
    reads.findMany.mockResolvedValue([]);
    reads.count.mockResolvedValue(0);
  });

  it("remembers missing keyed reads within one transaction", async () => {
    const { database } = open();
    await expect(database.findOne(key)).resolves.toBeNull();
    await expect(database.findOne(key)).resolves.toBeNull();
    expect(reads.findOne).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a deleted row when a later change reads or updates it", async () => {
    reads.findOne.mockResolvedValue(row);
    const { database } = open();
    await database.delete(key);
    await expect(database.findOne(key)).resolves.toBeNull();
    await expect(
      database.update({ ...key, update: { metadata: { changed: true } } }),
    ).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
    expect(reads.findOne).toHaveBeenCalledTimes(1);
  });

  it("reads its inserts and updates and stages all writes until persistence", async () => {
    const staged = open();
    await staged.database.create({ model: "bundles", data: row });
    await staged.database.update({
      ...key,
      update: { metadata: { changed: true } },
    });
    await expect(staged.database.findOne(key)).resolves.toMatchObject({
      metadata: { changed: true },
    });
    expect(persist).not.toHaveBeenCalled();
    staged.persist();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].after.bundles.get(row.id)).toMatchObject({
      metadata: { changed: true },
    });
  });

  it("keeps full rows when validation requests a projection before an update", async () => {
    reads.findOne.mockImplementation(async (input) =>
      input.select
        ? {
            id: release.id,
            strategy: release.strategy,
            target_app_version: release.target_app_version,
            fingerprint_hash: null,
          }
        : release,
    );
    const staged = open();
    const input = {
      model: "releases" as const,
      where: [{ field: "id" as const, value: release.id }],
    };
    await staged.database.findOne({
      ...input,
      select: ["strategy", "target_app_version", "fingerprint_hash"],
    });
    await expect(
      staged.database.update({ ...input, update: { revision: 2 } }),
    ).resolves.toEqual({ ...release, revision: 2 });
    staged.persist();
    expect(persist.mock.calls[0][0].after.releases.get(release.id)).toEqual({
      ...release,
      revision: 2,
    });
    expect(reads.findOne).toHaveBeenCalledTimes(1);
  });

  it("answers a reference check with one projected witness instead of aggregating history", async () => {
    reads.count.mockResolvedValue(10000);
    reads.findMany.mockResolvedValue([{ id: release.id }]);
    const { database } = open();
    expect(
      await database.findOne({
        model: "releases",
        select: ["id"],
        where: [{ field: "bundle_id", value: row.id }],
      }),
    ).not.toBeNull();
    expect(reads.count).not.toHaveBeenCalled();
    expect(reads.findMany).toHaveBeenCalledWith({
      model: "releases",
      where: [{ field: "bundle_id", value: row.id }],
      limit: 1,
      offset: 0,
      select: ["id"],
    });
  });

  it.each([false, true])(
    "accounts for staged release deletion when another witness exists: %s",
    async (hasOther) => {
      reads.findOne.mockResolvedValue(release);
      reads.findMany.mockResolvedValue([
        { id: release.id },
        ...(hasOther ? [{ id: "other" }] : []),
      ]);
      const staged = open();
      await staged.database.delete({
        model: "releases",
        where: [{ field: "id", value: release.id }],
      });
      const referenced = await staged.database.findOne({
        model: "releases",
        select: ["id"],
        where: [{ field: "channel_id", value: release.channel_id }],
      });
      expect(referenced !== null).toBe(hasOther);
      expect(reads.count).not.toHaveBeenCalled();
      expect(reads.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 2, select: ["id"] }),
      );
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("sees a staged release insert without querying stored history", async () => {
    reads.findOne.mockImplementation(async ({ model }) =>
      model === "channels"
        ? { id: release.channel_id, name: "production" }
        : model === "bundles"
          ? row
          : null,
    );
    const { database } = open();
    await database.create({ model: "releases", data: release });
    expect(
      await database.findOne({
        model: "releases",
        select: ["id"],
        where: [{ field: "bundle_id", value: row.id }],
      }),
    ).not.toBeNull();
    expect(reads.count).not.toHaveBeenCalled();
    expect(reads.findMany).not.toHaveBeenCalled();
  });

  it("deletes a channel selected by name using its stored ID", async () => {
    reads.findOne.mockResolvedValue({ id: "channel", name: "production" });
    const staged = open();
    await staged.database.delete({
      model: "channels",
      where: [{ field: "name", value: "production" }],
    });
    await expect(
      staged.database.findOne({
        model: "channels",
        where: [{ field: "id", value: "channel" }],
      }),
    ).resolves.toBeNull();
    staged.persist();
    expect(persist.mock.calls[0][0].after.channels.size).toBe(0);
  });

  it("does not ignore a channel ID collision when its name also has a canonical row", async () => {
    reads.findOne.mockImplementation(async ({ where }) =>
      where[0].field === "id"
        ? { id: "taken", name: "preview" }
        : { id: "canonical", name: "production" },
    );
    const { database } = open();
    await expect(
      database.create({
        model: "channels",
        data: { id: "taken", name: "production" },
        onConflict: "ignore",
      }),
    ).rejects.toThrow("channels.id.unique");
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["bundle_id", "channel_id"] as const)(
    "uses findOne for a bounded %s reference witness",
    async (field) => {
      reads.findMany.mockResolvedValue([{ id: release.id }]);
      const { database } = open();
      await expect(
        database.findOne({
          model: "releases",
          where: [
            field === "bundle_id"
              ? { field, value: row.id }
              : { field, value: release.channel_id },
          ],
          select: ["id"],
        }),
      ).resolves.toEqual({ id: release.id });
      expect(reads.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1, select: ["id"] }),
      );
      expect(reads.count).not.toHaveBeenCalled();
    },
  );

  it("filters staged tombstones from findOne witnesses without caching partial releases", async () => {
    reads.findOne.mockResolvedValue(release);
    reads.findMany.mockResolvedValue([{ id: release.id }, { id: "other" }]);
    const { database } = open();
    await database.delete({
      model: "releases",
      where: [{ field: "id", value: release.id }],
    });
    const reference = {
      model: "releases" as const,
      where: [{ field: "bundle_id" as const, value: row.id }],
      select: ["id" as const],
    };
    await expect(database.findOne(reference)).resolves.toEqual({ id: "other" });
    expect(reads.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2 }),
    );
    reads.findOne.mockResolvedValue({ ...release, id: "other" });
    await expect(
      database.findOne({
        model: "releases",
        where: [{ field: "id", value: "other" }],
      }),
    ).resolves.toEqual({ ...release, id: "other" });
    reads.findMany.mockResolvedValue([{ id: release.id }]);
    await database.delete({
      model: "releases",
      where: [{ field: "id", value: "other" }],
    });
    await expect(database.findOne(reference)).resolves.toBeNull();
  });
  it("returns an exact transactional count after a staged deletion", async () => {
    reads.count.mockResolvedValue(5);
    reads.findOne.mockResolvedValue(release);
    const { database } = open();
    await database.delete({
      model: "releases",
      where: [{ field: "id", value: release.id }],
    });
    await expect(
      database.count({
        model: "releases",
        where: [{ field: "bundle_id", value: row.id }],
      }),
    ).resolves.toBe(4);
    expect(reads.findMany).not.toHaveBeenCalled();
  });
});
