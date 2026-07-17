import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";

import {
  boolean,
  nullableString,
  number,
  platform,
  property,
  record,
  string,
  stringArray,
} from "./firebaseDatabaseParserShared";
export {
  FirebaseDatabaseDataError,
  hasFirebaseProperty,
  property,
} from "./firebaseDatabaseParserShared";
export { parseFirebaseBundleEventRow } from "./firebaseBundleEventParser";

export const parseFirebaseBundleRow = (
  value: unknown,
  source: string,
): BundleRow => {
  const input = record(value, source);
  return parseFirebaseBundleInput(
    input,
    string(property(input, "channel_id"), source),
    source,
  );
};

const parseFirebaseBundleInput = (
  input: object,
  channelId: string,
  source: string,
): BundleRow => {
  const channel = property(input, "channel");
  return {
    id: string(property(input, "id"), source),
    platform: platform(property(input, "platform"), source),
    should_force_update: boolean(
      property(input, "should_force_update"),
      source,
    ),
    enabled: boolean(property(input, "enabled"), source),
    file_hash: string(property(input, "file_hash"), source),
    git_commit_hash: nullableString(property(input, "git_commit_hash"), source),
    message: nullableString(property(input, "message"), source),
    channel: typeof channel === "string" ? channel : channelId,
    channel_id: channelId,
    storage_uri: string(property(input, "storage_uri"), source),
    target_app_version: nullableString(
      property(input, "target_app_version"),
      source,
    ),
    fingerprint_hash: nullableString(
      property(input, "fingerprint_hash"),
      source,
    ),
    metadata: property(input, "metadata") ?? {},
    rollout_cohort_count:
      property(input, "rollout_cohort_count") === undefined
        ? 1000
        : number(property(input, "rollout_cohort_count"), source),
    target_cohorts: stringArray(property(input, "target_cohorts"), source),
    manifest_storage_uri: nullableString(
      property(input, "manifest_storage_uri"),
      source,
    ),
    manifest_file_hash: nullableString(
      property(input, "manifest_file_hash"),
      source,
    ),
    asset_base_storage_uri: nullableString(
      property(input, "asset_base_storage_uri"),
      source,
    ),
  };
};

export const parseFirebaseMigratingBundleRow = (
  value: unknown,
  source: string,
): BundleRow => {
  const input = record(value, source);
  const channelId = property(input, "channel_id");
  return parseFirebaseBundleInput(
    input,
    typeof channelId === "string"
      ? channelId
      : string(property(input, "channel"), source),
    source,
  );
};

export const parseFirebasePatchRow = (
  value: unknown,
  source: string,
): BundlePatchRow => {
  const input = record(value, source);
  return {
    id: string(property(input, "id"), source),
    bundle_id: string(property(input, "bundle_id"), source),
    base_bundle_id: string(property(input, "base_bundle_id"), source),
    base_file_hash: string(property(input, "base_file_hash"), source),
    patch_file_hash: string(property(input, "patch_file_hash"), source),
    patch_storage_uri: string(property(input, "patch_storage_uri"), source),
    order_index: number(property(input, "order_index"), source),
  };
};

export const parseFirebaseChannelRow = (
  value: unknown,
  documentId: string,
): ChannelRow => {
  const input = record(value, `channels/${documentId}`);
  return {
    id: string(property(input, "id"), `channels/${documentId}`),
    name: string(property(input, "name"), `channels/${documentId}`),
  };
};

export const parseFirebaseMigratingChannelRow = (
  value: unknown,
  documentId: string,
): ChannelRow => {
  const source = `channels/${documentId}`;
  const input = record(value, source);
  const id = property(input, "id");
  const normalizedId = typeof id === "string" ? id : documentId;
  const name = property(input, "name");
  return {
    id: normalizedId,
    name: typeof name === "string" ? name : normalizedId,
  };
};

type LegacyPatchInput = {
  readonly value: unknown;
  readonly bundleId: string;
  readonly orderIndex: number;
  readonly source: string;
};

const parseLegacyPatch = ({
  value,
  bundleId,
  orderIndex,
  source,
}: LegacyPatchInput): BundlePatchRow => {
  const input = record(value, source);
  const baseBundleId = string(property(input, "baseBundleId"), source);
  return {
    id: `${bundleId}:${baseBundleId}`,
    bundle_id: bundleId,
    base_bundle_id: baseBundleId,
    base_file_hash: string(property(input, "baseFileHash"), source),
    patch_file_hash: string(property(input, "patchFileHash"), source),
    patch_storage_uri: string(property(input, "patchStorageUri"), source),
    order_index: orderIndex,
  };
};

export const parseFirebaseLegacyPatchRows = (
  value: unknown,
  bundleId: string,
  source: string,
): readonly BundlePatchRow[] => {
  const input = record(value, source);
  const patches = property(input, "patches");
  if (Array.isArray(patches)) {
    return patches.map((patch, index) =>
      parseLegacyPatch({ value: patch, bundleId, orderIndex: index, source }),
    );
  }
  const baseBundleId = property(input, "patch_base_bundle_id");
  if (baseBundleId === null || baseBundleId === undefined) return [];
  return [
    {
      id: `${bundleId}:${string(baseBundleId, source)}`,
      bundle_id: bundleId,
      base_bundle_id: string(baseBundleId, source),
      base_file_hash: string(property(input, "patch_base_file_hash"), source),
      patch_file_hash: string(property(input, "patch_file_hash"), source),
      patch_storage_uri: string(property(input, "patch_storage_uri"), source),
      order_index: 0,
    },
  ];
};
