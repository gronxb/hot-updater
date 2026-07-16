import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { createBundleEventService } from "./bundleEvents";
import { scanBundleEventRows } from "./bundleEventScan";

const cutoffMs = Date.UTC(2026, 6, 17, 12);

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
  cohort: "m",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

const insertRows = async (
  rows: readonly BundleEventRow[],
): Promise<ReturnType<typeof createInMemoryDatabaseAdapter>> => {
  const database = createInMemoryDatabaseAdapter();
  await Promise.all(
    rows.map((data) => database.create({ model: "bundle_events", data })),
  );
  return database;
};

describe("bundle event immutable snapshots", () => {
  it("appends a strict cutoff without mutating the caller input", async () => {
    // Given
    const database = await insertRows([
      createEvent("before", cutoffMs - 1),
      createEvent("at", cutoffMs),
    ]);
    const findMany = vi.spyOn(database, "findMany");
    const where = Object.freeze([
      Object.freeze({ field: "cohort", value: "m" } as const),
    ]);
    const request = {
      where,
      orderBy: [{ field: "received_at_ms", direction: "asc" }],
    } as const;

    // When
    const rows: BundleEventRow[] = [];
    for await (const row of scanBundleEventRows(
      { database, cutoffMs },
      request,
    ))
      rows.push(row);

    // Then
    expect(rows.map(({ install_id }) => install_id)).toEqual(["before"]);
    expect(request.where).toBe(where);
    expect(request.where).toEqual([{ field: "cohort", value: "m" }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [
          { field: "cohort", value: "m" },
          {
            field: "received_at_ms",
            operator: "lt",
            value: cutoffMs,
          },
        ],
      }),
      undefined,
    );
  });

  it("captures Date.now once for every public read request", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
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
      await request();
      expect(now).toHaveBeenCalledTimes(1);
    }
  });

  it("shares one snapshot across both installation-search passes", async () => {
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
    let appended = false;
    const findMany = vi
      .spyOn(database, "findMany")
      .mockImplementation(async (input, context) => {
        if (appended || input.model !== "bundle_events") {
          return originalFindMany(input, context);
        }
        const isSecondPass = input.where?.length === 2;
        if (isSecondPass) {
          appended = true;
          await database.create({
            model: "bundle_events",
            data: createEvent("install-a", cutoffMs, {
              username: "concurrent-name",
              to_bundle_id: "concurrent-bundle",
            }),
          });
        }
        return originalFindMany(input, context);
      });
    const service = createBundleEventService(database);

    // When
    const result = await service.searchInstallations("historical", 20, 0);

    // Then
    expect(appended).toBe(true);
    expect(result.data).toMatchObject([
      { username: "current-name", lastKnownBundleId: "current-bundle" },
    ]);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: [
        { field: "username" },
        { field: "user_id", connector: "OR" },
        { field: "install_id", connector: "OR" },
        { field: "received_at_ms", operator: "lt", value: cutoffMs },
      ],
    });
  });

  it("uses the same strict cutoff for history count and rows", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(cutoffMs);
    const database = await insertRows([
      createEvent("install-a", cutoffMs - 1),
      createEvent("install-a", cutoffMs),
    ]);
    const count = vi.spyOn(database, "count");
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);

    // When
    const result = await service.getInstallationHistory("install-a", 20, 0);

    // Then
    const expectedWhere = [
      { field: "install_id", value: "install-a" },
      { field: "received_at_ms", operator: "lt", value: cutoffMs },
    ];
    expect(result.pagination.total).toBe(1);
    expect(result.data.map(({ receivedAtMs }) => receivedAtMs)).toEqual([
      cutoffMs - 1,
    ]);
    expect(count.mock.calls[0]?.[0]).toMatchObject({ where: expectedWhere });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ where: expectedWhere });
  });
});
