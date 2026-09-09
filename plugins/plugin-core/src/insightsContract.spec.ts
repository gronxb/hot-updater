import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePlugin,
  createDatabasePluginAdapter,
} from "./createDatabasePlugin";
import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import type {
  BundleEventRow,
  InsightsFindLatestEventsInput,
  InsightsListEventsInput,
  InsightsModel,
} from "./types";
import type { DatabasePluginImplementation } from "./types/internal";

const event: BundleEventRow = {
  id: "00000000-0000-7000-8000-000000000001",
  type: "UPDATE_APPLIED",
  install_id: "install",
  user_id: "user",
  metadata: {
    username: null,
    cohort: "0",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
  },
  from_bundle_id: "bundle-a",
  to_bundle_id: "bundle-b",
  from_release_id: null,
  to_release_id: null,
  platform: "ios",
  app_version: "1",
  channel: "production",

  received_at_ms: 100,
};

const createModel = (overrides: Partial<InsightsModel>) => {
  const plugin = createMemoryDatabasePlugin();
  return createDatabasePlugin({
    ...plugin,
    models: {
      ...plugin.models,
      insights: { ...plugin.models.insights, ...overrides },
    },
  }).models.insights;
};

describe("public Insights validation", () => {
  it("prevents malformed Unicode and noncanonical event IDs from reaching providers", async () => {
    const record = vi.fn(async () => undefined);
    const model = createModel({ record });
    for (const invalid of [
      { ...event, install_id: "broken-\ud800" },
      { ...event, user_id: "broken-\udc00" },
      { ...event, metadata: { ...event.metadata, username: "broken-\ud800" } },
      { ...event, id: "not-a-uuid" },
    ]) {
      await expect(
        model.recordEvent({
          event: invalid,
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
    }
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    { installId: "install", userId: "user", limit: 1 },
    { installId: "install", limit: 1 },
    { userId: "user", limit: 102 },
    { userId: "user", limit: 1, afterInstallId: "\ud800" },
    { userId: "user", limit: 0 },
  ])(
    "rejects invalid installation query form %j before provider I/O",
    async (input) => {
      const findLatestEvents = vi.fn(async () => []);
      const model = createModel({ findLatestEvents });
      await expect(
        model.findLatestEvents(input as InsightsFindLatestEventsInput),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(findLatestEvents).not.toHaveBeenCalled();
    },
  );

  it("rejects cursors outside their interval and conflicting raw bundle predicates", async () => {
    const listEvents = vi.fn(async () => []);
    const model = createModel({ listEvents });
    const query: InsightsListEventsInput = {
      filter: { kind: "all" },
      sinceMs: 100,
      beforeReceivedAtMs: 200,
      limit: 10,
    };
    for (const receivedAtMs of [99, 200]) {
      await expect(
        model.listEvents({ ...query, after: { receivedAtMs, id: event.id } }),
      ).rejects.toMatchObject({ code: "invalid-query" });
    }
    await expect(
      model.listEvents({
        ...query,
        filter: {
          kind: "bundle",
          type: "RECOVERED",
          platform: "ios",
          channel: "production",
          fromBundleId: "bundle-b",
          toBundleId: "bundle-a",
        },
      } as InsightsListEventsInput),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("rejects provider rows that violate the requested filter, range, or cursor order", async () => {
    const query: InsightsListEventsInput = {
      filter: { kind: "all" },
      sinceMs: 100,
      beforeReceivedAtMs: 200,
      limit: 10,
    };
    for (const rows of [
      [{ ...event, received_at_ms: 99 }],
      [{ ...event, received_at_ms: 200 }],
      [event, event],
    ]) {
      await expect(
        createModel({ listEvents: async () => rows }).listEvents(query),
      ).rejects.toMatchObject({ code: "invalid-result" });
    }
    await expect(
      createModel({ listEvents: async () => [event] }).listEvents({
        ...query,
        filter: {
          kind: "bundle",
          platform: "ios",
          channel: "production",
          type: "RECOVERED",
          fromBundleId: "bundle-b",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      createModel({ listEvents: async () => [event] }).listEvents({
        ...query,
        after: { receivedAtMs: event.received_at_ms, id: event.id },
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects stale user membership and incorrectly ordered identity results", async () => {
    const row = event;
    await expect(
      createModel({ findLatestEvents: async () => [row] }).findLatestEvents({
        userId: "different",
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      createModel({
        findLatestEvents: async () => [row, row],
      }).findLatestEvents({ installId: "install" }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      createModel({
        findLatestEvents: async () => [
          { ...row, install_id: "😀" },
          { ...row, install_id: "\ue000" },
        ],
      }).findLatestEvents({ userId: "user", limit: 10 }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("propagates native failures and rejects invalid scalar counts", async () => {
    const failure = new Error("native query failed");
    const countInput = {
      platform: "ios",
      channel: "production",
      sinceMs: 0,
    } as const;
    await expect(
      createModel({
        countLatestEvents: async () => {
          throw failure;
        },
      }).countLatestEvents(countInput),
    ).rejects.toBe(failure);
    await expect(
      createModel({
        listEvents: async () => {
          throw failure;
        },
      }).listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 200,
        limit: 10,
      }),
    ).rejects.toBe(failure);
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      await expect(
        createModel({
          countLatestEvents: async () => count,
        }).countLatestEvents(countInput),
      ).rejects.toMatchObject({ code: "invalid-result" });
    }
  });
});

describe("Insights CRUD adapter", () => {
  it("merges movement pages from bounded per-type index ranges", async () => {
    const withId = (id: number) =>
      `00000000-0000-7000-8000-${String(id).padStart(12, "0")}`;
    const movements: BundleEventRow[] = (
      [
        [60_001, 200, "UPDATE_APPLIED"],
        [60_002, 200, "RECOVERED"],
        [60_003, 199, "UPDATE_APPLIED"],
        [60_004, 198, "RECOVERED"],
        [60_005, 198, "UPDATE_APPLIED"],
        [60_006, 100, "RECOVERED"],
      ] as const
    ).map(([id, received_at_ms, type]) => ({
      ...event,
      id: withId(id),
      received_at_ms,
      type,
    }));
    const all = [...movements, { ...movements[0]!, install_id: "other" }];
    const limit = 2;
    let transferredRows = 0;
    const findMany = vi.fn<DatabasePluginImplementation["findMany"]>(
      async (input) => {
        expect(input.model).toBe("bundle_events");
        expect(input.offset).toBe(0);
        expect(input.limit).toBeGreaterThan(0);
        expect(input.limit).toBeLessThanOrEqual(limit);
        expect(input.where).toContainEqual({
          field: "install_id",
          value: event.install_id,
        });
        const type = input.where?.find((clause) => clause.field === "type");
        expect(type?.operator ?? "eq").toBe("eq");
        expect(["UPDATE_DOWNLOADED", "UPDATE_APPLIED", "RECOVERED"]).toContain(
          type?.value,
        );
        const rows = all
          .filter((row) =>
            input.where!.every((clause) => {
              const current = Reflect.get(row, clause.field);
              if (clause.operator === undefined || clause.operator === "eq")
                return current === clause.value;
              const order =
                typeof current === "number" && typeof clause.value === "number"
                  ? current - clause.value
                  : String(current).localeCompare(String(clause.value));
              return clause.operator === "gte"
                ? order >= 0
                : clause.operator === "lt" && order < 0;
            }),
          )
          .sort(
            (left, right) =>
              right.received_at_ms - left.received_at_ms ||
              right.id.localeCompare(left.id),
          )
          .slice(0, input.limit);
        transferredRows += rows.length;
        return rows;
      },
    );
    const model = createDatabasePlugin({
      name: "indexed-memory",
      ...createDatabasePluginAdapter("indexed-memory", {
        findLatestInsightsEvents: async () => {
          throw new Error("Unexpected Insights read");
        },
        countLatestInsightsEvents: async () => {
          throw new Error("Unexpected Insights count");
        },

        findMany,
        recordInsights: async () => undefined,
        count: async () => 0,
        create: async (input) => input.data,
        update: async () => null,
        delete: async () => undefined,
        findOne: async () => null,
        insertChannel: async ({ row }) => ({ row, inserted: true }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
      }),
    }).models.insights;
    const found: BundleEventRow[] = [];
    let after: InsightsListEventsInput["after"];
    for (;;) {
      const queryCount = findMany.mock.calls.length;
      const previousTransfer = transferredRows;
      const page = await model.listEvents({
        filter: { kind: "installationMovement", installId: event.install_id },
        beforeReceivedAtMs: 60_000,
        after,
        limit,
      });
      expect(findMany.mock.calls.length - queryCount).toBeLessThanOrEqual(
        after ? 6 : 3,
      );
      expect(transferredRows - previousTransfer).toBeLessThanOrEqual(3 * limit);
      found.push(...page);
      if (page.length < limit) break;
      const last = page[page.length - 1]!;
      after = { receivedAtMs: last.received_at_ms, id: last.id };
    }
    expect(found.map(({ id }) => id)).toEqual(
      [60_002, 60_001, 60_003, 60_005, 60_004, 60_006].map(withId),
    );
  });

  it("delegates atomic writes only to the native hook and uses matching count/list predicates", async () => {
    const recordInsights = vi.fn(async () => undefined);
    const count = vi.fn<DatabasePluginImplementation["count"]>(async () => 0);
    const findMany = vi.fn<DatabasePluginImplementation["findMany"]>(
      async () => [],
    );
    const create = vi.fn(async (input) => input.data);
    const plugin = createDatabasePlugin({
      name: "adapter",
      ...createDatabasePluginAdapter("adapter", {
        findLatestInsightsEvents: async () => {
          throw new Error("Unexpected Insights read");
        },
        countLatestInsightsEvents: async () => {
          throw new Error("Unexpected Insights count");
        },

        recordInsights,
        count,
        findMany,
        create,
        update: async () => null,
        delete: async () => undefined,
        findOne: async () => null,
        insertChannel: async ({ row }) => ({ row, inserted: true }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
      }),
    });
    const input = { event };
    await plugin.models.insights.recordEvent(input);
    expect(recordInsights).toHaveBeenCalledExactlyOnceWith(input);
    expect(create).not.toHaveBeenCalled();
    const filter = {
      platform: "ios",
      channel: "production",
      type: "RECOVERED",
      fromBundleId: "bundle-b",
    } as const;
    await plugin.models.insights.countEvents({
      filter,
      sinceMs: 100,
      beforeReceivedAtMs: 200,
    });
    await plugin.models.insights.listEvents({
      filter: { kind: "bundle", ...filter },
      sinceMs: 100,
      beforeReceivedAtMs: 200,
      limit: 10,
    });
    expect(count.mock.calls[0]![0]).toEqual({
      model: "bundle_events",
      where: [
        { field: "platform", value: "ios" },
        { field: "channel", value: "production" },
        { field: "type", value: "RECOVERED" },
        { field: "from_bundle_id", value: "bundle-b" },
        { field: "received_at_ms", operator: "gte", value: 100 },
        { field: "received_at_ms", operator: "lt", value: 200 },
      ],
    });
    expect(findMany.mock.calls[0]![0]).toMatchObject(count.mock.calls[0]![0]);
  });

  it("does not repeat the lower time bound in the equal-timestamp cursor range", async () => {
    const findMany = vi.fn<DatabasePluginImplementation["findMany"]>(
      async () => [],
    );
    const plugin = createDatabasePlugin({
      name: "adapter",
      ...createDatabasePluginAdapter("adapter", {
        findLatestInsightsEvents: async () => {
          throw new Error("Unexpected Insights read");
        },
        countLatestInsightsEvents: async () => {
          throw new Error("Unexpected Insights count");
        },

        findMany,
        recordInsights: async () => undefined,
        count: async () => 0,
        create: async (input) => input.data,
        update: async () => null,
        delete: async () => undefined,
        findOne: async () => null,
        insertChannel: async ({ row }) => ({ row, inserted: true }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
      }),
    });

    await plugin.models.insights.listEvents({
      filter: { kind: "all" },
      sinceMs: 50,
      beforeReceivedAtMs: 200,
      after: { receivedAtMs: 100, id: event.id },
      limit: 10,
    });

    expect(findMany.mock.calls[0]![0]).toEqual({
      model: "bundle_events",
      where: [
        { field: "received_at_ms", value: 100 },
        { field: "id", operator: "lt", value: event.id },
      ],
      orderBy: [{ field: "id", direction: "desc" }],
      limit: 10,
      offset: 0,
    });
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      where: expect.arrayContaining([
        { field: "received_at_ms", operator: "gte", value: 50 },
        { field: "received_at_ms", operator: "lt", value: 100 },
      ]),
    });
  });
});
