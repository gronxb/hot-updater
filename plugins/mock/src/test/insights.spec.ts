import type { BundleEventRow } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { mockDatabase } from "../mockDatabase";
import {
  createMockDatabaseData,
  createMockDatabaseState,
} from "../mockDatabaseState";

const event = (
  id: string,
  receivedAtMs: number,
  input: {
    readonly installId?: string;
    readonly type?: BundleEventRow["type"];
    readonly userId?: string | null;
  } = {},
): BundleEventRow => {
  const type = input.type ?? "UNCHANGED";
  const base = {
    id,
    received_at_ms: receivedAtMs,
    install_id: input.installId ?? "install-a",
    user_id: input.userId ?? null,
    username: null,
    from_release_id: null,
    to_release_id: null,
    to_bundle_id: "bundle-a",
    platform: "ios" as const,
    app_version: "1.0.0",
    channel: "production",
    cohort: "default",
    fingerprint_hash: null,
    sdk_version: null,
  };
  return type === "UNCHANGED"
    ? {
        ...base,
        type,
        from_bundle_id: null,
        update_strategy: null,
      }
    : {
        ...base,
        type,
        from_bundle_id: "bundle-previous",
        update_strategy: "appVersion",
      };
};

describe("mock Insights model", () => {
  it("pages a large event history newest-first without materializing it", async () => {
    const data = createMockDatabaseData();
    for (let index = 0; index < 50_001; index++) {
      const row = event(`old-${index}`, index);
      data.bundleEvents.set(row.id, row);
    }
    for (const row of [
      event("same-a", 60_000),
      event("same-b", 60_000),
      event("later", 60_001),
    ]) {
      data.bundleEvents.set(row.id, row);
    }

    const state = createMockDatabaseState(data);
    let transferredRows = 0;
    const adapter = createDatabasePluginAdapter("page-test", {
      ...state,
      insertChannel: async () => {
        throw new Error("Not used in this scenario");
      },
      deleteChannel: async () => {
        throw new Error("Not used in this scenario");
      },
      async findMany(input) {
        const rows = await state.findMany(input);
        transferredRows += rows.length;
        return rows;
      },
    });

    const first = await adapter.models.insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 60_002,
      limit: 2,
    });
    const second = await adapter.models.insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 60_002,
      after: { receivedAtMs: 60_000, id: "same-b" },
      limit: 2,
    });

    expect(first.map(({ id }) => id)).toEqual(["later", "same-b"]);
    expect(second.map(({ id }) => id)).toEqual(["same-a", "old-50000"]);
    expect(transferredRows).toBe(4);
  });

  it("keeps the latest installation identity and counts active installs once", async () => {
    const database = mockDatabase({ latency: { min: 0, max: 0 } });
    await database.models.insights.append(
      event("event-b", 200, {
        installId: "install-a",
        type: "UPDATE_APPLIED",
        userId: "user-current",
      }),
    );
    await database.models.insights.append(
      event("event-a", 100, {
        installId: "install-a",
        type: "RECOVERED",
        userId: "user-old",
      }),
    );
    await database.models.insights.append(
      event("event-c", 200, {
        installId: "install-a",
        userId: "user-current",
      }),
    );
    await database.models.insights.append(
      event("event-d", 150, {
        installId: "install-b",
        userId: "user-current",
      }),
    );
    await database.models.insights.append(
      event("event-e", 149, { installId: "install-c" }),
    );
    await expect(
      database.models.insights.getInstallation("install-a"),
    ).resolves.toMatchObject({ id: "event-c", user_id: "user-current" });
    await expect(
      database.models.insights.pageInstallationsByCurrentUserId({
        userId: "user-old",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      database.models.insights.pageInstallationsByCurrentUserId({
        userId: "user-current",
        limit: 10,
      }),
    ).resolves.toMatchObject([
      { install_id: "install-a" },
      { install_id: "install-b" },
    ]);
    await expect(
      database.models.insights.countActiveInstallations({ sinceMs: 150 }),
    ).resolves.toBe(2);
  });
});
