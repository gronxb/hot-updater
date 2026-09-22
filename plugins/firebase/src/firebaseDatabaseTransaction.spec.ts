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

const row = {
  id: "bundle",
  platform: "ios" as const,
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  archive_byte_size: 1,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
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
});
