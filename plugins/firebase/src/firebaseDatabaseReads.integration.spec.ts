import { beforeEach, describe, expect, it } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { createFirebaseDatabaseCollections } from "./firebaseDatabasePersistence";
import { createFirebaseReads } from "./firebaseDatabaseReads";

const { firestore, bundlesCollection, clearCollections } = createFirestoreMock(
  "firebase-read-cursors-test",
);
const collections = createFirebaseDatabaseCollections(firestore);
const reads = createFirebaseReads(collections, async () => {});
const bundle = (i: number) => ({
  id: String(i).padStart(5, "0"),
  platform: "ios",
  git_commit_hash: null,
  metadata: { ignored: true },
  manifest_storage_uri: "storage://bundle/manifest.json",
  manifest_file_hash: "hash",
  asset_base_storage_uri: "storage://assets",
});

describe("Firebase native cursor and projection execution", () => {
  beforeEach(clearCollections);

  it("continues projected reads after the 1000-document page", async () => {
    for (let start = 0; start < 1010; start += 400) {
      const batch = firestore.batch();
      for (let i = start; i < Math.min(1010, start + 400); i++) {
        const row = bundle(i);
        batch.set(bundlesCollection.doc(row.id), row);
      }
      await batch.commit();
    }
    const result = await reads.findMany({
      model: "bundles",
      limit: 1001,
      offset: 7,
      select: ["id"],
      where: [{ field: "manifest_file_hash", operator: "gt", value: "a" }],
      orderBy: [{ field: "id", direction: "asc" }],
    });
    expect(result).toEqual(
      Array.from({ length: 1001 }, (_, i) => ({
        id: bundle(i + 7).id,
        manifest_file_hash: "hash",
      })),
    );
  });

  it.each(["asc", "desc"] as const)(
    "matches a native query when merging %s nullable ties across ID shards",
    async (direction) => {
      const rows = Array.from({ length: 61 }, (_, i) => bundle(i));
      const batch = firestore.batch();
      for (const row of rows) batch.set(bundlesCollection.doc(row.id), row);
      await batch.commit();
      const native = await bundlesCollection
        .orderBy("git_commit_hash", direction)
        .offset(28)
        .limit(5)
        .select("id", "git_commit_hash")
        .get();
      await expect(
        reads.findMany({
          model: "bundles",
          where: [
            {
              field: "id",
              operator: "in",
              value: rows.map(({ id }) => id).reverse(),
            },
          ],
          orderBy: [{ field: "git_commit_hash", direction }],
          offset: 28,
          limit: 5,
          select: ["id"],
        }),
      ).resolves.toEqual(native.docs.map((doc) => doc.data()));
    },
  );

  it("uses field masks for exact document reads inside and outside a transaction", async () => {
    const row = bundle(1);
    await bundlesCollection.doc(row.id).set(row);
    const input = {
      model: "bundles" as const,
      where: [{ field: "id" as const, value: row.id }],
      select: ["platform" as const],
    };
    await expect(reads.findOne(input)).resolves.toEqual({
      id: row.id,
      platform: "ios",
    });
    await expect(
      firestore.runTransaction((transaction) =>
        createFirebaseReads(collections, async () => {}, transaction).findOne(
          input,
        ),
      ),
    ).resolves.toEqual({ id: row.id, platform: "ios" });
  });
});
