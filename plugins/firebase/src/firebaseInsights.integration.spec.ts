import type {
  BundleEventRow,
  InsightsEventPageInput,
} from "@hot-updater/plugin-core";
import { createInsightsEventPageCursor } from "@hot-updater/plugin-core/internal";
import { Query } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";
import {
  firebaseEventScopeKey,
  toFirebaseEventDocument,
} from "./firebaseEventIndex";
import { createFirebaseInsightsQueries } from "./firebaseInsights";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Firebase integration tests require the Firestore emulator.");
}

const {
  firestore,
  bundleEventsCollection,
  settingsCollection,
  clearCollections,
} = createFirestoreMock("firebase-insights-pages");
const ready = vi.fn(async () => undefined);
const queries = createFirebaseInsightsQueries(
  bundleEventsCollection,
  ready,
  ready,
);
const bundleId = createBundleEventRowFixture("1", 1).to_bundle_id;
const installId = "large-installation";
const movement = (index: number): BundleEventRow => ({
  ...createBundleEventRowFixture(String(200_000 + index), 60_000),
  type: index % 2 === 0 ? "UPDATE_APPLIED" : "RECOVERED",
  install_id: installId,
  from_bundle_id: bundleId,
  to_bundle_id: bundleId,
  update_strategy: "appVersion",
});

