import type { BundleEventRow } from "@hot-updater/plugin-core";
import { expect, vi } from "vitest";

import { createInMemoryDatabaseAdapter } from "../../../test-utils/test/inMemoryDatabaseAdapter";
import { BUNDLE_EVENT_SCAN_PAGE_SIZE } from "./bundleEventScan";

export const createEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: Partial<
    Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }>
  > = {},
): Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }> => ({
  id: `${installId}-${receivedAtMs}`,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: "old-bundle",
  to_bundle_id: "bundle-a",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "1",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

export const createRecoveredEvent = (
  installId: string,
  receivedAtMs: number,
): Extract<BundleEventRow, { readonly type: "RECOVERED" }> => ({
  ...createEvent(installId, receivedAtMs),
  type: "RECOVERED",
  from_bundle_id: "bundle-a",
  to_bundle_id: "fallback-bundle",
  cohort: "1",
});

export const insertRows = async (rows: readonly BundleEventRow[]) => {
  const database = createInMemoryDatabaseAdapter();
  await Promise.all(
    rows.map((data) => database.create({ model: "bundle_events", data })),
  );
  return database;
};

export const expectSingleMaterialization = (
  findMany: ReturnType<typeof vi.fn>,
): void => {
  expect(findMany).toHaveBeenCalledOnce();
  expect(findMany.mock.calls[0]?.[0]).toMatchObject({
    model: "bundle_events",
    limit: BUNDLE_EVENT_SCAN_PAGE_SIZE,
    offset: 0,
    orderBy: [
      { field: "received_at_ms", direction: "asc" },
      { field: "id", direction: "asc" },
    ],
  });
};
