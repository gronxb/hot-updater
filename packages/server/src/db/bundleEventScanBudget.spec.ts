import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import {
  BUNDLE_EVENT_SCAN_MAX_PAGES,
  BUNDLE_EVENT_SCAN_PAGE_SIZE,
  BundleEventScanLimitExceededError,
  scanBundleEventRows,
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

const scanGeneratedRows = (totalRows: number) => {
  const database = createInMemoryDatabaseAdapter();
  const findMany = vi
    .spyOn(database, "findMany")
    .mockImplementation(async (input) => {
      if (input.model !== "bundle_events") return [];
      const offset = input.offset ?? 0;
      const size = Math.min(input.limit ?? totalRows, totalRows - offset);
      return Array.from({ length: Math.max(size, 0) }, (_, index) =>
        createEvent(offset + index),
      );
    });
  let yielded = 0;
  const run = async (): Promise<number> => {
    for await (const _row of scanBundleEventRows(
      { database, cutoffMs },
      { orderBy: [{ field: "install_id", direction: "asc" }] },
    )) {
      yielded += 1;
    }
    return yielded;
  };
  return { findMany, getYielded: () => yielded, run };
};

describe("bundle event scan budget", () => {
  it("allows exactly 50,000 rows including the empty probe", async () => {
    // Given
    const scan = scanGeneratedRows(50_000);

    // When
    const yielded = await scan.run();

    // Then
    expect(yielded).toBe(50_000);
    expect(scan.findMany).toHaveBeenCalledTimes(BUNDLE_EVENT_SCAN_MAX_PAGES);
    expect(scan.findMany.mock.calls.at(-1)?.[0]).toMatchObject({
      limit: 100,
      offset: 50_000,
    });
  });

  it("throws before yielding row 50,001", async () => {
    // Given
    const scan = scanGeneratedRows(50_001);

    // When
    const result = scan.run();

    // Then
    await expect(result).rejects.toBeInstanceOf(
      BundleEventScanLimitExceededError,
    );
    expect(scan.getYielded()).toBe(50_000);
    expect(scan.findMany).toHaveBeenCalledTimes(BUNDLE_EVENT_SCAN_MAX_PAGES);
  });

  it("uses fixed 100-row pages", () => {
    // Given / When / Then
    expect(BUNDLE_EVENT_SCAN_PAGE_SIZE).toBe(100);
    expect(BUNDLE_EVENT_SCAN_MAX_PAGES).toBe(501);
  });
});
