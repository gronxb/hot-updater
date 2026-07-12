import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  CountBundlesDatabaseInput,
  DatabaseSelect,
  DatabaseWhere,
  FindManyDatabaseInput,
  FindOneDatabaseInput,
  GetBundlesArgs,
  UpdateBundleDatabaseInput,
} from "@hot-updater/plugin-core";
import { databaseFields } from "@hot-updater/plugin-core";

import {
  bundleValue,
  hasOnlyKeys,
  hasValidFields,
  isBundleRow,
  isChannelRow,
  isPatchRow,
  isRecord,
  isSort,
  isWhere,
  optionalSelect,
  optionalWhere,
  type StandaloneDatabaseModel,
} from "./standaloneDatabaseValues";

type CreateBody<TData, TSelect> = {
  readonly data: TData;
  readonly select?: TSelect;
};
export type BundleCreateBody = CreateBody<BundleRow, DatabaseSelect<"bundles">>;
export type PatchCreateBody = CreateBody<
  BundlePatchRow,
  DatabaseSelect<"bundle_patches">
>;
export type ChannelCreateBody = CreateBody<
  ChannelRow,
  DatabaseSelect<"channels">
>;
export type BundleUpdateBody = Omit<
  UpdateBundleDatabaseInput<DatabaseSelect<"bundles"> | undefined>,
  "model"
>;
export type BundleCountBody = Omit<CountBundlesDatabaseInput, "model">;
export type BundleFindOneBody = Omit<
  FindOneDatabaseInput<"bundles", DatabaseSelect<"bundles"> | undefined>,
  "model"
>;
export type ChannelFindOneBody = Omit<
  FindOneDatabaseInput<"channels", DatabaseSelect<"channels"> | undefined>,
  "model"
>;
export type BundleFindManyBody = Omit<
  FindManyDatabaseInput<"bundles", DatabaseSelect<"bundles"> | undefined>,
  "model"
>;
export type PatchFindManyBody = Omit<
  FindManyDatabaseInput<
    "bundle_patches",
    DatabaseSelect<"bundle_patches"> | undefined
  >,
  "model"
>;
export type ChannelFindManyBody = Omit<
  FindManyDatabaseInput<"channels", DatabaseSelect<"channels"> | undefined>,
  "model"
>;

const isFindMany = (model: StandaloneDatabaseModel, value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where", "limit", "offset", "sortBy", "select"]) &&
  optionalWhere(model, value.where) &&
  optionalSelect(model, value.select) &&
  (value.limit === undefined ||
    (typeof value.limit === "number" &&
      Number.isInteger(value.limit) &&
      value.limit >= 0)) &&
  (value.offset === undefined ||
    (typeof value.offset === "number" &&
      Number.isInteger(value.offset) &&
      value.offset >= 0)) &&
  (value.sortBy === undefined || isSort(model, value.sortBy));

export const isBundleCreateBody = (value: unknown): value is BundleCreateBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["data", "select"]) &&
  isBundleRow(value.data) &&
  optionalSelect("bundles", value.select);
export const isPatchCreateBody = (value: unknown): value is PatchCreateBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["data", "select"]) &&
  isPatchRow(value.data) &&
  optionalSelect("bundle_patches", value.select);
export const isChannelCreateBody = (
  value: unknown,
): value is ChannelCreateBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["data", "select"]) &&
  isChannelRow(value.data) &&
  optionalSelect("channels", value.select);
export const isBundleUpdateBody = (value: unknown): value is BundleUpdateBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where", "update", "select"]) &&
  isWhere("bundles", value.where) &&
  isRecord(value.update) &&
  Object.keys(value.update).length > 0 &&
  !("id" in value.update) &&
  hasValidFields(value.update, databaseFields.bundles, bundleValue) &&
  optionalSelect("bundles", value.select);
export const isBundleCountBody = (value: unknown): value is BundleCountBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where"]) &&
  optionalWhere("bundles", value.where);
export const isBundleFindOneBody = (
  value: unknown,
): value is BundleFindOneBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where", "select"]) &&
  optionalWhere("bundles", value.where) &&
  optionalSelect("bundles", value.select);
export const isChannelFindOneBody = (
  value: unknown,
): value is ChannelFindOneBody =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where", "select"]) &&
  optionalWhere("channels", value.where) &&
  optionalSelect("channels", value.select);
export const isBundleFindManyBody = (
  value: unknown,
): value is BundleFindManyBody => isFindMany("bundles", value);
export const isPatchFindManyBody = (
  value: unknown,
): value is PatchFindManyBody => isFindMany("bundle_patches", value);
export const isChannelFindManyBody = (
  value: unknown,
): value is ChannelFindManyBody => isFindMany("channels", value);
export const isBundleDeleteBody = (
  value: unknown,
): value is { readonly where: readonly DatabaseWhere<"bundles">[] } =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where"]) &&
  isWhere("bundles", value.where);
export const isPatchDeleteBody = (
  value: unknown,
): value is { readonly where: readonly DatabaseWhere<"bundle_patches">[] } =>
  isRecord(value) &&
  hasOnlyKeys(value, ["where"]) &&
  isWhere("bundle_patches", value.where);

export const isGetBundlesArgs = (value: unknown): value is GetBundlesArgs => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "_updateStrategy",
      "platform",
      "bundleId",
      "minBundleId",
      "channel",
      "cohort",
      "fingerprintHash",
      "appVersion",
    ])
  )
    return false;
  const common =
    (value.platform === "ios" || value.platform === "android") &&
    typeof value.bundleId === "string" &&
    [value.minBundleId, value.channel, value.cohort].every(
      (item) => item === undefined || typeof item === "string",
    );
  return (
    common &&
    (value._updateStrategy === "fingerprint"
      ? typeof value.fingerprintHash === "string" &&
        value.appVersion === undefined
      : value._updateStrategy === "appVersion" &&
        typeof value.appVersion === "string" &&
        value.fingerprintHash === undefined)
  );
};
