import type { Bundle, BundlePatchArtifact, Platform } from "@hot-updater/core";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  BundleEventFindManyQuery,
  BundleEventPayload,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundlePatchUpdate,
  DatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import {
  toBundleReadModel,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";

import { parseBundleMetadata } from "./updateArtifacts";

export type BundleRow = {
  readonly id: string;
  readonly platform: string;
  readonly should_force_update: unknown;
  readonly enabled: unknown;
  readonly file_hash: string;
  readonly git_commit_hash: string | null;
  readonly message: string | null;
  readonly channel: string;
  readonly storage_uri: string;
  readonly target_app_version: string | null;
  readonly fingerprint_hash: string | null;
  readonly metadata?: unknown;
  readonly manifest_storage_uri?: string | null;
  readonly manifest_file_hash?: string | null;
  readonly asset_base_storage_uri?: string | null;
  readonly rollout_cohort_count?: number | null;
  readonly target_cohorts?: unknown;
};

export type BundlePatchRow = {
  readonly id: string;
  readonly bundle_id: string;
  readonly base_bundle_id: string;
  readonly base_file_hash: string;
  readonly patch_file_hash: string;
  readonly patch_storage_uri: string;
  readonly order_index?: number | null;
};

export type BundleEventRow = {
  readonly id: string;
  readonly kind: string;
  readonly install_id: string;
  readonly active_bundle_id: string;
  readonly previous_active_bundle_id: string | null;
  readonly crashed_bundle_id: string | null;
  readonly platform: string;
  readonly channel: string;
  readonly app_version: string | null;
  readonly fingerprint_hash: string | null;
  readonly cohort: string | null;
  readonly user_id: string | null;
  readonly payload: unknown;
};

const parseTargetCohorts = (value: unknown): string[] | null => {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : null;
  } catch {
    return null;
  }
};

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

export const bundleToRow = (bundle: Bundle): BundleRow => ({
  id: bundle.id,
  platform: bundle.platform,
  should_force_update: bundle.shouldForceUpdate,
  enabled: bundle.enabled,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  channel: bundle.channel,
  storage_uri: bundle.storageUri,
  target_app_version: bundle.targetAppVersion,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
});

export const bundleRecordToRow = (bundle: DatabaseBundleRecord): BundleRow =>
  bundleToRow(toBundleReadModel(bundle));

export const bundleToPatchRows = (bundle: Bundle): BundlePatchRow[] =>
  getBundlePatches(bundle).map((patch, index) => ({
    id: buildBundlePatchId(bundle.id, patch.baseBundleId),
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: index,
  }));

export const databaseBundlePatchToRow = (
  patch: DatabaseBundlePatch,
): BundlePatchRow => ({
  id: patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId),
  bundle_id: patch.bundleId,
  base_bundle_id: patch.baseBundleId,
  base_file_hash: patch.baseFileHash,
  patch_file_hash: patch.patchFileHash,
  patch_storage_uri: patch.patchStorageUri,
  order_index: patch.orderIndex,
});

export const databaseBundlePatchUpdateToRow = (
  patch: DatabaseBundlePatchUpdate,
): Partial<BundlePatchRow> => ({
  ...(patch.baseFileHash !== undefined
    ? { base_file_hash: patch.baseFileHash }
    : {}),
  ...(patch.patchFileHash !== undefined
    ? { patch_file_hash: patch.patchFileHash }
    : {}),
  ...(patch.patchStorageUri !== undefined
    ? { patch_storage_uri: patch.patchStorageUri }
    : {}),
  ...(patch.orderIndex !== undefined ? { order_index: patch.orderIndex } : {}),
});

const mapPatchRowToPatch = (record: BundlePatchRow): BundlePatchArtifact => ({
  baseBundleId: record.base_bundle_id,
  baseFileHash: record.base_file_hash,
  patchFileHash: record.patch_file_hash,
  patchStorageUri: record.patch_storage_uri,
});

export const rowToDatabaseBundlePatch = (
  record: BundlePatchRow,
): DatabaseBundlePatch => ({
  id: record.id,
  bundleId: record.bundle_id,
  baseBundleId: record.base_bundle_id,
  baseFileHash: record.base_file_hash,
  patchFileHash: record.patch_file_hash,
  patchStorageUri: record.patch_storage_uri,
  orderIndex: record.order_index ?? 0,
});

