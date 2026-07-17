import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_AS_OF_MS,
  DAY_MS,
  HOUR_MS,
  createActiveRecoveredEvent,
  createActiveTransitionEvent,
  createUnchangedEvent,
  insertActiveRows,
} from "./bundleEventActive.testFixtures";
import { createBundleEventService } from "./bundleEvents";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("active installation series", () => {
  it("returns 24 zero-filled non-cumulative distinct-install buckets", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const startMs = ACTIVE_AS_OF_MS - DAY_MS;
    const database = await insertActiveRows([
      createActiveTransitionEvent("install-a", startMs),
      createUnchangedEvent("install-a", startMs + 1),
      createActiveRecoveredEvent("install-b", startMs + 2),
      createUnchangedEvent("install-a", startMs + HOUR_MS),
      createUnchangedEvent("install-c", ACTIVE_AS_OF_MS - 1),
    ]);
    const service = createBundleEventService(database);

    // When
    const overview = await service.getActiveInstallationOverview({
      window: "24h",
    });

    // Then
    expect(overview.series).toHaveLength(24);
    expect(overview.series[0]).toEqual({
      bucketStartMs: startMs,
      value: 2,
    });
    expect(overview.series[1]).toEqual({
      bucketStartMs: startMs + HOUR_MS,
      value: 1,
    });
    expect(overview.series.slice(2, -1).every(({ value }) => value === 0)).toBe(
      true,
    );
    expect(overview.series.at(-1)).toEqual({
      bucketStartMs: ACTIVE_AS_OF_MS - HOUR_MS,
      value: 1,
    });
  });

  it.each([
    { window: "7d" as const, buckets: 7 },
    { window: "30d" as const, buckets: 30 },
  ])(
    "returns $buckets daily buckets for $window",
    async ({ window, buckets }) => {
      // Given
      vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
      const startMs = ACTIVE_AS_OF_MS - buckets * DAY_MS;
      const database = await insertActiveRows([
        createUnchangedEvent("at-start", startMs),
        createUnchangedEvent("next-day", startMs + DAY_MS),
      ]);
      const service = createBundleEventService(database);

      // When
      const overview = await service.getActiveInstallationOverview({ window });

      // Then
      expect(overview.series).toHaveLength(buckets);
      expect(overview.series[0]).toEqual({ bucketStartMs: startMs, value: 1 });
      expect(overview.series[1]).toEqual({
        bucketStartMs: startMs + DAY_MS,
        value: 1,
      });
      expect(overview.series.slice(2).every(({ value }) => value === 0)).toBe(
        true,
      );
    },
  );

  it("applies latest-alias filtering to every series bucket", async () => {
    // Given
    vi.spyOn(Date, "now").mockReturnValue(ACTIVE_AS_OF_MS);
    const startMs = ACTIVE_AS_OF_MS - DAY_MS;
    const database = await insertActiveRows([
      createActiveTransitionEvent("renamed", startMs + 1, {
        user_id: "alias-a",
      }),
      createUnchangedEvent("renamed", ACTIVE_AS_OF_MS - 1, {
        user_id: "alias-b",
      }),
      createUnchangedEvent("other", startMs + 1, { user_id: "alias-a" }),
    ]);
    const service = createBundleEventService(database);

    // When
    const overview = await service.getActiveInstallationOverview({
      window: "24h",
      userId: "alias-b",
    });

    // Then
    expect(overview.series[0]?.value).toBe(1);
    expect(overview.series.at(-1)?.value).toBe(1);
    expect(overview.activeInstallations).toBe(1);
  });
});
