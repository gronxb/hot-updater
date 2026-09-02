import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { isDatabaseMetadataObject } from "@hot-updater/plugin-core";
import type { DatabaseModel } from "@hot-updater/plugin-core/internal";

import type { PrismaQuery } from "./prismaQuery";

export type PrismaDelegate = {
  readonly count: (args?: PrismaQuery) => Promise<number>;
  readonly create: (args: PrismaQuery) => Promise<unknown>;
  readonly deleteMany: (args?: PrismaQuery) => Promise<unknown>;
  readonly findFirst: (args?: PrismaQuery) => Promise<unknown>;
  readonly findMany: (args?: PrismaQuery) => Promise<readonly unknown[]>;
  readonly update: (args: PrismaQuery) => Promise<unknown>;
  readonly updateMany?: (args: PrismaQuery) => Promise<unknown>;
  readonly upsert: (args: PrismaQuery) => Promise<unknown>;
};

export class PrismaAdapterError extends Error {
  readonly name = "PrismaAdapterError";

  constructor(readonly reason: string) {
    super(`Invalid Prisma plugin state: ${reason}`);
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
  typeof value["update"] === "function" &&
  typeof value["upsert"] === "function";

const modelDelegates = {
  bundles: "bundles",
  bundle_patches: "bundle_patches",
  channels: "channels",
  api_keys: "api_keys",
  releases: "releases",
  release_catalogs: "release_catalogs",
} as const satisfies Record<DatabaseModel, string>;

export const prismaBundleEventFields = [
  "id",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_bundle_id",
  "from_release_id",
  "to_release_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
  "received_at_ms",
] as const satisfies readonly (keyof BundleEventRow)[];

const getNamedPrismaDelegate = (
  client: object,
  model: string,
): PrismaDelegate => {
  const delegate = Object.entries(client).find(([key]) => key === model)?.[1];
  if (delegate === undefined)
    throw new PrismaAdapterError(`missing model delegate "${model}"`);
  if (!hasDelegateMethods(delegate)) {
    throw new PrismaAdapterError(`invalid model delegate "${model}"`);
  }
  return delegate;
};

export const getPrismaDelegate = (
  client: object,
  model: DatabaseModel,
): PrismaDelegate => {
  return getNamedPrismaDelegate(client, modelDelegates[model]);
};

export const getPrismaBundleEventDelegate = (client: object): PrismaDelegate =>
  getNamedPrismaDelegate(client, "bundle_events");

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

const readByteSize = (row: Record<string, unknown>, field: string): number => {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PrismaAdapterError(`expected byte-size field "${field}"`);
  }
  return value;
};

export const parsePrismaBundleRow = (value: unknown): BundleRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid bundle row");
  const platform = value["platform"];
  if (platform !== "android" && platform !== "ios") {
    throw new PrismaAdapterError('expected platform "android" or "ios"');
  }
  const metadata = value["metadata"];
  if (!isDatabaseMetadataObject(metadata)) {
    throw new PrismaAdapterError("invalid metadata field");
  }
  return {
    id: readString(value, "id"),
    platform,
    file_hash: readString(value, "file_hash"),
    git_commit_hash: readNullableString(value, "git_commit_hash"),
    storage_uri: readString(value, "storage_uri"),
    archive_byte_size: readByteSize(value, "archive_byte_size"),
    metadata,
    manifest_storage_uri: readNullableString(value, "manifest_storage_uri"),
    manifest_file_hash: readNullableString(value, "manifest_file_hash"),
    asset_base_storage_uri: readNullableString(value, "asset_base_storage_uri"),
  };
};

export const parsePrismaChannelRow = (value: unknown): ChannelRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid channel row");
  return {
    id: readString(value, "id"),
    name: readString(value, "name"),
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
    byte_size: readByteSize(value, "byte_size"),
    order_index: orderIndex,
  };
};

const readNumber = (row: Record<string, unknown>, field: string): number => {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PrismaAdapterError(`expected number field "${field}"`);
  }
  return value;
};

export const parsePrismaBundleEventRow = (value: unknown): BundleEventRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid event row");
  const type = readString(value, "type");
  const platform = readString(value, "platform");
  const fromBundleId = readNullableString(value, "from_bundle_id");
  const updateStrategy = readNullableString(value, "update_strategy");
  if (
    (platform !== "ios" && platform !== "android") ||
    !(
      ((type === "UPDATE_APPLIED" ||
        type === "RECOVERED" ||
        type === "RELEASE_ADOPTED") &&
        typeof fromBundleId === "string" &&
        (updateStrategy === "fingerprint" ||
          updateStrategy === "appVersion")) ||
      (type === "UNCHANGED" && fromBundleId === null && updateStrategy === null)
    )
  ) {
    throw new PrismaAdapterError("invalid event shape");
  }
  return {
    id: readString(value, "id"),
    type,
    install_id: readString(value, "install_id"),
    user_id: readNullableString(value, "user_id"),
    username: readNullableString(value, "username"),
    from_release_id: readNullableString(value, "from_release_id"),
    from_bundle_id: fromBundleId,
    to_release_id: readNullableString(value, "to_release_id"),
    to_bundle_id: readString(value, "to_bundle_id"),
    platform,
    app_version: readString(value, "app_version"),
    channel: readString(value, "channel"),
    cohort: readString(value, "cohort"),
    update_strategy: updateStrategy,
    fingerprint_hash: readNullableString(value, "fingerprint_hash"),
    sdk_version: readNullableString(value, "sdk_version"),
    received_at_ms: readNumber(value, "received_at_ms"),
  } as BundleEventRow;
};

