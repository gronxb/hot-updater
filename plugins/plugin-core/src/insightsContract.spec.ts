import { describe, expect, it, vi } from "vitest";

import { createValidatedInsightsModel } from "./insightsContract";
import type {
  BundleEventRow,
  InsightsFindLatestEventsInput,
  InsightsListEventsInput,
  InsightsModel,
} from "./types";

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

/** A provider that stores nothing, behind the validating wrapper under test. */
const emptyModel: InsightsModel = {
  recordEvent: async () => undefined,
  listEvents: async () => [],
  findLatestEvents: async () => [],
  countLatestEvents: async () => 0,
  countEvents: async () => 0,
  getReleaseActivity: async () => ({
    coverage: { kind: "complete", sinceMs: 0 },
    data: [],
    measuredAtMs: 0,
  }),
  getAppUsage: async () => ({
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: 0,
    points: [],
    appVersions: [],
    versions: [],
    platforms: [],
    bundleDistribution: [],
    measuredAtMs: 0,
  }),
};

const createModel = (overrides: Partial<InsightsModel>) =>
  createValidatedInsightsModel({ ...emptyModel, ...overrides });

describe("public Insights validation", () => {
  it("prevents malformed Unicode and noncanonical event IDs from reaching providers", async () => {
    const recordEvent = vi.fn(async () => undefined);
    const model = createModel({ recordEvent });
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
    expect(recordEvent).not.toHaveBeenCalled();
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
