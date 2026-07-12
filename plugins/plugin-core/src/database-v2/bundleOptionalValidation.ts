import type { BundleMetadata, BundlePatchArtifact } from "@hot-updater/core";

import {
  invalidBundleFieldV2,
  readOptionalBundleFieldV2,
  requireBundleRecordV2,
  requireBundleShapeV2,
  requireBundleStringV2,
  requireNullableBundleStringV2,
} from "./bundleValidationPrimitives";

const PATCH_KEYS = [
  "baseBundleId",
  "baseFileHash",
  "patchFileHash",
  "patchStorageUri",
] as const;

export const parseOptionalNullableBundleStringV2 = (
  bundle: Record<string, unknown>,
  key: string,
): string | null | undefined => {
  const value = readOptionalBundleFieldV2(bundle, key);
  return value === undefined
    ? undefined
    : requireNullableBundleStringV2(value, key);
};

export const parseBundleMetadataV2 = (
  bundle: Record<string, unknown>,
): BundleMetadata | undefined => {
  const value = readOptionalBundleFieldV2(bundle, "metadata");
  if (value === undefined) return undefined;
  const metadata = requireBundleRecordV2(value, "bundle metadata");
  requireBundleShapeV2(metadata, {
    allowed: ["app_version"],
    required: [],
    label: "bundle metadata",
  });
  const appVersion = readOptionalBundleFieldV2(metadata, "app_version");
  return appVersion === undefined
    ? {}
    : {
        app_version: requireBundleStringV2(appVersion, "metadata app version"),
      };
};

const parseBundlePatchV2 = (value: unknown): BundlePatchArtifact => {
  const patch = requireBundleRecordV2(value, "bundle patch");
  requireBundleShapeV2(patch, {
    allowed: PATCH_KEYS,
    required: PATCH_KEYS,
    label: "bundle patch",
  });
  return {
    baseBundleId: requireBundleStringV2(
      Reflect.get(patch, "baseBundleId"),
      "patch base bundle ID",
    ),
    baseFileHash: requireBundleStringV2(
      Reflect.get(patch, "baseFileHash"),
      "patch base file hash",
    ),
    patchFileHash: requireBundleStringV2(
      Reflect.get(patch, "patchFileHash"),
      "patch file hash",
    ),
    patchStorageUri: requireBundleStringV2(
      Reflect.get(patch, "patchStorageUri"),
      "patch storage URI",
    ),
  };
};

export const parseBundlePatchesV2 = (
  bundle: Record<string, unknown>,
): BundlePatchArtifact[] | null | undefined => {
  const value = readOptionalBundleFieldV2(bundle, "patches");
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value)) {
    return invalidBundleFieldV2("bundle patches must be an array or null");
  }
  return value.map(parseBundlePatchV2);
};

export const parseBundleRolloutV2 = (
  bundle: Record<string, unknown>,
): number | null | undefined => {
  const value = readOptionalBundleFieldV2(bundle, "rolloutCohortCount");
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 1000
  ) {
    return invalidBundleFieldV2(
      "bundle rollout cohort count must be an integer from 0 to 1000 or null",
    );
  }
  return value;
};

export const parseBundleTargetCohortsV2 = (
  bundle: Record<string, unknown>,
): string[] | null | undefined => {
  const value = readOptionalBundleFieldV2(bundle, "targetCohorts");
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value)) {
    return invalidBundleFieldV2(
      "bundle target cohorts must be an array or null",
    );
  }
  return value.map((cohort) => requireBundleStringV2(cohort, "target cohort"));
};