const isAppReadyPayload = (value: unknown): value is BundleEventPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<Record<keyof BundleEventPayload, unknown>>;
  return (
    (payload.status === "STABLE" || payload.status === "RECOVERED") &&
    typeof payload.sdkVersion === "string" &&
    typeof payload.defaultChannel === "string" &&
    typeof payload.isChannelSwitched === "boolean"
  );
};

const parseEventPayload = (value: unknown): BundleEventPayload => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isAppReadyPayload(parsed)) {
    throw new Error("Invalid bundle event payload.");
  }
  return parsed;
};

export const rowToDatabaseBundleEvent = (
  record: BundleEventRow,
): DatabaseBundleEvent => {
  if (record.kind !== "APP_READY") {
    throw new Error(`Unsupported bundle event kind: ${record.kind}`);
  }
  return {
    id: record.id,
    kind: record.kind,
    installId: record.install_id,
    activeBundleId: record.active_bundle_id,
    previousActiveBundleId: record.previous_active_bundle_id,
    crashedBundleId: record.crashed_bundle_id,
    platform: record.platform as Platform,
    channel: record.channel,
    appVersion: record.app_version,
    fingerprintHash: record.fingerprint_hash,
    cohort: record.cohort,
    userId: record.user_id,
    payload: parseEventPayload(record.payload),
  };
};

export const databaseBundleEventToRow = (
  event: DatabaseBundleEvent,
): BundleEventRow => ({
  id: event.id,
  kind: event.kind,
  install_id: event.installId,
  active_bundle_id: event.activeBundleId,
  previous_active_bundle_id: event.previousActiveBundleId ?? null,
  crashed_bundle_id: event.crashedBundleId ?? null,
  platform: event.platform,
  channel: event.channel,
  app_version: event.appVersion ?? null,
  fingerprint_hash: event.fingerprintHash ?? null,
  cohort: event.cohort ?? null,
  user_id: event.userId ?? null,
  payload: event.payload,
});

export const bundleEventMatchesWhere = (
  event: DatabaseBundleEvent,
  where: BundleEventFindManyQuery["where"] | undefined,
) =>
  !where ||
  ((where.kind === undefined || event.kind === where.kind) &&
    (where.installId === undefined || event.installId === where.installId) &&
    (where.activeBundleId === undefined ||
      event.activeBundleId === where.activeBundleId) &&
    (where.previousActiveBundleId === undefined ||
      event.previousActiveBundleId === where.previousActiveBundleId) &&
    (where.crashedBundleId === undefined ||
      event.crashedBundleId === where.crashedBundleId) &&
    (where.platform === undefined || event.platform === where.platform) &&
    (where.channel === undefined || event.channel === where.channel) &&
    (where.appVersion === undefined || event.appVersion === where.appVersion) &&
    (where.fingerprintHash === undefined ||
      event.fingerprintHash === where.fingerprintHash) &&
    (where.cohort === undefined || event.cohort === where.cohort) &&
    (where.userId === undefined || event.userId === where.userId));

export const rowToBundle = (
  record: BundleRow,
  patchRecords: readonly BundlePatchRow[] = [],
): Bundle => {
  const patches = patchRecords
    .slice()
    .sort(
      (left, right) =>
        (left.order_index ?? 0) - (right.order_index ?? 0) ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map(mapPatchRowToPatch);
  const primaryPatch = patches[0] ?? null;

  return {
    id: record.id,
    platform: record.platform as Platform,
    shouldForceUpdate: Boolean(record.should_force_update),
    enabled: Boolean(record.enabled),
    fileHash: record.file_hash,
    gitCommitHash: record.git_commit_hash ?? null,
    message: record.message ?? null,
    channel: record.channel,
    storageUri: record.storage_uri,
    targetAppVersion: record.target_app_version ?? null,
    fingerprintHash: record.fingerprint_hash ?? null,
    metadata: parseBundleMetadata(record.metadata),
    manifestStorageUri: record.manifest_storage_uri ?? null,
    manifestFileHash: record.manifest_file_hash ?? null,
    assetBaseStorageUri: record.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount:
      record.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: parseTargetCohorts(record.target_cohorts),
  };
};

export const rowToDatabaseBundleRecord = (
  record: BundleRow,
): DatabaseBundleRecord => toDatabaseBundleRecord(rowToBundle(record, []));
