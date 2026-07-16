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
});
