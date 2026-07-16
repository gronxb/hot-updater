import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import {
  BUNDLE_EVENT_MATERIALIZATION_LIMIT,
  BUNDLE_EVENT_SCAN_MAX_ROWS,
  BundleEventScanLimitExceededError,
  materializeBundleEventRows,
} from "./bundleEventScan";

const cutoffMs = Date.UTC(2026, 6, 17, 12);

const createEvent = (index: number): BundleEventRow => ({
  id: `event-${index}`,
  type: "UPDATE_APPLIED",
  install_id: `install-${index}`,
  user_id: null,
  username: null,
  from_bundle_id: "old-bundle",
  to_bundle_id: "bundle-a",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: cutoffMs - 1,
});

const createGeneratedDatabase = (totalRows: number) => {
  const database = createInMemoryDatabaseAdapter();
  const findMany = vi
    .spyOn(database, "findMany")
    .mockImplementation(async (input) => {
      if (input.model !== "bundle_events") return [];
      const size = Math.min(input.limit ?? totalRows, totalRows);
      return Array.from({ length: size }, (_, index) => createEvent(index));
    });
  return { database, findMany };
};

describe("bundle event materialization budget", () => {
  it("materializes exactly 50,000 rows in one statement", async () => {
    // Given
    const { database, findMany } = createGeneratedDatabase(50_000);

    // When
    const rows = await materializeBundleEventRows({ database, cutoffMs });

    // Then
    expect(rows).toHaveLength(BUNDLE_EVENT_SCAN_MAX_ROWS);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      {
        model: "bundle_events",
        where: [{ field: "received_at_ms", operator: "lt", value: cutoffMs }],
        limit: BUNDLE_EVENT_MATERIALIZATION_LIMIT,
        offset: 0,
      },
      undefined,
    );
  });

  it("rejects a 50,001-row materialization", async () => {
    // Given
    const { database, findMany } = createGeneratedDatabase(50_001);

    // When
    const result = materializeBundleEventRows({ database, cutoffMs });

    // Then
    await expect(result).rejects.toBeInstanceOf(
      BundleEventScanLimitExceededError,
    );
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("uses one overflow-probe row", () => {
    // Given / When / Then
    expect(BUNDLE_EVENT_MATERIALIZATION_LIMIT).toBe(
      BUNDLE_EVENT_SCAN_MAX_ROWS + 1,
    );
  });
});
