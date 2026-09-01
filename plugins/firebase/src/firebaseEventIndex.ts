import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsInstallationIdentityMatch,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";

export const FIREBASE_INSIGHTS_LAYOUT_VERSION = 2;
export const FIREBASE_INSIGHTS_PAGE_SHARDS = 16;
export const FIREBASE_INSIGHTS_SOURCE_SHARDS = 64;
export const FIREBASE_INSIGHTS_EVENT_BYTES = INSIGHTS_EVENT_MAX_BYTES;
export const FIREBASE_INSIGHTS_RESPONSE_BYTES = INSIGHTS_PAGE_MAX_BYTES;
export const FIREBASE_INSIGHTS_CANDIDATE_BYTES =
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES;
export const FIREBASE_INSIGHTS_INDEX_REVISION =
  "firebase-insights-v2-shards-16-source-64-r3";

export const FIREBASE_INSIGHTS_SOURCE_IDS = [
  ...Array.from(
    { length: FIREBASE_INSIGHTS_SOURCE_SHARDS },
    (_, shard) => `live_${shard.toString(16).padStart(2, "0")}`,
  ),
  "legacy",
] as const;

export const isFirebaseEventId = (value: string): boolean =>
  isCanonicalInsightsEventId(value);
export const isFirebaseScopeText = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

// Hash the exact UTF-8 value; never normalize case, whitespace or Unicode.
export const firebaseEventScopeKey = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const firebaseInstallationSourceHeadId = (
  installKey: string,
  sourceId: string,
): string =>
  firebaseEventScopeKey(canonicalInsightsJson(["head", installKey, sourceId]));

export const firebaseInstallationSourceVersionId = (
  installKey: string,
  sourceId: string,
  sequence: number,
): string =>
  firebaseEventScopeKey(
    canonicalInsightsJson(["prefix", installKey, sourceId, sequence]),
  );

export const firebaseInstallationKey = (value: string): string =>
  createHash("sha256")
    .update(canonicalInsightsJson(value), "utf8")
    .digest("hex");

export const firebaseEventDocumentId = (id: string): string =>
  firebaseEventScopeKey(id);

export const firebaseEventPageShard = (id: string): number =>
  Number.parseInt(firebaseEventDocumentId(id).slice(0, 1), 16);

export const firebaseEventSourceShard = (id: string): number =>
  Number.parseInt(firebaseEventDocumentId(id).slice(0, 2), 16) &
  (FIREBASE_INSIGHTS_SOURCE_SHARDS - 1);

export const firebaseEventJsonBytes = (row: BundleEventRow): number =>
  getCanonicalInsightsJsonByteLength(row);

export const assertFirebaseInstallationIdentity = (
  expectedInstallId: string,
  documentId: string,
  actualInstallId: string,
): void => {
  try {
    assertInsightsInstallationIdentityMatch(
      {
        digestHex: firebaseInstallationKey(expectedInstallId),
        installId: expectedInstallId,
      },
      { digestHex: documentId, installId: actualInstallId },
    );
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
};

export const firebaseEventIndexFields = (row: BundleEventRow) => {
  if (
    !isFirebaseEventId(row.id) ||
    ![row.install_id, row.to_bundle_id, row.from_bundle_id].every(
      (value) => value === null || isFirebaseScopeText(value),
    )
  )
    throw new DatabasePluginInputError("invalid-data");
  return {
    _insights_layout_version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
    _insights_page_shard: firebaseEventPageShard(row.id),
    _insights_source_shard: firebaseEventSourceShard(row.id),
    _insights_install_key: firebaseEventScopeKey(row.install_id),
    _insights_to_bundle_key: firebaseEventScopeKey(row.to_bundle_id),
    _insights_from_bundle_key:
      row.from_bundle_id === null
        ? null
        : firebaseEventScopeKey(row.from_bundle_id),
  };
};

export const toFirebaseEventDocument = (
  row: BundleEventRow,
  sourceSeq?: number,
  sourceShard?: number | "legacy",
) => ({
  ...row,
  ...firebaseEventIndexFields(row),
  ...(sourceSeq === undefined ? {} : { _insights_source_seq: sourceSeq }),
  ...(sourceShard === undefined ? {} : { _insights_source_shard: sourceShard }),
});

export const assertFirebaseEventInput = (row: BundleEventRow): void => {
  try {
    assertInsightsEventContract(row);
  } catch {
    throw new DatabasePluginInputError("invalid-data");
  }
  firebaseEventIndexFields(row);
};
