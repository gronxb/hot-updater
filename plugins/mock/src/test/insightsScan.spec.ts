import type { BundleEventRow } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import {
  createMockDatabaseData,
  createMockDatabaseState,
} from "../mockDatabaseState";

const event = (id: string, receivedAtMs: number): BundleEventRow => ({
  id,
  received_at_ms: receivedAtMs,
  type: "UNCHANGED",
  install_id: "install-a",
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: "bundle-a",
  from_release_id: null,
  to_release_id: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
});

describe("Insights database cursor scans", () => {
  it("reads only the requested page after a large history, including timestamp ties", async () => {
    const data = createMockDatabaseData();
    for (let index = 0; index < 50_001; index++) {
      const row = event(`old-${index}`, index);
      data.bundleEvents.set(row.id, row);
    }
    for (const row of [
      event("cursor", 60_000),
      event("same-a", 60_000),
      event("same-b", 60_000),
      event("later", 60_001),
      event("cutoff", 60_002),
    ])
      data.bundleEvents.set(row.id, row);

    const state = createMockDatabaseState(data);
    let transferredRows = 0;
    let reads = 0;
    const adapter = createDatabasePluginAdapter("scan-test", {
      ...state,
      insertChannel: async () => {
        throw new Error("Not used in this scenario");
      },
      deleteChannel: async () => {
        throw new Error("Not used in this scenario");
      },
      async findMany(input) {
        reads++;
        const rows = await state.findMany(input);
        transferredRows += rows.length;
        return rows;
      },
    });
    const scan = adapter.models.insights.scan;
    const first = await scan({
      after: { receivedAtMs: 60_000, id: "cursor" },
      beforeReceivedAtMs: 60_002,
      limit: 2,
    });
    expect(first.map(({ id }) => id)).toEqual(["same-a", "same-b"]);
    const next = await scan({
      after: { receivedAtMs: 60_000, id: "same-b" },
      beforeReceivedAtMs: 60_002,
      limit: 2,
    });
    expect(next.map(({ id }) => id)).toEqual(["later"]);
    expect(transferredRows).toBe(3);
    expect(reads).toBeLessThanOrEqual(4);
    const previousReads = reads;
    await expect(
      scan({
        after: { receivedAtMs: 60_002, id: "cutoff" },
        beforeReceivedAtMs: 60_002,
        limit: 2,
      }),
    ).resolves.toEqual([]);
    await expect(
      scan({ beforeReceivedAtMs: 60_002, limit: 0 }),
    ).resolves.toEqual([]);
    expect(reads).toBe(previousReads);
  });
});
