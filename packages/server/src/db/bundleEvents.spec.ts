import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createBundleEventService } from "./bundleEvents";

const createEvent = (
  installId: string,
  receivedAtMs: number,
  toBundleId: string,
): BundleEventRow => ({
  id: `${installId}-${receivedAtMs}`,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: "old-bundle",
  to_bundle_id: toBundleId,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "1",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const createRecoveredEvent = (
  installId: string,
  receivedAtMs: number,
  fromBundleId: string,
): BundleEventRow => ({
  ...createEvent(installId, receivedAtMs, "fallback-bundle"),
  id: `recovered-${installId}-${receivedAtMs}`,
  type: "RECOVERED",
  from_bundle_id: fromBundleId,
});

const expectBoundedScannerCalls = (
  findMany: ReturnType<typeof vi.fn>,
): void => {
  for (const [input] of findMany.mock.calls) {
    expect(input).not.toHaveProperty("distinctOn");
    expect(input.limit).toBeLessThanOrEqual(100);
    expect(Number.isFinite(input.limit)).toBe(true);
  }
};

describe("bundle event installation search", () => {
  it("pages an empty query over stable latest-per-install rows", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    const rows = [
      createEvent("install-a", 1, "old-a"),
      createEvent("install-a", 4, "latest-a"),
      createEvent("install-b", 3, "latest-b"),
      createEvent("install-c", 2, "latest-c"),
    ];
    await Promise.all(
      rows.map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);

    // When
    const firstPage = await service.searchInstallations("", 2, 0);
    const secondPage = await service.searchInstallations("", 2, 2);

    // Then
    expect(firstPage.pagination).toEqual({ total: 3, limit: 2, offset: 0 });
    expect(secondPage.pagination).toEqual({ total: 3, limit: 2, offset: 2 });
    expect(firstPage.data.map(({ installId }) => installId)).toEqual([
      "install-a",
      "install-b",
    ]);
    expect(secondPage.data.map(({ installId }) => installId)).toEqual([
      "install-c",
    ]);
    expect(firstPage.data[0]?.lastKnownBundleId).toBe("latest-a");
    expectBoundedScannerCalls(findMany);
  });

  it("returns the latest row when a historical identity matches", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    await database.create({
      model: "bundle_events",
      data: {
        ...createEvent("install-a", 1, "old-bundle"),
        username: "historical-name",
      },
    });
    await database.create({
      model: "bundle_events",
      data: {
        ...createEvent("install-a", 2, "latest-bundle"),
        username: "current-name",
      },
    });
    const service = createBundleEventService(database);

    // When
    const result = await service.searchInstallations("historical", 20, 0);

    // Then
    expect(result.data).toMatchObject([
      {
        installId: "install-a",
        username: "current-name",
        lastKnownBundleId: "latest-bundle",
      },
    ]);
  });

  it("finds a late historical-identity page across database pages", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    const installIds = Array.from(
      { length: 205 },
      (_, index) => `install-${index.toString().padStart(3, "0")}`,
    );
    const rows = installIds.flatMap((installId, index) => [
      {
        ...createEvent(installId, index + 1, `old-${installId}`),
        username: `historical-match-${installId}`,
      },
      createEvent(installId, 1_000 + index, `latest-${installId}`),
    ]);
    await Promise.all(
      rows.map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const findMany = vi.spyOn(database, "findMany");
    const count = vi.spyOn(database, "count");
    const service = createBundleEventService(database);

    const context = { requestId: "search-request" };

    // When
    const result = await service.searchInstallations(
      "historical-match",
      5,
      200,
      context,
    );

    // Then
    expect(result.pagination).toEqual({ total: 205, limit: 5, offset: 200 });
    expect(result.data.map(({ installId }) => installId)).toEqual(
      installIds.slice(200),
    );
    expect(
      result.data.map(({ lastKnownBundleId }) => lastKnownBundleId),
    ).toEqual(installIds.slice(200).map((id) => `latest-${id}`));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          {
            field: "install_id",
            operator: "in",
            value: installIds.slice(200),
          },
        ],
      }),
      context,
    );
    expect(count).not.toHaveBeenCalledWith(
      expect.objectContaining({ distinct: expect.anything() }),
      context,
    );
    expectBoundedScannerCalls(findMany);
  });

  it("aggregates a latest-install group that crosses database pages", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    const crossingGroup = Array.from({ length: 205 }, (_, index) =>
      createEvent("install-a", index + 1, `old-${index}`),
    );
    await Promise.all(
      [
        ...crossingGroup,
        createEvent("install-b", 300, "deleted-bundle"),
        createEvent("install-c", 299, "bundle-a"),
      ].map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const count = vi.spyOn(database, "count");
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);
    const context = { requestId: "overview-request" };

    // When
    const overview = await service.getBundleEventOverview(context);

    // Then
    expect(overview).toEqual({
      trackedInstallations: 3,
      bundles: [
        { bundleId: "bundle-a", installations: 1 },
        { bundleId: "deleted-bundle", installations: 1 },
        { bundleId: "old-204", installations: 1 },
      ],
    });
    expect(count).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "bundle_events",
        limit: 100,
        offset: 0,
      }),
      context,
    );
    expectBoundedScannerCalls(findMany);
  });
});