export const parsePrismaApiKeyRow = (value: unknown): ApiKeyRow => {
  if (!isRecord(value)) {
    throw new PrismaAdapterError("invalid API key row");
  }
  const role = readString(value, "role");
  if (role !== "client") {
    throw new PrismaAdapterError("invalid API key role");
  }
  const revokedAt = value["revoked_at_ms"];
  return {
    id: readString(value, "id"),
    hash: readString(value, "hash"),
    name: readString(value, "name"),
    prefix: readString(value, "prefix"),
    role,
    created_at_ms: readNumber(value, "created_at_ms"),
    revoked_at_ms:
      revokedAt === null ? null : readNumber(value, "revoked_at_ms"),
  };
};

export const parsePrismaReleaseRow = (value: unknown): ReleaseRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid Release row");
  const platform = readString(value, "platform");
  const kind = readString(value, "kind");
  const strategy = readString(value, "strategy");
  const operation = readString(value, "operation");
  const targetCohorts = value["target_cohorts"];
  if (
    (platform !== "ios" && platform !== "android") ||
    (kind !== "BUNDLE" && kind !== "EMBEDDED") ||
    (strategy !== "APP_VERSION" && strategy !== "FINGERPRINT") ||
    (operation !== "DEPLOY" &&
      operation !== "PROMOTE" &&
      operation !== "ROLLBACK") ||
    !Array.isArray(targetCohorts) ||
    !targetCohorts.every((cohort) => typeof cohort === "string")
  ) {
    throw new PrismaAdapterError("invalid Release fields");
  }
  const enabled = value["enabled"];
  const shouldForceUpdate = value["should_force_update"];
  if (typeof enabled !== "boolean" || typeof shouldForceUpdate !== "boolean") {
    throw new PrismaAdapterError("invalid Release policy fields");
  }
  return {
    bundle_id: readNullableString(value, "bundle_id"),
    channel_id: readString(value, "channel_id"),
    created_at_ms: readNumber(value, "created_at_ms"),
    enabled,
    fingerprint_hash: readNullableString(value, "fingerprint_hash"),
    id: readString(value, "id"),
    kind,
    message: readNullableString(value, "message"),
    operation,
    platform,
    revision: readNumber(value, "revision"),
    rollout_cohort_count: readNumber(value, "rollout_cohort_count"),
    scope_key: readString(value, "scope_key"),
    should_force_update: shouldForceUpdate,
    source_release_id: readNullableString(value, "source_release_id"),
    strategy,
    target_app_version: readNullableString(value, "target_app_version"),
    target_cohorts: targetCohorts,
    updated_at_ms: readNumber(value, "updated_at_ms"),
  };
};

export const parsePrismaReleaseCatalogRow = (
  value: unknown,
): ReleaseCatalogRow => {
  if (!isRecord(value)) throw new PrismaAdapterError("invalid catalog row");
  const platform = readString(value, "platform");
  const strategy = readString(value, "strategy");
  const isTombstone = value["is_tombstone"];
  if (
    (platform !== "ios" && platform !== "android") ||
    (strategy !== "APP_VERSION" && strategy !== "FINGERPRINT") ||
    typeof isTombstone !== "boolean"
  ) {
    throw new PrismaAdapterError("invalid catalog fields");
  }
  return {
    catalog_id: readString(value, "catalog_id"),
    byte_size: readNumber(value, "byte_size"),
    catalog_hash: readString(value, "catalog_hash"),
    channel_id: readString(value, "channel_id"),
    channel_key: readString(value, "channel_key"),
    fingerprint_hash: readNullableString(value, "fingerprint_hash"),
    generation: readNumber(value, "generation"),
    is_tombstone: isTombstone,
    payload: readString(value, "payload"),
    platform,
    scope_key: readString(value, "scope_key"),
    strategy,
    updated_at_ms: readNumber(value, "updated_at_ms"),
  };
};

export const parsePrismaRows = <TRow>(
  rows: readonly unknown[],
  parse: (value: unknown) => TRow,
): TRow[] => rows.map(parse);
