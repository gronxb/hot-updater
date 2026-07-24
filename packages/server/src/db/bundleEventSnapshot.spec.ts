import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createBundleEventService } from "./bundleEvents";
import {
  BUNDLE_EVENT_SCAN_PAGE_SIZE,
  materializeBundleEventRows,
} from "./bundleEventScan";

const cutoffMs = Date.UTC(2026, 6, 17, 12);

const createEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: Partial<
    Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }>
  > = {},
): Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }> => ({
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
  cohort: "m",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

const insertRows = async (rows: readonly BundleEventRow[]) => {
  const database = createInMemoryDatabasePlugin();
  await Promise.all(
    rows.map((data) => database.create({ model: "bundle_events", data })),
  );
  return database;
};

const createDeferred = () => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("bundle event cutoff-bounded scans", () => {
  it("applies a strict cutoff without mutating the caller input", async () => {
    // Given
    const database = await insertRows([
      createEvent("before", cutoffMs - 1),
      createEvent("at", cutoffMs),
    ]);
    const findMany = vi.spyOn(database, "findMany");
    const where = Object.freeze([
      Object.freeze({ field: "cohort", value: "m" } as const),
    ]);

    // When
    const rows = await materializeBundleEventRows(
      { database, cutoffMs },
      where,
    );

    // Then
    expect(rows.map(({ install_id }) => install_id)).toEqual(["before"]);
    expect(where).toEqual([{ field: "cohort", value: "m" }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { field: "cohort", value: "m" },
          { field: "received_at_ms", operator: "lt", value: cutoffMs },
        ],
      }),
    );
  });

  it("captures Date.now once and starts one bounded scan per public request", async () => {
    // Given
    const database = createInMemoryDatabasePlugin();
    const findMany = vi.spyOn(database, "findMany");
    const count = vi.spyOn(database, "count");
    const service = createBundleEventService(database);
    const now = vi.spyOn(Date, "now").mockReturnValue(cutoffMs);
    const requests = [
      () => service.getBundleEventSummary("bundle-a"),
      () => service.getBundleEventAnalytics("bundle-a", "24h", 20, 0),
      () => service.getBundleEventOverview(),
      () => service.searchInstallations("", 20, 0),
      () => service.getInstallationHistory("install-a", 20, 0),
    ];

    // When / Then
    for (const request of requests) {
      now.mockClear();
      findMany.mockClear();
      count.mockClear();
      await request();
      expect(now).toHaveBeenCalledOnce();
      expect(findMany).toHaveBeenCalledOnce();
      expect(count).not.toHaveBeenCalled();
      expect(findMany.mock.calls[0]?.[0]).toMatchObject({
        model: "bundle_events",
        limit: BUNDLE_EVENT_SCAN_PAGE_SIZE,
        offset: 0,
        orderBy: [
          { field: "received_at_ms", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
      });
    }
  });

  it("excludes an append suspended after its page materializes", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(cutoffMs);
    const database = await insertRows([
      createEvent("install-a", cutoffMs - 2, { username: "historical-match" }),
      createEvent("install-a", cutoffMs - 1, {
        username: "current-name",
        to_bundle_id: "current-bundle",
      }),
    ]);
    const originalFindMany = database.findMany.bind(database);
    const statementMaterialized = createDeferred();
    const releaseStatement = createDeferred();
    const findMany = vi
      .spyOn(database, "findMany")
      .mockImplementation(async (input) => {
        const rows = await originalFindMany(input);
        statementMaterialized.resolve();
        await releaseStatement.promise;
        return rows;
      });
    const service = createBundleEventService(database);

    // When
    const pending = service.searchInstallations("historical", 20, 0);
    await statementMaterialized.promise;
    await database.create({
      model: "bundle_events",
      data: createEvent("install-a", cutoffMs - 1, {
        id: "concurrent-event",
        username: "concurrent-name",
        to_bundle_id: "concurrent-bundle",
      }),
    });
    releaseStatement.resolve();
    const result = await pending;

    // Then
    expect(result.data).toMatchObject([
      { username: "current-name", lastKnownBundleId: "current-bundle" },
    ]);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("deduplicates mixed-case installation ids without collation adjacency", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(cutoffMs);
    const database = await insertRows([
      createEvent("a", cutoffMs - 4, { to_bundle_id: "old-lower" }),
      createEvent("A", cutoffMs - 3, { to_bundle_id: "old-upper" }),
      createEvent("a", cutoffMs - 2, { to_bundle_id: "new-lower" }),
      createEvent("A", cutoffMs - 1, { to_bundle_id: "new-upper" }),
    ]);
    const service = createBundleEventService(database);

    // When
    const search = await service.searchInstallations("", 20, 0);
    const overview = await service.getBundleEventOverview();

    // Then
    expect(
      search.data.map(({ installId, lastKnownBundleId }) => ({
        installId,
        lastKnownBundleId,
      })),
    ).toEqual([
      { installId: "A", lastKnownBundleId: "new-upper" },
      { installId: "a", lastKnownBundleId: "new-lower" },
    ]);
    expect(overview.trackedInstallations).toBe(2);
  });

  it("uses the same strict cutoff for history totals and rows", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(cutoffMs);
    const database = await insertRows([
      createEvent("install-a", cutoffMs - 1),
      createEvent("install-a", cutoffMs),
    ]);
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);

    // When
    const result = await service.getInstallationHistory("install-a", 20, 0);

    // Then
    expect(result.pagination.total).toBe(1);
    expect(result.data.map(({ receivedAtMs }) => receivedAtMs)).toEqual([
      cutoffMs - 1,
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { field: "install_id", value: "install-a" },
          {
            field: "type",
            operator: "in",
            value: ["UPDATE_APPLIED", "RECOVERED"],
          },
          { field: "received_at_ms", operator: "lt", value: cutoffMs },
        ],
      }),
    );
  });
});
