import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";

export const FIREBASE_EVENT_INDEX_STATE = "insights_event_index";
export const isFirebaseEventId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const isFirebaseScopeText = (value: string): boolean =>
  !/[\uD800-\uDFFF]/u.test(value);

// Hash the exact UTF-8 value; never normalize case, whitespace or Unicode.
export const firebaseEventScopeKey = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const firebaseEventIndexFields = (row: BundleEventRow) => {
  if (
    !isFirebaseEventId(row.id) ||
    ![row.install_id, row.to_bundle_id, row.from_bundle_id].every(
      (value) => value === null || isFirebaseScopeText(value),
    )
  )
    throw new DatabasePluginInputError("invalid-data");
  return {
    _insights_install_key: firebaseEventScopeKey(row.install_id),
    _insights_to_bundle_key: firebaseEventScopeKey(row.to_bundle_id),
    _insights_from_bundle_key:
      row.from_bundle_id === null
        ? null
        : firebaseEventScopeKey(row.from_bundle_id),
  };
};

export const toFirebaseEventDocument = (row: BundleEventRow) => ({
  ...row,
  ...firebaseEventIndexFields(row),
});
