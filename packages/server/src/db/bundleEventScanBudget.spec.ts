import type { BundleEventRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import {
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

const createGeneratedDatabase = (totalRows: number, pageCap = Infinity) => {
  const database = createInMemoryDatabasePlugin();
  const findMany = vi
    .spyOn(database, "findMany")
    .mockImplementation(async (input) => {
      if (input.model !== "bundle_events") return [];
      const offset = input.offset ?? 0;
      const size = Math.max(
        0,
        Math.min(input.limit ?? totalRows, pageCap, totalRows - offset),
      );
      return Array.from({ length: size }, (_, index) =>
        createEvent(offset + index),
      );
    });
  return { database, findMany };
};

describe("bundle event materialization budget", () => {
  it("deduplicates rows shifted across page boundaries by an append", async () => {
    const database = createInMemoryDatabasePlugin();
    const stored = Array.from({ length: 1_001 }, (_, index) =>
      createEvent(index),
    );
    let calls = 0;
    vi.spyOn(database, "findMany").mockImplementation(async (input) => {
      if (input.model !== "bundle_events") return [];
      calls += 1;
      if (calls === 2) stored.unshift(createEvent(-1));
      const offset = input.offset ?? 0;
      const limit = input.limit ?? stored.length;
      return stored.slice(offset, offset + limit);
    });

    const rows = await materializeBundleEventRows({ database, cutoffMs });

    expect(rows).toHaveLength(1_001);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(1_001);
    expect(rows.some(({ id }) => id === "event--1")).toBe(false);
  });

  it("includes a pre-cutoff row committed after an earlier page", async () => {
    const database = createInMemoryDatabasePlugin();
    const stored = Array.from({ length: 1_001 }, (_, index) =>
      createEvent(index),
    );
    let calls = 0;
    vi.spyOn(database, "findMany").mockImplementation(async (input) => {
      if (input.model !== "bundle_events") return [];
      calls += 1;
      if (calls === 2) stored.push(createEvent(1_001));
      const offset = input.offset ?? 0;
      const limit = input.limit ?? stored.length;
      return stored.slice(offset, offset + limit);
    });

    const rows = await materializeBundleEventRows({ database, cutoffMs });

    expect(rows).toHaveLength(1_002);
    expect(rows.at(-1)?.id).toBe("event-1001");
  });

  it("continues across provider-capped pages", async () => {
    // Given
    const { database, findMany } = createGeneratedDatabase(50_000, 1_000);

    // When
    const rows = await materializeBundleEventRows({ database, cutoffMs });

    // Then
    expect(rows).toHaveLength(BUNDLE_EVENT_SCAN_MAX_ROWS);
    expect(findMany).toHaveBeenCalledTimes(51);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      model: "bundle_events",
      where: [{ field: "received_at_ms", operator: "lt", value: cutoffMs }],
      limit: 1_000,
      offset: 0,
      orderBy: [
        { field: "received_at_ms", direction: "asc" },
        { field: "id", direction: "asc" },
      ],
    });
  });

  it("rejects a 50,001-row materialization", async () => {
    // Given
    const { database, findMany } = createGeneratedDatabase(50_001, 1_000);

    // When
    const result = materializeBundleEventRows({ database, cutoffMs });

    // Then
    await expect(result).rejects.toBeInstanceOf(
      BundleEventScanLimitExceededError,
    );
    expect(findMany).toHaveBeenCalledTimes(51);
  });
});