describe("bundle event analytics scanner", () => {
  it("keeps exact aggregates and a late recent page across database pages", async () => {
    // Given
    const now = Date.UTC(2026, 6, 16, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const database = createInMemoryDatabaseAdapter();
    const repeated = Array.from({ length: 205 }, (_, index) => ({
      ...createEvent("install-a", now - 1_000 + index, "bundle-a"),
      cohort: index % 2 === 0 ? "1" : "2",
    }));
    const rows = [
      ...repeated,
      createEvent("install-b", now - 700, "bundle-a"),
      { ...createEvent("install-c", now - 699, "bundle-a"), cohort: "2" },
      createRecoveredEvent("install-a", now - 698, "bundle-a"),
      createRecoveredEvent("install-a", now - 697, "bundle-a"),
      createRecoveredEvent("install-d", now - 696, "bundle-a"),
    ];
    await Promise.all(
      rows.map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const count = vi.spyOn(database, "count");
    const findMany = vi.spyOn(database, "findMany");
    const context = { requestId: "analytics-request" };
    const service = createBundleEventService(database);

    // When
    const analytics = await service.getBundleEventAnalytics(
      "bundle-a",
      "24h",
      5,
      200,
      context,
    );

    // Then
    expect(analytics.summary).toEqual({ installed: 3, recovered: 2 });
    expect(analytics.cohorts).toEqual({
      installed: [
        { cohort: "1", value: 2 },
        { cohort: "2", value: 2 },
      ],
      recovered: [{ cohort: "1", value: 2 }],
    });
    expect(analytics.series.installed.at(-1)?.value).toBe(3);
    expect(analytics.series.recovered.at(-1)?.value).toBe(2);
    expect(analytics.recentEvents.pagination).toEqual({
      total: 210,
      limit: 5,
      offset: 200,
    });
    expect(
      analytics.recentEvents.data.map(({ receivedAtMs }) => receivedAtMs),
    ).toEqual([now - 991, now - 992, now - 993, now - 994, now - 995]);
    expect(count).not.toHaveBeenCalledWith(
      expect.objectContaining({ distinct: expect.anything() }),
      context,
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          {
            field: "received_at_ms",
            operator: "gte",
            value: now - 23 * 60 * 60 * 1000,
          },
        ]),
      }),
      context,
    );
    expectBoundedScannerCalls(findMany);
    vi.restoreAllMocks();
  });
});

describe("bundle event activity series", () => {
  it("counts an in-window event after an older event for the same installation", async () => {
    // Given
    const now = Date.UTC(2026, 6, 16, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const database = createInMemoryDatabaseAdapter();
    await database.create({
      model: "bundle_events",
      data: createEvent(
        "install-a",
        now - 31 * 24 * 60 * 60 * 1000,
        "bundle-a",
      ),
    });
    await database.create({
      model: "bundle_events",
      data: createEvent("install-a", now - 24 * 60 * 60 * 1000, "bundle-a"),
    });
    const service = createBundleEventService(database);

    // When
    const analytics = await service.getBundleEventAnalytics(
      "bundle-a",
      "30d",
      20,
      0,
    );

    // Then
    expect(analytics.series.installed.at(-1)?.value).toBe(1);
    vi.restoreAllMocks();
  });
});
