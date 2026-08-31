import type {
  BundleEventRow,
  InsightsEventPageInput,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  createIndexedInsightsEventQueries,
  getInsightsEventPageCursorLimit,
} from "../../../plugin-core/src/insightsEventQueries";
import {
  createMockDatabaseData,
  createMockDatabaseState,
} from "../mockDatabaseState";

const event = (id: string, time: number): BundleEventRow => ({
  id,
  received_at_ms: time,
  type: "UNCHANGED",
  install_id: "install-a",
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: "bundle-a",
  from_release_id: null,
  to_release_id: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
});

const harness = (rows: readonly BundleEventRow[]) => {
  const data = createMockDatabaseData();
  for (const row of rows) data.bundleEvents.set(row.id, row);
  const state = createMockDatabaseState(data);
  const findMany = vi.spyOn(state, "findMany");
  const queries = createIndexedInsightsEventQueries(state, [
    "all",
    "bundle",
    "installation",
  ]);
  return { data, findMany, queries };
};

describe("indexed Insights event pages", () => {
  it("keeps both time boundaries fixed across lookahead and timestamp ties", async () => {
    const { queries, findMany } = harness([
      event("before", 19),
      event("low-a", 20),
      event("low-b", 20),
      event("middle", 21),
      event("cutoff", 22),
    ]);
    const input = {
      scope: { kind: "all" },
      sinceReceivedAtMs: 20,
      beforeReceivedAtMs: 22,
      limit: 1,
    } as const;
    const first = await queries.page(input);
    expect(first.rows.map(({ id }) => id)).toEqual(["middle"]);
    const last = await queries.page({
      ...input,
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(last.rows.map(({ id }) => id)).toEqual(["low-b", "low-a"]);
    expect(last.nextCursor).toBeNull();
    expect(
      findMany.mock.calls.every(([query]) =>
        query.where?.some(
          (filter) =>
            filter.field === "received_at_ms" &&
            filter.operator === "gte" &&
            filter.value === 20,
        ),
      ),
    ).toBe(true);
    findMany.mockClear();
    await expect(
      queries.page({
        ...input,
        sinceReceivedAtMs: 19,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(findMany).not.toHaveBeenCalled();
    expect(await queries.page({ ...input, sinceReceivedAtMs: 22 })).toEqual({
      rows: [],
      nextCursor: null,
    });
  });

  it("does not transfer old history or skip lookahead across timestamp ties", async () => {
    const { data, findMany, queries } = harness([
      ...Array.from({ length: 50_001 }, (_, index) =>
        event(`old-${index}`, index),
      ),
      ...Array.from({ length: 103 }, (_, index) =>
        event(`tie-${String(index).padStart(3, "0")}`, 60_000),
      ),
    ]);
    const input = {
      scope: { kind: "all" },
      limit: 100,
      beforeReceivedAtMs: 60_001,
    } as const;
    const first = await queries.page(input);
    expect(first.rows).toHaveLength(100);
    expect(first.rows[0]?.id).toBe("tie-102");
    const newEvent = event("new", 60_001);
    data.bundleEvents.set(newEvent.id, newEvent);
    const second = await queries.page({
      ...input,
      limit: 4,
      cursor: first.nextCursor!,
    });
    expect(second.rows.map((row) => row.id)).toEqual([
      "tie-002",
      "tie-001",
      "tie-000",
      "old-50000",
    ]);
    const returned = await Promise.all(
      findMany.mock.results.map((result) => result.value),
    );
    expect(returned.flat()).toHaveLength(106);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls.every(([query]) => query.offset === 0)).toBe(
      true,
    );
  });

  it("enumerates interleaved movement streams without losing candidates at page size one", async () => {
    const changes = Array.from(
      { length: 103 },
      (_, index): BundleEventRow => ({
        ...event(
          `change-${String(index).padStart(3, "0")}`,
          index === 0 ? 10 : 20,
        ),
        type: index % 2 === 0 ? "UPDATE_APPLIED" : "RECOVERED",
        from_bundle_id: "bundle-a",
        update_strategy: "appVersion",
      }),
    );
    const { findMany, queries } = harness([
      ...changes,
      event("activity", 21),
      {
        ...changes[0]!,
        id: "unrelated",
        type: "UPDATE_APPLIED",
        update_strategy: "appVersion",
        from_bundle_id: "bundle-b",
        to_bundle_id: "bundle-b",
      },
    ]);
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const start = findMany.mock.calls.length;
      const page = await queries.page({
        scope: { kind: "bundle", bundleId: "bundle-a" },
        beforeReceivedAtMs: 30,
        limit: 1,
        cursor,
      });
      ids.push(...page.rows.map((row) => row.id));
      const calls = findMany.mock.calls.slice(start);
      const results = await Promise.all(
        findMany.mock.results.slice(start).map((result) => result.value),
      );
      expect(calls.length).toBeLessThanOrEqual(4);
      expect(results.flat().length).toBeLessThanOrEqual(4);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(ids).toEqual(changes.toReversed().map((row) => row.id));
  });

  it("keeps installation history limited to that installation's movement events", async () => {
    const applied: BundleEventRow = {
      ...event("applied", 1),
      type: "UPDATE_APPLIED",
      from_bundle_id: "old",
      update_strategy: "appVersion",
    };
    const { queries } = harness([
      applied,
      event("active-only", 2),
      { ...applied, id: "other-install", install_id: "install-b" },
    ]);
    const result = await queries.page({
      scope: { kind: "installation", installId: "install-a" },
      beforeReceivedAtMs: 3,
      limit: 100,
    });
    expect(result.rows.map((row) => row.id)).toEqual(["applied"]);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects invalid, wrong-scope, and wrong-cutoff bookmarks before querying storage", async () => {
    const { findMany, queries } = harness([event("one", 1), event("two", 2)]);
    const input: InsightsEventPageInput = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 3,
      limit: 1,
    };
    const { nextCursor } = await queries.page(input);
    const invalid: readonly Partial<InsightsEventPageInput>[] = [
      { limit: 0 },
      { limit: 101 },
      { limit: Number.NaN },
      { beforeReceivedAtMs: Number.POSITIVE_INFINITY },
      { sinceReceivedAtMs: -1 },
      { sinceReceivedAtMs: Number.NaN },
      { sinceReceivedAtMs: 4 },
      { cursor: "not-json" },
      { cursor: "x".repeat(8_193) },
      { cursor: nextCursor!, scope: { kind: "bundle", bundleId: "bundle-a" } },
      { cursor: nextCursor!, beforeReceivedAtMs: 4 },
      { cursor: JSON.stringify([1, '["all"]', 3, 3, "outside"]) },
      { cursor: JSON.stringify([1, '["all"]', 3, 2, "one", "extra"]) },
    ];
    findMany.mockClear();
    for (const patch of invalid) {
      await expect(queries.page({ ...input, ...patch })).rejects.toMatchObject({
        code: "invalid-query",
      });
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(["", '\\"\0😀'.repeat(3000)])(
    "preserves exact installation identities across escaped bookmarks",
    async (installId) => {
      const { queries, findMany } = harness(
        [1, 2, 3].map((time) => ({
          ...event(`event-${time}`, time),
          install_id: installId,
          from_bundle_id: "previous-bundle",
          type: "UPDATE_APPLIED",
          update_strategy: "appVersion",
        })),
      );
      const input = {
        scope: { kind: "installation", installId },
        beforeReceivedAtMs: 4,
        limit: 1,
      } as const;
      const first = await queries.page(input);
      expect(first.rows[0]?.id).toBe("event-3");
      const last = await queries.page({
        ...input,
        limit: 3,
        cursor: first.nextCursor!,
      });
      expect(last.rows.map(({ id }) => id)).toEqual(["event-2", "event-1"]);
      expect(last.nextCursor).toBeNull();
      findMany.mockClear();
      await expect(
        queries.page({
          ...input,
          scope: { kind: "installation", installId: `${installId}different` },
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      await expect(
        queries.page({
          ...input,
          cursor: " ".repeat(getInsightsEventPageCursorLimit(input.scope) + 1),
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it("does not silently enable an unsupported scope or accept malformed provider ordering", async () => {
    const { data, findMany } = harness([]);
    const state = createMockDatabaseState(data);
    const queries = createIndexedInsightsEventQueries({ ...state, findMany }, [
      "all",
    ]);
    await expect(
      queries.page({
        scope: { kind: "installation", installId: "install-a" },
        beforeReceivedAtMs: 3,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(findMany).not.toHaveBeenCalled();
    findMany.mockResolvedValueOnce([event("earlier", 1), event("later", 2)]);
    await expect(
      queries.page({ scope: { kind: "all" }, beforeReceivedAtMs: 3, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    findMany.mockResolvedValueOnce([event("outside", 3)]);
    await expect(
      queries.page({ scope: { kind: "all" }, beforeReceivedAtMs: 3, limit: 1 }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });
});
