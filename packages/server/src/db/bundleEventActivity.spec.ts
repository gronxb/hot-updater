import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createBundleEventService } from "./bundleEvents";
import {
  createEvent,
  createRecoveredEvent,
  expectSingleMaterialization,
  insertRows,
} from "./bundleEvents.testFixtures";

describe("bundle event activity series", () => {
  it("scopes totals to the window and returns per-bucket movement", async () => {
    const now = Date.UTC(2026, 6, 16, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const database = createInMemoryDatabaseAdapter();
    await database.create({
      model: "bundle_events",
      data: createEvent("install-a", now - 31 * 24 * 60 * 60 * 1000),
    });
    await database.create({
      model: "bundle_events",
      data: createEvent("install-a", now - 24 * 60 * 60 * 1000),
    });
    await database.create({
      model: "bundle_events",
      data: createEvent("install-b", now - 2 * 24 * 60 * 60 * 1000),
    });
    const service = createBundleEventService(database);
    const analytics = await service.getBundleEventAnalytics(
      "bundle-a",
      "30d",
      20,
      0,
    );

    expect(analytics.summary.installed).toBe(2);
    expect(
      analytics.series.installed.slice(-3).map(({ value }) => value),
    ).toEqual([1, 1, 0]);
    vi.restoreAllMocks();
  });

  it("keeps analytics stable across an append after materialization", async () => {
    const now = Date.UTC(2026, 6, 16, 12, 30);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const repeated = Array.from({ length: 205 }, (_, index) =>
      createEvent("install-a", now - 1_000 + index, {
        cohort: index % 2 === 0 ? "1" : "2",
      }),
    );
    const database = await insertRows([
      ...repeated,
      createEvent("install-b", now - 700, { cohort: "1" }),
      createEvent("install-c", now - 699, { cohort: "2" }),
      createRecoveredEvent("install-a", now - 698),
      createRecoveredEvent("install-a", now - 697),
      createRecoveredEvent("install-d", now - 696),
    ]);
    const originalFindMany = database.findMany.bind(database);
    let appended = false;
    const findMany = vi
      .spyOn(database, "findMany")
      .mockImplementation(async (input, context) => {
        const page = await originalFindMany(input, context);
        if (!appended && input.model === "bundle_events") {
          appended = true;
          await Promise.all(
            [
              createEvent("a-concurrent-installed", now - 600, { cohort: "0" }),
              createEvent("z-concurrent-installed", now - 599, { cohort: "z" }),
              createRecoveredEvent("a-concurrent-recovered", now - 598),
              createRecoveredEvent("z-concurrent-recovered", now - 597),
            ].map((data) => database.create({ model: "bundle_events", data })),
          );
        }
        return page;
      });
    const service = createBundleEventService(database);

    const analytics = await service.getBundleEventAnalytics(
      "bundle-a",
      "24h",
      5,
      200,
    );

    expect(appended).toBe(true);
    expect(analytics.summary).toEqual({ installed: 3, recovered: 2 });
    expect(analytics.cohorts).toEqual({
      installed: [
        { cohort: "1", value: 2 },
        { cohort: "2", value: 2 },
      ],
      recovered: [{ cohort: "1", value: 2 }],
    });
    const expectedSeries = (value: number) =>
      Array.from({ length: 24 }, (_, index) => ({
        bucketStartMs:
          Date.UTC(2026, 6, 16, 12) - (23 - index) * 60 * 60 * 1000,
        value: index < 23 ? 0 : value,
      }));
    expect(analytics.series.installed).toEqual(expectedSeries(3));
    expect(analytics.series.recovered).toEqual(expectedSeries(2));
    expect(analytics.recentEvents.pagination).toEqual({
      total: 210,
      limit: 5,
      offset: 200,
    });
    expect(
      analytics.recentEvents.data.map(({ receivedAtMs }) => receivedAtMs),
    ).toEqual([now - 991, now - 992, now - 993, now - 994, now - 995]);
    expectSingleMaterialization(findMany);
    expect(findMany.mock.calls[0]?.[0].where?.at(-1)).toEqual({
      field: "received_at_ms",
      operator: "lt",
      value: now,
    });
  });
});
