import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createBundleEventService } from "./bundleEvents";

const createEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow => ({
  id: `${installId}-${receivedAtMs}`,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: "old-bundle",
  to_bundle_id: "bundle-a",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "1",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

const createRecoveredEvent = (
  installId: string,
  receivedAtMs: number,
): BundleEventRow =>
  createEvent(installId, receivedAtMs, {
    type: "RECOVERED",
    from_bundle_id: "bundle-a",
    to_bundle_id: "fallback-bundle",
    cohort: "1",
  });

const insertRows = async (rows: readonly BundleEventRow[]) => {
  const database = createInMemoryDatabaseAdapter();
  await Promise.all(
    rows.map((data) => database.create({ model: "bundle_events", data })),
  );
  return database;
};

const expectSingleMaterialization = (
  findMany: ReturnType<typeof vi.fn>,
): void => {
  expect(findMany).toHaveBeenCalledOnce();
  expect(findMany.mock.calls[0]?.[0]).toMatchObject({
    model: "bundle_events",
    limit: 50_001,
    offset: 0,
  });
};

describe("bundle event installation search", () => {
  it("pages an empty query over stable latest-per-install rows", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    const rows = [
      createEvent("install-a", 1, { to_bundle_id: "old-a" }),
      createEvent("install-a", 4, { to_bundle_id: "latest-a" }),
      createEvent("install-b", 3, { to_bundle_id: "latest-b" }),
      createEvent("install-c", 2, { to_bundle_id: "latest-c" }),
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
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [input] of findMany.mock.calls) {
      expect(input).toMatchObject({
        model: "bundle_events",
        limit: 50_001,
        offset: 0,
      });
    }
  });

  it("returns the latest row when a historical identity matches", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    await database.create({
      model: "bundle_events",
      data: {
        ...createEvent("install-a", 1, { to_bundle_id: "old-bundle" }),
        username: "historical-name",
      },
    });
    await database.create({
      model: "bundle_events",
      data: {
        ...createEvent("install-a", 2, { to_bundle_id: "latest-bundle" }),
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

  it("finds a late historical-identity page from one materialization", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    const installIds = Array.from(
      { length: 205 },
      (_, index) => `install-${index.toString().padStart(3, "0")}`,
    );
    const rows = installIds.flatMap((installId, index) => [
      {
        ...createEvent(installId, index + 1, {
          to_bundle_id: `old-${installId}`,
        }),
        username: `historical-match-${installId}`,
      },
      createEvent(installId, 1_000 + index, {
        to_bundle_id: `latest-${installId}`,
      }),
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
    expectSingleMaterialization(findMany);
    expect(findMany.mock.calls[0]?.[0].where).toEqual([
      {
        field: "received_at_ms",
        operator: "lt",
        value: expect.any(Number),
      },
    ]);
    expect(count).not.toHaveBeenCalledWith(
      expect.objectContaining({ distinct: expect.anything() }),
      context,
    );
  });

  it("aggregates repeated installation rows without adjacency", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    const crossingGroup = Array.from({ length: 205 }, (_, index) =>
      createEvent("install-a", index + 1, { to_bundle_id: `old-${index}` }),
    );
    await Promise.all(
      [
        ...crossingGroup,
        createEvent("install-b", 300, { to_bundle_id: "deleted-bundle" }),
        createEvent("install-c", 299, { to_bundle_id: "bundle-a" }),
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
    expectSingleMaterialization(findMany);
    expect(findMany.mock.calls[0]?.[1]).toBe(context);
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
      data: createEvent("install-a", now - 31 * 24 * 60 * 60 * 1000),
    });
    await database.create({
      model: "bundle_events",
      data: createEvent("install-a", now - 24 * 60 * 60 * 1000),
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

  it("keeps analytics stable across an append after materialization", async () => {
    // Given
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

    // When
    const analytics = await service.getBundleEventAnalytics(
      "bundle-a",
      "24h",
      5,
      200,
    );

    // Then
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