describe("Firestore indexed Insights queries", () => {
  beforeAll(async () => {
    await clearCollections();
    await settingsCollection
      .doc("database_adapter_version")
      .set({ version: 4 });
    // Commit fixture chunks without holding a promise or event for the whole history.
    for (let start = 0; start < 50_104; start += 400) {
      const batch = firestore.batch();
      for (let index = start; index < Math.min(start + 400, 50_104); index++) {
        const row: BundleEventRow =
          index < 50_001
            ? {
                ...createBundleEventRowFixture(String(index + 100_000), index),
                type: "UNCHANGED",
                install_id: installId,
                to_bundle_id: bundleId,
                from_bundle_id: null,
                update_strategy: null,
              }
            : movement(index - 50_001);
        batch.create(
          bundleEventsCollection.doc(row.id),
          toFirebaseEventDocument(row),
        );
      }
      await batch.commit();
    }
  }, 180_000);

  afterAll(async () => {
    await firestore.recursiveDelete(bundleEventsCollection);
    await clearCollections();
  }, 180_000);

  it("keeps a window lower bound inclusive without reading older events on continuation", async () => {
    const input = {
      scope: { kind: "all" },
      sinceReceivedAtMs: 60_000,
      beforeReceivedAtMs: 60_001,
      limit: 100,
    } as const;
    const reads = vi.spyOn(Query.prototype, "get");
    try {
      const first = await queries.pageEvents(input);
      const last = await queries.pageEvents({
        ...input,
        cursor: first.nextCursor!,
      });
      expect(first.rows).toHaveLength(100);
      expect(last.rows.map(({ id }) => id)).toEqual([
        movement(2).id,
        movement(1).id,
        movement(0).id,
      ]);
      expect(last.nextCursor).toBeNull();
      expect(
        (await Promise.all(reads.mock.results.map(({ value }) => value))).map(
          ({ size }) => size,
        ),
      ).toEqual([101, 3]);
      reads.mockClear();
      await expect(
        queries.pageEvents({
          ...input,
          sinceReceivedAtMs: 59_999,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });

  it("uses bounded global pages without losing equal-time events or lookahead", async () => {
    const reads = vi.spyOn(Query.prototype, "get");
    try {
      const input = {
        scope: { kind: "all" },
        beforeReceivedAtMs: 60_001,
        limit: 100,
      } as const;
      const first = await queries.pageEvents(input);
      const newer = createBundleEventRowFixture(
        "300000",
        input.beforeReceivedAtMs,
      );
      await bundleEventsCollection
        .doc(newer.id)
        .create(toFirebaseEventDocument(newer));
      const second = await queries.pageEvents({
        ...input,
        limit: 4,
        cursor: first.nextCursor!,
      });
      expect(first.rows).toHaveLength(100);
      expect(second.rows.map(({ id }) => id)).toEqual([
        movement(2).id,
        movement(1).id,
        movement(0).id,
        createBundleEventRowFixture("150000", 50_000).id,
      ]);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(
        (await Promise.all(reads.mock.results.map(({ value }) => value))).map(
          ({ size }) => size,
        ),
      ).toEqual([101, 5]);
    } finally {
      reads.mockRestore();
    }
  });

  it.each([
    { kind: "installation", installId },
    { kind: "bundle", bundleId },
  ] as const)(
    "paginates $kind movement without reading 50,001 activity rows",
    async (scope) => {
      const reads = vi.spyOn(Query.prototype, "get");
      const ids: string[] = [];
      let cursor: string | undefined;
      try {
        do {
          const before = reads.mock.results.length;
          const page = await queries.pageEvents({
            scope,
            beforeReceivedAtMs: 60_001,
            limit: 17,
            cursor,
          });
          ids.push(...page.rows.map(({ id }) => id));
          expect(reads.mock.results.length - before).toBe(2);
          const sizes = await Promise.all(
            reads.mock.results
              .slice(before)
              .map(async ({ value }) => (await value).size),
          );
          expect(sizes.every((size) => size <= 18)).toBe(true);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(ids).toEqual(
          Array.from({ length: 103 }, (_, index) => movement(102 - index).id),
        );
      } finally {
        reads.mockRestore();
      }
    },
  );

  it("wires the existing scan through one bounded native query", async () => {
    const plugin = firebaseDatabase({ projectId: "firebase-insights-pages" });
    const reads = vi.spyOn(Query.prototype, "get");
    try {
      const rows = await plugin.models.insights.scan({
        beforeReceivedAtMs: 60_001,
        limit: 3,
        after: { receivedAtMs: 60_000, id: movement(0).id },
      });
      expect(rows.map(({ id }) => id)).toEqual([
        movement(1).id,
        movement(2).id,
        movement(3).id,
      ]);
      expect(reads).toHaveBeenCalledTimes(1);
      expect((await reads.mock.results[0]!.value).size).toBe(3);
    } finally {
      reads.mockRestore();
    }
  });

  it("distinguishes movement direction, installation, cutoff and activity on one-row pages", async () => {
    // These identities share over 1,500 UTF-8 bytes. Firestore truncates raw
    // indexed strings at that boundary; exact-value hash keys avoid that loss.
    const installId = `${"界".repeat(600)}A`;
    const otherInstallId = `${"界".repeat(600)}B`;
    const target = createBundleEventRowFixture("410000", 1).id;
    const other = createBundleEventRowFixture("410001", 1).id;
    const rows: BundleEventRow[] = [
      { type: "UPDATE_APPLIED", from_bundle_id: other, to_bundle_id: target },
      { type: "RECOVERED", from_bundle_id: target, to_bundle_id: other },
      { type: "UPDATE_APPLIED", from_bundle_id: target, to_bundle_id: other },
      { type: "RECOVERED", from_bundle_id: other, to_bundle_id: target },
      {
        type: "UNCHANGED",
        from_bundle_id: null,
        to_bundle_id: target,
        update_strategy: null,
      },
      { type: "RELEASE_ADOPTED", from_bundle_id: other, to_bundle_id: target },
      {
        type: "UPDATE_APPLIED",
        from_bundle_id: other,
        to_bundle_id: target,
        install_id: otherInstallId,
      },
      {
        type: "RECOVERED",
        from_bundle_id: target,
        to_bundle_id: other,
        install_id: otherInstallId,
      },
      {
        type: "UPDATE_APPLIED",
        from_bundle_id: other,
        to_bundle_id: target,
        received_at_ms: 70_001,
      },
    ].map(
      (values, index) =>
        ({
          ...createBundleEventRowFixture(String(400_000 + index), 70_000),
          install_id: installId,
          update_strategy: "appVersion",
          ...values,
        }) as BundleEventRow,
    );
    const batch = firestore.batch();
    for (const row of rows)
      batch.create(
        bundleEventsCollection.doc(row.id),
        toFirebaseEventDocument(row),
      );
    await batch.commit();
    const reads = vi.spyOn(Query.prototype, "get");
    try {
      for (const { scope, expected } of [
        {
          scope: { kind: "installation", installId } as const,
          expected: [3, 2, 1, 0],
        },
        {
          scope: { kind: "bundle", bundleId: target } as const,
          expected: [7, 6, 1, 0],
        },
      ]) {
        let cursor: string | undefined;
        const ids: string[] = [];
        do {
          const page = await queries.pageEvents({
            scope,
            beforeReceivedAtMs: 70_001,
            limit: 1,
            cursor,
          });
          ids.push(...page.rows.map(({ id }) => id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(ids).toEqual(expected.map((index) => rows[index]!.id));
      }
      expect(reads).toHaveBeenCalledTimes(16);
      expect(
        (await Promise.all(reads.mock.results.map(({ value }) => value))).every(
          ({ size }) => size <= 2,
        ),
      ).toBe(true);
    } finally {
      reads.mockRestore();
      const cleanup = firestore.batch();
      for (const row of rows)
        cleanup.delete(bundleEventsCollection.doc(row.id));
      await cleanup.commit();
    }
  });

  it("fails on an indexed hash mismatch instead of filtering it into a misleading page", async () => {
    const row = {
      ...movement(500),
      install_id: "actual-installation",
      received_at_ms: 80_000,
    };
    await bundleEventsCollection.doc(row.id).create({
      ...toFirebaseEventDocument(row),
      _insights_install_key: firebaseEventScopeKey("requested-installation"),
    });
    try {
      await expect(
        queries.pageEvents({
          scope: { kind: "installation", installId: "requested-installation" },
          beforeReceivedAtMs: 80_001,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "invalid-result" });
    } finally {
      await bundleEventsCollection.doc(row.id).delete();
    }
  });

  it("rejects noncanonical stored IDs so Firestore and JavaScript cannot disagree on tie order", async () => {
    const row = { ...movement(501), id: "\u{10000}", received_at_ms: 80_000 };
    await bundleEventsCollection.doc(row.id).create(row);
    try {
      await expect(
        queries.pageEvents({
          scope: { kind: "all" },
          beforeReceivedAtMs: 80_001,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "invalid-result" });
    } finally {
      await bundleEventsCollection.doc(row.id).delete();
    }
  });

  it("waits for the explicit backfill readiness gate without querying events", async () => {
    const notReady = vi.fn(async () => {
      throw new Error("backfill pending");
    });
    const gated = createFirebaseInsightsQueries(
      bundleEventsCollection,
      ready,
      notReady,
    );
    const reads = vi.spyOn(Query.prototype, "get");
    try {
      await expect(
        gated.pageEvents({
          scope: { kind: "all" },
          beforeReceivedAtMs: 60_001,
          limit: 1,
        }),
      ).rejects.toThrow("backfill pending");
      expect(notReady).toHaveBeenCalledOnce();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });

  it("rejects invalid cursors before readiness or database reads and never retries missing indexes", async () => {
    ready.mockClear();
    const reads = vi.spyOn(Query.prototype, "get");
    const input: InsightsEventPageInput = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 60_001,
      limit: 10,
      cursor: "not-json",
    };
    try {
      await expect(queries.pageEvents(input)).rejects.toMatchObject({
        code: "invalid-query",
      });
      await expect(
        queries.pageEvents({
          ...input,
          cursor: createInsightsEventPageCursor(input, {
            receivedAtMs: 60_000,
            id: "\uE000",
          }),
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      await expect(
        queries.pageEvents({
          ...input,
          cursor: undefined,
          scope: { kind: "installation", installId: "unpaired-\uD800" },
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(ready).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      reads.mockRejectedValueOnce(
        Object.assign(new Error("The query requires an index"), { code: 9 }),
      );
      await expect(
        queries.pageEvents({ ...input, cursor: undefined }),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });
});
