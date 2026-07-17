import type { BundleEventRow } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import {
  ACTIVE_AS_OF_MS,
  DAY_MS,
  createUnchangedEvent,
  insertActiveRows,
} from "./bundleEventActive.testFixtures";
import { createBundleEventService } from "./bundleEvents";
import {
  BUNDLE_EVENT_MATERIALIZATION_LIMIT,
  BundleEventScanLimitExceededError,
} from "./bundleEventScan";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("active installation bounded scan", () => {
  it("pushes activity type and half-open time predicates before the cap", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createUnchangedEvent("install-a", ACTIVE_AS_OF_MS - 1),
    ]);
    const findMany = vi.spyOn(database, "findMany");
    const service = createBundleEventService(database);
    const context = { requestId: "active-query" };

    // When
    await service.getActiveInstallationOverview({ window: "24h" }, context);

    // Then
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      {
        model: "bundle_events",
        where: [
          {
            field: "received_at_ms",
            operator: "gte",
            value: ACTIVE_AS_OF_MS - DAY_MS,
          },
          {
            field: "type",
            operator: "in",
            value: ["UPDATE_APPLIED", "RECOVERED", "UNCHANGED"],
          },
          {
            field: "received_at_ms",
            operator: "lt",
            value: ACTIVE_AS_OF_MS,
          },
        ],
        limit: BUNDLE_EVENT_MATERIALIZATION_LIMIT,
        offset: 0,
      },
      context,
    );
  });

  it("throws the stable typed limit for 50,001 matching rows", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = createInMemoryDatabaseAdapter();
    vi.spyOn(database, "findMany").mockResolvedValue(
      Array.from(
        { length: 50_001 },
        (_, index): BundleEventRow =>
          createUnchangedEvent(`install-${index}`, ACTIVE_AS_OF_MS - 1),
      ),
    );
    const service = createBundleEventService(database);

    // When
    const result = service.getActiveInstallationOverview({ window: "30d" });

    // Then
    await expect(result).rejects.toMatchObject({
      name: "BundleEventScanLimitExceededError",
      limit: 50_000,
    });
    await expect(result).rejects.toBeInstanceOf(
      BundleEventScanLimitExceededError,
    );
  });

  it("keeps a materialized response stable across a concurrent insert", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createUnchangedEvent("existing", ACTIVE_AS_OF_MS - 2),
    ]);
    const originalFindMany = database.findMany.bind(database);
    vi.spyOn(database, "findMany").mockImplementation(
      async (input, context) => {
        const rows = await originalFindMany(input, context);
        await database.create({
          model: "bundle_events",
          data: createUnchangedEvent("concurrent", ACTIVE_AS_OF_MS - 1),
        });
        return rows;
      },
    );
    const service = createBundleEventService(database);

    // When
    const overview = await service.getActiveInstallationOverview({
      window: "24h",
    });

    // Then
    expect(overview.activeInstallations).toBe(1);
    expect(overview.bundles).toEqual([
      { bundleId: "bundle-current", installations: 1 },
    ]);
  });
});
