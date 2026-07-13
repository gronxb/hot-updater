import type { Bundle, BundlePatchArtifact } from "@hot-updater/core";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";

import type { BundlePatchRow, BundleRow, ChannelRow } from "./types";

export const BundleRowHydrationErrorReason = {
  duplicatePatchId: "duplicate_patch_id",
  orphanPatchOwner: "orphan_patch_owner",
  orphanPatchBase: "orphan_patch_base",
} as const;

export type BundleRowHydrationErrorReason =
  (typeof BundleRowHydrationErrorReason)[keyof typeof BundleRowHydrationErrorReason];

type BundleRowHydrationErrorInput = {
  readonly reason: BundleRowHydrationErrorReason;
  readonly patchId: string;
  readonly bundleId: string;
};

export class BundleRowHydrationError extends Error {
  readonly name = "BundleRowHydrationError";
  readonly reason: BundleRowHydrationErrorReason;
  readonly patchId: string;
  readonly bundleId: string;

  constructor({ reason, patchId, bundleId }: BundleRowHydrationErrorInput) {
    super(
      `Cannot hydrate bundle rows: ${reason} for patch "${patchId}" and bundle "${bundleId}".`,
    );
    this.reason = reason;
    this.patchId = patchId;
    this.bundleId = bundleId;
  }
}

export class BundleChannelNotFoundError extends Error {
  readonly name = "BundleChannelNotFoundError";

  constructor(
    readonly bundleId: string,
    readonly channelId: string,
  ) {
    super(`Channel "${channelId}" for bundle "${bundleId}" was not found.`);
  }
}

const isBundleMetadata = (
  value: unknown,
): value is NonNullable<Bundle["metadata"]> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return !(
    "app_version" in value &&
    value.app_version !== undefined &&
    typeof value.app_version !== "string"
  );
};

const parseBundleMetadata = (
  value: unknown,
): Bundle["metadata"] | undefined => {
  if (!value) return undefined;
  if (typeof value !== "string") {
    return isBundleMetadata(value)
      ? stripBundleArtifactMetadata(value)
      : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isBundleMetadata(parsed)
      ? stripBundleArtifactMetadata(parsed)
      : undefined;
  } catch {
    return undefined;
  }
};

const parseTargetCohorts = (value: unknown): string[] | null => {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : null;
  } catch {
    return null;
  }
};

export const bundleToRow = (bundle: Bundle, channelId: string): BundleRow => ({
  id: bundle.id,
  platform: bundle.platform,
  should_force_update: bundle.shouldForceUpdate,
  enabled: bundle.enabled,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  channel: bundle.channel,
  channel_id: channelId,
  storage_uri: bundle.storageUri,
  target_app_version: bundle.targetAppVersion,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
});

export const bundleToPatchRows = (bundle: Bundle): BundlePatchRow[] =>
  getBundlePatches(bundle).map((patch, orderIndex) => ({
    id: `${bundle.id}:${patch.baseBundleId}`,
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: orderIndex,
  }));

const comparePatchRows = (left: BundlePatchRow, right: BundlePatchRow) =>
  left.order_index - right.order_index || left.id.localeCompare(right.id);

const patchRowToArtifact = (row: BundlePatchRow): BundlePatchArtifact => ({
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
});

export const rowToBundle = (
  row: BundleRow,
  channelName: string,
  patchRows: readonly BundlePatchRow[] = [],
): Bundle => {
  const patches = patchRows
    .slice()
    .sort(comparePatchRows)
    .map(patchRowToArtifact);
  const primaryPatch = patches[0] ?? null;
  return {
    id: row.id,
    platform: row.platform,
    shouldForceUpdate: row.should_force_update,
    enabled: row.enabled,
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash ?? null,
    message: row.message ?? null,
    channel: channelName,
    storageUri: row.storage_uri,
    targetAppVersion: row.target_app_version ?? null,
    fingerprintHash: row.fingerprint_hash ?? null,
    metadata: parseBundleMetadata(row.metadata),
    rolloutCohortCount:
      row.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: parseTargetCohorts(row.target_cohorts),
    manifestStorageUri: row.manifest_storage_uri ?? null,
    manifestFileHash: row.manifest_file_hash ?? null,
    assetBaseStorageUri: row.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
  };
};

export const rowsToBundles = (
  bundleRows: readonly BundleRow[],
  patchRows: readonly BundlePatchRow[],
  referencedBundleRows: readonly BundleRow[],
  channelRows: readonly ChannelRow[],
): Bundle[] => {
  const ownerIds = new Set(bundleRows.map(({ id }) => id));
  const baseIds = new Set(ownerIds);
  for (const row of referencedBundleRows) baseIds.add(row.id);

  const patchIds = new Set<string>();
  const patchesByOwner = new Map<string, BundlePatchRow[]>();
  for (const patch of patchRows) {
    if (patchIds.has(patch.id)) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.duplicatePatchId,
        patchId: patch.id,
        bundleId: patch.bundle_id,
      });
    }
    patchIds.add(patch.id);
    if (!ownerIds.has(patch.bundle_id)) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.orphanPatchOwner,
        patchId: patch.id,
        bundleId: patch.bundle_id,
      });
    }
    if (!baseIds.has(patch.base_bundle_id)) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.orphanPatchBase,
        patchId: patch.id,
        bundleId: patch.base_bundle_id,
      });
    }
    const ownerPatches = patchesByOwner.get(patch.bundle_id) ?? [];
    ownerPatches.push(patch);
    patchesByOwner.set(patch.bundle_id, ownerPatches);
  }

  const channelsById = new Map(channelRows.map((row) => [row.id, row.name]));
  return bundleRows.map((row) => {
    const channelName = channelsById.get(row.channel_id);
    if (channelName === undefined) {
      throw new BundleChannelNotFoundError(row.id, row.channel_id);
    }
    return rowToBundle(row, channelName, patchesByOwner.get(row.id) ?? []);
  });
};
