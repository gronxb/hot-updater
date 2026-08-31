import { createHash } from "node:crypto";

import { Query, Transaction } from "firebase-admin/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { createFirebaseDatabaseCollections } from "./firebaseDatabasePersistence";
import {
  FIREBASE_EVENT_INDEX_STATE,
  toFirebaseEventDocument,
} from "./firebaseEventIndex";
import { backfillFirebaseEventIndexStep } from "./firebaseEventIndexBackfill";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Firebase integration tests require the Firestore emulator.");
}

const { firestore, clearCollections } = createFirestoreMock(
  "firebase-event-index-backfill",
);
const collections = createFirebaseDatabaseCollections(firestore);
const checkpoint = collections.settings.doc(FIREBASE_EVENT_INDEX_STATE);
const step = (limit: number) =>
  backfillFirebaseEventIndexStep(
    firestore,
    createFirebaseDatabaseCollections(firestore),
    limit,
  );

describe("Firebase event index maintenance backfill", () => {
  beforeEach(clearCollections);
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearCollections();
  });

  it("resumes bounded pages against the saved upper ID while new writers append", async () => {
    const legacy = [10, 20, 30, 40, 50].map((suffix) =>
      createBundleEventRowFixture(String(suffix), suffix),
    );
    const batch = firestore.batch();
    for (const row of legacy) {
      batch.create(collections.bundleEvents.doc(row.id), row);
    }
    await batch.commit();
    const reads = vi.spyOn(Transaction.prototype, "get");

    expect(await step(2)).toEqual({ state: "building", processed: 0 });
    expect((await checkpoint.get()).data()).toEqual({
      version: 1,
      state: "building",
      revision: 1,
      upperId: legacy[4].id,
      afterId: null,
    });
    expect(await step(2)).toEqual({ state: "building", processed: 2 });
    expect((await checkpoint.get()).data()).toMatchObject({
      revision: 2,
      upperId: legacy[4].id,
      afterId: legacy[1].id,
    });

    // Old writers are drained before maintenance starts. New writers already
    // index inserts, including IDs behind the durable bookmark.
    const incoming = [5, 60, 70].map((suffix) =>
      createBundleEventRowFixture(String(suffix), 1_000 + suffix),
    );
    for (const row of incoming.slice(0, 2)) {
      await collections.bundleEvents
        .doc(row.id)
        .create(toFirebaseEventDocument(row));
    }
    expect(await step(2)).toEqual({ state: "building", processed: 2 });
    expect((await checkpoint.get()).data()).toMatchObject({
      revision: 3,
      upperId: legacy[4].id,
      afterId: legacy[3].id,
    });
    await collections.bundleEvents
      .doc(incoming[2].id)
      .create(toFirebaseEventDocument(incoming[2]));

    expect(await step(2)).toEqual({ state: "ready", processed: 1 });
    const completed = await checkpoint.get();
    expect(completed.data()).toEqual({
      version: 1,
      state: "ready",
      revision: 4,
      upperId: legacy[4].id,
      afterId: legacy[4].id,
    });
    expect(await step(2)).toEqual({ state: "ready", processed: 0 });
    expect((await checkpoint.get()).updateTime).toEqual(completed.updateTime);

    const querySizes = await Promise.all(
      reads.mock.calls.flatMap(([target], index) =>
        target instanceof Query
          ? [
              reads.mock.results[index].value.then(
                (result: { size: number }) => result.size,
              ),
            ]
          : [],
      ),
    );
    expect(querySizes).toEqual([1, 0, 2, 2, 1]);
    const stored = await collections.bundleEvents.get();
    expect(stored.size).toBe(legacy.length + incoming.length);
    for (const row of [...legacy, ...incoming]) {
      expect(
        stored.docs.find((document) => document.id === row.id)?.data(),
      ).toEqual(toFirebaseEventDocument(row));
    }
  });

  it("hashes exact Unicode and long scopes without changing raw fields or extensions", async () => {
    const scopes = ["é", "e\u0301", " scope ", "SCOPE", "🙂/한글".repeat(300)];
    expect(Buffer.byteLength(scopes[4], "utf8")).toBeGreaterThan(1_500);
    const legacy = scopes.map((scope, index) => ({
      ...createBundleEventRowFixture(String(101 + index), 1_000 + index),
      install_id: scope,
      to_bundle_id: `to:${scope}`,
      from_bundle_id: `from:${scope}`,
      user_id: "사용자",
      username: "Original Name",
      _insights_install_key: "outdated-derived-value",
      extension: { scope, values: [false, null, 7], nested: { keep: true } },
    }));
    const batch = firestore.batch();
    for (const row of legacy) {
      batch.create(collections.bundleEvents.doc(row.id), row);
    }
    await batch.commit();
    await step(5);
    expect(await step(5)).toEqual({ state: "ready", processed: 5 });

    const installKeys = new Set<string>();
    for (const row of legacy) {
      const stored = (await collections.bundleEvents.doc(row.id).get()).data();
      const digest = (value: string) =>
        createHash("sha256").update(value, "utf8").digest("hex");
      expect(stored).toEqual({
        ...row,
        _insights_install_key: digest(row.install_id),
        _insights_to_bundle_key: digest(row.to_bundle_id),
        _insights_from_bundle_key: digest(row.from_bundle_id),
      });
      expect(stored?._insights_install_key).toMatch(/^[0-9a-f]{64}$/);
      installKeys.add(stored?._insights_install_key);
    }
    expect(installKeys.size).toBe(scopes.length);
  });

  it.each([
    {
      name: "uppercase UUID",
      key: "00000000-0000-7000-8000-00000000003A",
      id: "00000000-0000-7000-8000-00000000003A",
      error: "invalid-data",
    },
    {
      name: "non-UUID",
      key: "00000000-not-a-canonical-uuid",
      id: "00000000-not-a-canonical-uuid",
      error: "invalid-data",
    },
    {
      name: "mismatched document key",
      key: "00000000-0000-7000-8000-000000000030",
      id: "00000000-0000-7000-8000-000000000040",
      error: "bundle_events.id.document-key",
    },
  ])(
    "rolls back the entire page and checkpoint for a $name",
    async ({ key, id, error }) => {
      const first = createBundleEventRowFixture("10", 10);
      const valid = createBundleEventRowFixture("20", 20);
      const invalid = { ...createBundleEventRowFixture("30", 30), id };
      const upper = {
        ...createBundleEventRowFixture("999", 999),
        id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      };
      const batch = firestore.batch();
      batch.create(collections.bundleEvents.doc(first.id), first);
      batch.create(collections.bundleEvents.doc(valid.id), valid);
      batch.create(collections.bundleEvents.doc(key), invalid);
      batch.create(collections.bundleEvents.doc(upper.id), upper);
      await batch.commit();
      await step(1);
      expect(await step(1)).toEqual({ state: "building", processed: 1 });
      const saved = await checkpoint.get();

      await expect(step(2)).rejects.toThrow(error);

      const after = await checkpoint.get();
      expect(after.data()).toEqual(saved.data());
      expect(after.updateTime).toEqual(saved.updateTime);
      expect(
        (await collections.bundleEvents.doc(valid.id).get()).data(),
      ).toEqual(valid);
      expect((await collections.bundleEvents.doc(key).get()).data()).toEqual(
        invalid,
      );
      expect(
        (await collections.bundleEvents.doc(first.id).get()).data(),
      ).toEqual(toFirebaseEventDocument(first));
    },
  );

  it("rolls back staged keys and the checkpoint when Firestore rejects a stale write precondition", async () => {
    const first = createBundleEventRowFixture("10", 10);
    const later = createBundleEventRowFixture("20", 20);
    const firstRef = collections.bundleEvents.doc(first.id);
    const laterRef = collections.bundleEvents.doc(later.id);
    await firstRef.create(first);
    await laterRef.create(later);
    await step(2);
    const saved = await checkpoint.get();
    const stale = await laterRef.get();
    await laterRef.update({ extension: "concurrent writer value" });
    const newer = await laterRef.get();
    expect(newer.updateTime).not.toEqual(stale.updateTime);

    // Deterministically inject the stale precondition from an earlier real
    // snapshot. The Firestore emulator still executes and rejects the commit;
    // this avoids depending on transaction lock scheduling to simulate a race.
    const original = Transaction.prototype.update;
    const updates = vi
      .spyOn(Transaction.prototype, "update")
      .mockImplementation(function (this: Transaction, reference, ...args) {
        return Reflect.apply(
          original,
          this,
          reference.path === laterRef.path
            ? [reference, args[0], { lastUpdateTime: stale.updateTime }]
            : [reference, ...args],
        );
      });
    await expect(step(2)).rejects.toMatchObject({ code: 9 });
    expect(updates).toHaveBeenCalledTimes(3);
    updates.mockRestore();

    expect((await firstRef.get()).data()).toEqual(first);
    expect((await laterRef.get()).data()).toEqual(newer.data());
    const after = await checkpoint.get();
    expect(after.data()).toEqual(saved.data());
    expect(after.updateTime).toEqual(saved.updateTime);
    expect(await step(2)).toEqual({ state: "ready", processed: 2 });
    expect((await laterRef.get()).get("extension")).toBe(
      "concurrent writer value",
    );
  });

  it("does not publish readiness for raw rows the native reader would reject", async () => {
    const valid = createBundleEventRowFixture("10", 10);
    const invalid = createBundleEventRowFixture("20", 1.5);
    await collections.bundleEvents.doc(valid.id).create(valid);
    await collections.bundleEvents.doc(invalid.id).create(invalid);
    const upper = createBundleEventRowFixture("30", 30);
    await collections.bundleEvents.doc(upper.id).create(upper);
    await step(2);
    const saved = await checkpoint.get();
    await expect(step(2)).rejects.toMatchObject({ code: "invalid-result" });
    expect((await checkpoint.get()).updateTime).toEqual(saved.updateTime);
    expect((await collections.bundleEvents.doc(valid.id).get()).data()).toEqual(
      valid,
    );
    expect(
      (await collections.bundleEvents.doc(invalid.id).get()).data(),
    ).toEqual(invalid);
  });

  it.each([false, true])(
    "rejects an unindexed tail before creating a checkpoint (has valid rows: %s)",
    async (hasValid) => {
      if (hasValid) {
        const valid = createBundleEventRowFixture("10", 10);
        await collections.bundleEvents.doc(valid.id).create(valid);
      }
      await collections.bundleEvents
        .doc("unindexed-tail")
        .create({ extension: "preserve" });
      await expect(step(2)).rejects.toMatchObject({ code: "invalid-data" });
      expect((await checkpoint.get()).exists).toBe(false);
      expect(
        (await collections.bundleEvents.doc("unindexed-tail").get()).data(),
      ).toEqual({ extension: "preserve" });
    },
  );

  it("finds a missing id field inside the captured key range before advancing", async () => {
    const upper = createBundleEventRowFixture("30", 30);
    await collections.bundleEvents.doc(upper.id).create(upper);
    await collections.bundleEvents
      .doc("00000000-0000-0000-0000-000000000000")
      .create({ extension: "preserve" });
    await step(2);
    const saved = await checkpoint.get();
    await expect(step(2)).rejects.toThrow();
    expect((await checkpoint.get()).updateTime).toEqual(saved.updateTime);
    expect((await collections.bundleEvents.doc(upper.id).get()).data()).toEqual(
      upper,
    );
  });

  it("marks an empty source ready without repeating the source query", async () => {
    const reads = vi.spyOn(Transaction.prototype, "get");
    expect(await step(1)).toEqual({ state: "ready", processed: 0 });
    const saved = await checkpoint.get();
    expect(saved.data()).toEqual({
      version: 1,
      state: "ready",
      revision: 1,
      upperId: null,
      afterId: null,
    });
    expect(await step(1)).toEqual({ state: "ready", processed: 0 });
    expect(
      reads.mock.calls.filter(([target]) => target instanceof Query),
    ).toHaveLength(2);
    expect((await checkpoint.get()).updateTime).toEqual(saved.updateTime);
  });
});
