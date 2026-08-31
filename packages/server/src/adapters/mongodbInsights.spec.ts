import {
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  createInsightsEventPageCursor,
  databaseFields,
} from "@hot-updater/plugin-core/internal";
import type { Collection } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import {
  createMongoInsightsQueries,
  mongoInsightsEventIndexes,
} from "./mongodbInsights";

const input = {
  scope: { kind: "all" },
  sinceReceivedAtMs: 10,
  beforeReceivedAtMs: 100,
  limit: 2,
} as const;
const row = createBundleEventRowFixture("12", 50);
const harness = (rows: BundleEventRow[] = [row]) => {
  const indexes: Record<string, unknown>[] = mongoInsightsEventIndexes.map(
    (index) => ({ ...index }),
  );
  const read = vi.fn(async () => rows);
  const limit = vi.fn();
  const batchSize = vi.fn();
  const query = { limit, batchSize, toArray: read };
  limit.mockReturnValue(query);
  batchSize.mockReturnValue(query);
  const find = vi.fn(() => query);
  const listIndexes = vi.fn(async function* () {
    yield* indexes;
  });
  const ready = vi.fn(async () => undefined);
  const events = { find, listIndexes } as unknown as Collection<BundleEventRow>;
  return {
    queries: createMongoInsightsQueries(events, ready),
    indexes,
    read,
    find,
    limit,
    batchSize,
    listIndexes,
    ready,
  };
};

describe("MongoDB event page readiness and result validation", () => {
  it("does not touch indexes or events until the source audit is ready", async () => {
    const test = harness();
    test.ready.mockRejectedValueOnce(new InsightsQueryNotReadyError());
    await expect(test.queries.pageEvents(input)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(test.listIndexes).not.toHaveBeenCalled();
    expect(test.find).not.toHaveBeenCalled();
  });

  it.each([
    { key: { id: 1, received_at_ms: 1 } },
    { sparse: true },
    { hidden: true },
    { partialFilterExpression: { type: "UPDATE_APPLIED" } },
    { collation: { locale: "en", strength: 2 } },
  ])("rejects an unusable named event index: %j", async (override) => {
    const test = harness();
    Object.assign(test.indexes[1]!, override);
    await expect(test.queries.pageEvents(input)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(test.find).not.toHaveBeenCalled();
  });

  it("requires a complete unique ID index and rechecks readiness on later pages", async () => {
    const test = harness();
    expect((await test.queries.pageEvents(input)).rows).toEqual([row]);
    test.indexes[0]!.unique = false;
    test.find.mockClear();
    await expect(test.queries.pageEvents(input)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(test.find).not.toHaveBeenCalled();
  });

  it("bounds the query and explicitly overrides a collection's default collation", async () => {
    const test = harness();
    await test.queries.pageEvents(input);
    expect(test.find).toHaveBeenCalledWith(
      { received_at_ms: { $gte: 10, $lt: 100 } },
      {
        collation: { locale: "simple" },
        hint: "bundle_events_received_at_idx",
        projection: {
          ...Object.fromEntries(
            databaseFields.bundle_events.map((field) => [field, 1]),
          ),
          _id: 0,
        },
        sort: { received_at_ms: -1, id: -1 },
      },
    );
    expect(test.limit).toHaveBeenCalledWith(3);
    expect(test.batchSize).toHaveBeenCalledWith(3);
  });

  it.each([
    { ...row, id: "arbitrary-id" },
    { ...row, received_at_ms: 9 },
    { ...row, received_at_ms: 100 },
    { ...row, received_at_ms: 20.5 },
    { ...row, platform: "unknown" },
  ])(
    "rejects a malformed or out-of-window storage row: %j",
    async (invalid) => {
      const test = harness([invalid as BundleEventRow]);
      await expect(test.queries.pageEvents(input)).rejects.toMatchObject({
        code: "invalid-result",
      });
    },
  );

  it("rejects excess candidates instead of silently slicing a broken executor", async () => {
    const test = harness(Array.from({ length: 4 }, () => row));
    await expect(test.queries.pageEvents(input)).rejects.toMatchObject({
      code: "invalid-result",
    });
  });

  it("rejects changed windows, noncanonical IDs and ill-formed identities before I/O", async () => {
    const test = harness();
    const cursor = createInsightsEventPageCursor(input, {
      id: row.id,
      receivedAtMs: row.received_at_ms,
    });
    for (const invalid of [
      { ...input, sinceReceivedAtMs: 11, cursor },
      {
        ...input,
        cursor: createInsightsEventPageCursor(input, {
          id: "noncanonical",
          receivedAtMs: 50,
        }),
      },
      { ...input, scope: { kind: "installation", installId: "bad\ud800" } },
    ] as const) {
      await expect(test.queries.pageEvents(invalid)).rejects.toMatchObject({
        code: "invalid-query",
      });
    }
    expect(test.ready).not.toHaveBeenCalled();
    expect(test.find).not.toHaveBeenCalled();
  });

  it("reports dropped hints as not ready without retrying a collection scan", async () => {
    const test = harness();
    test.read.mockRejectedValueOnce({
      code: 2,
      message: "hint provided does not correspond to an existing index",
    });
    await expect(test.queries.pageEvents(input)).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(test.find).toHaveBeenCalledTimes(1);
  });

  it.each([13, 2, 50])(
    "preserves unrelated MongoDB errors (%i)",
    async (code) => {
      const test = harness();
      const error = Object.assign(new Error("Operation failed"), { code });
      test.read.mockRejectedValueOnce(error);
      await expect(test.queries.pageEvents(input)).rejects.toBe(error);
      expect(test.find).toHaveBeenCalledTimes(1);
    },
  );
});
