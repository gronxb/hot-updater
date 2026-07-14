import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseModel,
} from "@hot-updater/plugin-core";

import type { PrismaQuery } from "./prismaQuery";

export type PrismaDelegate = {
  readonly count: (args?: PrismaQuery) => Promise<number>;
  readonly create: (args: PrismaQuery) => Promise<unknown>;
  readonly deleteMany: (args?: PrismaQuery) => Promise<unknown>;
  readonly findFirst: (args?: PrismaQuery) => Promise<unknown>;
  readonly findMany: (args?: PrismaQuery) => Promise<readonly unknown[]>;
  readonly update: (args: PrismaQuery) => Promise<unknown>;
  readonly updateMany?: (args: PrismaQuery) => Promise<unknown>;
};

export class PrismaAdapterError extends Error {
  readonly name = "PrismaAdapterError";

  constructor(readonly reason: string) {
    super(`Invalid Prisma adapter state: ${reason}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasDelegateMethods = (value: unknown): value is PrismaDelegate =>
  isRecord(value) &&
  typeof value["count"] === "function" &&
  typeof value["create"] === "function" &&
  typeof value["deleteMany"] === "function" &&
  typeof value["findFirst"] === "function" &&
  typeof value["findMany"] === "function" &&
  typeof value["update"] === "function";

export const getPrismaDelegate = (
  client: object,
  model: DatabaseModel,
): PrismaDelegate => {
  const delegate = Object.entries(client).find(([key]) => key === model)?.[1];
  if (delegate === undefined)
    throw new PrismaAdapterError(`missing model delegate "${model}"`);
  if (!hasDelegateMethods(delegate)) {
    throw new PrismaAdapterError(`invalid model delegate "${model}"`);
  }
  return delegate;
};

const readString = (row: Record<string, unknown>, field: string): string => {
  const value = row[field];
  if (typeof value !== "string") {
    throw new PrismaAdapterError(`expected string field "${field}"`);
  }
  return value;
};

const readNullableString = (
  row: Record<string, unknown>,
  field: string,
): string | null => {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new PrismaAdapterError(`expected nullable string field "${field}"`);
  }
  return value;
};

export const parsePrismaBundleRow = (value: unknown): BundleRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid bundle row");
  const platform = value["platform"];
  if (platform !== "android" && platform !== "ios") {
    throw new PrismaAdapterError('expected platform "android" or "ios"');
  }
  const shouldForceUpdate = value["should_force_update"];
  const enabled = value["enabled"];
  const rolloutCohortCount = value["rollout_cohort_count"];
  if (
    typeof shouldForceUpdate !== "boolean" ||
    typeof enabled !== "boolean" ||
    typeof rolloutCohortCount !== "number"
  ) {
    throw new PrismaAdapterError("invalid bundle scalar fields");
  }
  const targetCohorts = value["target_cohorts"];
  if (
    targetCohorts !== null &&
    (!Array.isArray(targetCohorts) ||
      !targetCohorts.every((item) => typeof item === "string"))
  ) {
    throw new PrismaAdapterError("invalid target_cohorts field");
  }
  return {
    id: readString(value, "id"),
    platform,
    should_force_update: shouldForceUpdate,
    enabled,
    file_hash: readString(value, "file_hash"),
    git_commit_hash: readNullableString(value, "git_commit_hash"),
    message: readNullableString(value, "message"),
    channel: readString(value, "channel"),
    channel_id: readString(value, "channel_id"),
    storage_uri: readString(value, "storage_uri"),
    target_app_version: readNullableString(value, "target_app_version"),
    fingerprint_hash: readNullableString(value, "fingerprint_hash"),
    metadata: value["metadata"],
    rollout_cohort_count: rolloutCohortCount,
    target_cohorts: targetCohorts,
    manifest_storage_uri: readNullableString(value, "manifest_storage_uri"),
    manifest_file_hash: readNullableString(value, "manifest_file_hash"),
    asset_base_storage_uri: readNullableString(value, "asset_base_storage_uri"),
  };
};

export const parsePrismaPatchRow = (value: unknown): BundlePatchRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid patch row");
  const orderIndex = value["order_index"];
  if (typeof orderIndex !== "number") {
    throw new PrismaAdapterError("invalid patch order_index field");
  }
  return {
    id: readString(value, "id"),
    bundle_id: readString(value, "bundle_id"),
    base_bundle_id: readString(value, "base_bundle_id"),
    base_file_hash: readString(value, "base_file_hash"),
    patch_file_hash: readString(value, "patch_file_hash"),
    patch_storage_uri: readString(value, "patch_storage_uri"),
    order_index: orderIndex,
  };
};

export const parsePrismaChannelRow = (value: unknown): ChannelRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid channel row");
  return { id: readString(value, "id"), name: readString(value, "name") };
};

export const parsePrismaBundleEventRow = (value: unknown): BundleEventRow => {
  if (!isRecord(value)) {
    throw new PrismaAdapterError("invalid bundle event row");
  }
  const type = readString(value, "type");
  const platform = readString(value, "platform");
  const updateStrategy = readString(value, "update_strategy");
  const receivedAtMs = value["received_at_ms"];
  if (type !== "UPDATE_APPLIED" && type !== "RECOVERED") {
    throw new PrismaAdapterError("invalid bundle event type");
  }
  if (platform !== "android" && platform !== "ios") {
    throw new PrismaAdapterError("invalid bundle event platform");
  }
  if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
    throw new PrismaAdapterError("invalid bundle event strategy");
  }
  if (typeof receivedAtMs !== "number") {
    throw new PrismaAdapterError("invalid bundle event timestamp");
  }
  return {
    id: readString(value, "id"),
    type,
    install_id: readString(value, "install_id"),
    user_id: readNullableString(value, "user_id"),
    username: readNullableString(value, "username"),
    from_bundle_id: readString(value, "from_bundle_id"),
    to_bundle_id: readString(value, "to_bundle_id"),
    platform,
    app_version: readString(value, "app_version"),
    channel: readString(value, "channel"),
    cohort: readString(value, "cohort"),
    update_strategy: updateStrategy,
    fingerprint_hash: readNullableString(value, "fingerprint_hash"),
    sdk_version: readNullableString(value, "sdk_version"),
    received_at_ms: receivedAtMs,
  };
};

export const parsePrismaRows = <TRow>(
  rows: readonly unknown[],
  parse: (value: unknown) => TRow,
): TRow[] => rows.map(parse);
