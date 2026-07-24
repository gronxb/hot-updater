import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_AS_OF_MS,
  DAY_MS,
  createActiveTransitionEvent,
  createUnchangedEvent,
  insertActiveRows,
} from "./active.parity.testFixtures";
import { createBoundedAnalyticsProvider as createBundleEventService } from "./provider";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("active installation overview", () => {
  it("counts installId once and keeps two installs sharing a userId", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createActiveTransitionEvent("install-a", ACTIVE_AS_OF_MS - 300, {
        user_id: "shared-user",
        to_bundle_id: "bundle-old",
      }),
      createUnchangedEvent("install-a", ACTIVE_AS_OF_MS - 200, {
        user_id: "shared-user",
        to_bundle_id: "bundle-a",
      }),
      createUnchangedEvent("install-b", ACTIVE_AS_OF_MS - 100, {
        user_id: "shared-user",
        to_bundle_id: "bundle-b",
      }),
    ]);
    const service = createBundleEventService(database);

    // When
    const overview = await service.getActiveInstallationOverview({
      window: "24h",
      userId: "shared-user",
    });

    // Then
    expect(overview).toMatchObject({
      asOfMs: ACTIVE_AS_OF_MS,
      window: "24h",
      activeInstallations: 2,
      bundles: [
        { bundleId: "bundle-a", installations: 1 },
        { bundleId: "bundle-b", installations: 1 },
      ],
    });
    expect(
      overview.bundles.reduce(
        (total, { installations }) => total + installations,
        0,
      ),
    ).toBe(overview.activeInstallations);
  });

  it("filters by the exact latest case-sensitive user alias", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createActiveTransitionEvent("alias-change", ACTIVE_AS_OF_MS - 300, {
        user_id: "Alias-A",
      }),
      createUnchangedEvent("alias-change", ACTIVE_AS_OF_MS - 200, {
        user_id: "Alias-B",
      }),
      createUnchangedEvent("null-alias", ACTIVE_AS_OF_MS - 100, {
        user_id: null,
      }),
    ]);
    const service = createBundleEventService(database);

    // When
    const [oldAlias, wrongCase, latestAlias, unfiltered] = await Promise.all([
      service.getActiveInstallationOverview({
        window: "24h",
        userId: "Alias-A",
      }),
      service.getActiveInstallationOverview({
        window: "24h",
        userId: "alias-b",
      }),
      service.getActiveInstallationOverview({
        window: "24h",
        userId: "Alias-B",
      }),
      service.getActiveInstallationOverview({ window: "24h" }),
    ]);

    // Then
    expect(oldAlias.activeInstallations).toBe(0);
    expect(wrongCase.activeInstallations).toBe(0);
    expect(latestAlias.activeInstallations).toBe(1);
    expect(unfiltered.activeInstallations).toBe(2);
  });

  it("uses received time then descending id as the latest-row tie break", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createUnchangedEvent("install-tie", ACTIVE_AS_OF_MS - 100, {
        id: "event-a",
        user_id: "alias-a",
        to_bundle_id: "bundle-a",
      }),
      createUnchangedEvent("install-tie", ACTIVE_AS_OF_MS - 100, {
        id: "event-z",
        user_id: "alias-z",
        to_bundle_id: "unknown-deleted-bundle",
      }),
    ]);
    const service = createBundleEventService(database);

    // When
    const overview = await service.getActiveInstallationOverview({
      window: "24h",
      userId: "alias-z",
    });

    // Then
    expect(overview).toMatchObject({
      activeInstallations: 1,
      bundles: [{ bundleId: "unknown-deleted-bundle", installations: 1 }],
    });
  });

  it("includes the start and excludes the asOf cutoff", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const database = await insertActiveRows([
      createUnchangedEvent("at-start", ACTIVE_AS_OF_MS - DAY_MS),
      createUnchangedEvent("before-start", ACTIVE_AS_OF_MS - DAY_MS - 1),
      createUnchangedEvent("before-end", ACTIVE_AS_OF_MS - 1),
      createUnchangedEvent("at-end", ACTIVE_AS_OF_MS),
    ]);
    const service = createBundleEventService(database);

    // When
    const overview = await service.getActiveInstallationOverview({
      window: "24h",
    });

    // Then
    expect(overview.activeInstallations).toBe(2);
  });
});
