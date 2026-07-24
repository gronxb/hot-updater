import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_AS_OF_MS,
  createActiveRecoveredEvent,
  createActiveTransitionEvent,
  createUnchangedEvent,
  insertActiveRows,
} from "./bundleEventActive.testFixtures";
import { createBundleEventService } from "./bundleEvents";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bundle event analytics isolation", () => {
  it("pushes transition types before applying the scan budget", async () => {
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createActiveTransitionEvent("installed", ACTIVE_AS_OF_MS - 1),
    ]);
    const originalFindMany = database.findMany.bind(database);
    const unchanged = Array.from({ length: 50_001 }, (_, index) =>
      createUnchangedEvent(`unchanged-${index}`, ACTIVE_AS_OF_MS - 2),
    );
    vi.spyOn(database, "findMany").mockImplementation((input) => {
      const hasTypePredicate = input.where?.some(
        (condition) =>
          (condition as { readonly field: string }).field === "type",
      );
      return hasTypePredicate
        ? originalFindMany(input)
        : Promise.resolve(unchanged);
    });

    const summary =
      await createBundleEventService(database).getBundleEventSummary(
        "bundle-current",
      );

    expect(summary).toEqual({ installed: 1, recovered: 0 });
  });

  it("excludes UNCHANGED from installed and recovered bundle metrics", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createActiveTransitionEvent("installed", ACTIVE_AS_OF_MS - 4),
      createActiveRecoveredEvent("recovered", ACTIVE_AS_OF_MS - 3, {
        from_bundle_id: "bundle-current",
        to_bundle_id: "bundle-fallback",
      }),
      createUnchangedEvent("unchanged", ACTIVE_AS_OF_MS - 2),
    ]);
    const service = createBundleEventService(database);

    // When
    const [summary, analytics] = await Promise.all([
      service.getBundleEventSummary("bundle-current"),
      service.getBundleEventAnalytics("bundle-current", "24h", 20, 0),
    ]);

    // Then
    expect(summary).toEqual({ installed: 1, recovered: 1 });
    expect(analytics.summary).toEqual({ installed: 1, recovered: 1 });
    expect(analytics.recentEvents.pagination.total).toBe(2);
    expect(analytics.recentEvents.data.map(({ type }) => type)).toEqual([
      "RECOVERED",
      "UPDATE_APPLIED",
    ]);
  });

  it("discovers an installation tracked only by UNCHANGED", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createUnchangedEvent("unchanged-only", ACTIVE_AS_OF_MS - 1, {
        user_id: "Alias-A",
        to_bundle_id: "active-bundle",
      }),
    ]);
    const service = createBundleEventService(database);

    // When
    const [overview, search, history] = await Promise.all([
      service.getBundleEventOverview(),
      service.searchInstallations("Alias-A", 20, 0),
      service.getInstallationHistory("unchanged-only", 20, 0),
    ]);

    // Then
    expect(overview).toEqual({ trackedInstallations: 0, bundles: [] });
    expect(search.data).toMatchObject([
      {
        installId: "unchanged-only",
        userId: "Alias-A",
        lastKnownBundleId: "active-bundle",
        latestStatus: "UNCHANGED",
      },
    ]);
    expect(history.data).toEqual([]);
  });

  it("refreshes installation state from a newer UNCHANGED event", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createActiveTransitionEvent("alias-change", ACTIVE_AS_OF_MS - 2, {
        user_id: "Alias-A",
        to_bundle_id: "transition-bundle",
      }),
      createUnchangedEvent("alias-change", ACTIVE_AS_OF_MS - 1, {
        user_id: "Alias-B",
        to_bundle_id: "active-bundle",
      }),
    ]);
    const service = createBundleEventService(database);

    // When
    const [overview, search, history, active] = await Promise.all([
      service.getBundleEventOverview(),
      service.searchInstallations("Alias-A", 20, 0),
      service.getInstallationHistory("alias-change", 20, 0),
      service.getActiveInstallationOverview({
        window: "24h",
        userId: "Alias-B",
      }),
    ]);

    // Then
    expect(overview).toEqual({
      trackedInstallations: 1,
      bundles: [{ bundleId: "transition-bundle", installations: 1 }],
    });
    expect(search.data).toMatchObject([
      {
        installId: "alias-change",
        userId: "Alias-B",
        lastKnownBundleId: "active-bundle",
        latestStatus: "UNCHANGED",
      },
    ]);
    expect(history.data.map(({ type }) => type)).toEqual(["UPDATE_APPLIED"]);
    expect(active.activeInstallations).toBe(1);
    expect(active.bundles).toEqual([
      { bundleId: "active-bundle", installations: 1 },
    ]);
  });
});
