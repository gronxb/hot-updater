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
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "bundle_events",
        limit: 2,
        offset: 0,
        distinctOn: { fields: ["install_id"] },
      }),
      undefined,
    );
    expect(findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, offset: 0 }),
      undefined,
    );
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

  it("aggregates latest installations in one domain-owned scan", async () => {
    // Given
    const database = createInMemoryDatabaseAdapter();
    await Promise.all(
      [
        createEvent("install-a", 1, "old-a"),
        createEvent("install-a", 4, "bundle-a"),
        createEvent("install-b", 3, "bundle-b"),
        createEvent("install-c", 2, "bundle-a"),
      ].map((row) => database.create({ model: "bundle_events", data: row })),
    );
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);

    // When
    const overview = await service.getBundleEventOverview();

    // Then
    expect(overview).toEqual({
      trackedInstallations: 3,
      bundles: [
        { bundleId: "bundle-a", installations: 2 },
        { bundleId: "bundle-b", installations: 1 },
      ],
    });
    expect(findMany).toHaveBeenCalledOnce();
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
