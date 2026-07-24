import type { BundleEventRow } from "@hot-updater/plugin-core";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";

export const ACTIVE_AS_OF_MS = Date.UTC(2026, 6, 17, 12, 30);
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

type TransitionEventOverrides = Partial<
  Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }>
>;

type RecoveredEventOverrides = Partial<
  Extract<BundleEventRow, { readonly type: "RECOVERED" }>
>;

type UnchangedEventOverrides = Partial<
  Extract<BundleEventRow, { readonly type: "UNCHANGED" }>
>;

export const createActiveTransitionEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: TransitionEventOverrides = {},
): BundleEventRow => ({
  id: `${installId}-${receivedAtMs}`,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: "bundle-old",
  to_bundle_id: "bundle-current",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

export const createUnchangedEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: UnchangedEventOverrides = {},
): BundleEventRow => ({
  id: `${installId}-${receivedAtMs}`,
  type: "UNCHANGED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: null,
  to_bundle_id: "bundle-current",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

export const createActiveRecoveredEvent = (
  installId: string,
  receivedAtMs: number,
  overrides: RecoveredEventOverrides = {},
): BundleEventRow => ({
  id: `${installId}-${receivedAtMs}`,
  type: "RECOVERED",
  install_id: installId,
  user_id: `user-${installId}`,
  username: `name-${installId}`,
  from_bundle_id: "bundle-failed",
  to_bundle_id: "bundle-current",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
  ...overrides,
});

export const insertActiveRows = async (rows: readonly BundleEventRow[]) => {
  const database = createInMemoryDatabasePlugin();
  await Promise.all(
    rows.map((data) => database.create({ model: "bundle_events", data })),
  );
  return database;
};
