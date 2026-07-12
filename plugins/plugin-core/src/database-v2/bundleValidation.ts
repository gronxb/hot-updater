import type { Bundle, Platform } from "@hot-updater/core";

import {
  parseBundleMetadataV2,
  parseBundlePatchesV2,
  parseBundleRolloutV2,
  parseBundleTargetCohortsV2,
  parseOptionalNullableBundleStringV2,
} from "./bundleOptionalValidation";
import {
  invalidBundleFieldV2,
  requireBundleBooleanV2,
  requireBundleRecordV2,
  requireBundleShapeV2,
  requireBundleStringV2,
  requireNonEmptyBundleStringV2,
  requireNullableBundleStringV2,
} from "./bundleValidationPrimitives";

const BUNDLE_KEYS = [
  "id",
  "platform",
  "shouldForceUpdate",
  "enabled",
  "fileHash",
  "storageUri",
  "gitCommitHash",
  "message",
  "channel",
  "targetAppVersion",
  "fingerprintHash",
  "metadata",
  "manifestStorageUri",
  "manifestFileHash",
  "assetBaseStorageUri",
  "patches",
  "patchBaseBundleId",
  "patchBaseFileHash",
  "patchFileHash",
  "patchStorageUri",
  "rolloutCohortCount",
  "targetCohorts",
] as const;

const REQUIRED_BUNDLE_KEYS = BUNDLE_KEYS.slice(0, 11);

const parsePlatform = (value: unknown): Platform => {
  if (value !== "ios" && value !== "android") {
    return invalidBundleFieldV2("bundle platform must be ios or android");
  }
  return value;
};

export const parseBundleSnapshotV2 = (value: unknown): Bundle => {
  const bundle = requireBundleRecordV2(value, "put value");
  requireBundleShapeV2(bundle, {
    allowed: BUNDLE_KEYS,
    required: REQUIRED_BUNDLE_KEYS,
    label: "put value",
  });
  const metadata = parseBundleMetadataV2(bundle);
  const manifestStorageUri = parseOptionalNullableBundleStringV2(
    bundle,
    "manifestStorageUri",
  );
  const manifestFileHash = parseOptionalNullableBundleStringV2(
    bundle,
    "manifestFileHash",
  );
  const assetBaseStorageUri = parseOptionalNullableBundleStringV2(
    bundle,
    "assetBaseStorageUri",
  );
  const patches = parseBundlePatchesV2(bundle);
  const patchBaseBundleId = parseOptionalNullableBundleStringV2(
    bundle,
    "patchBaseBundleId",
  );
  const patchBaseFileHash = parseOptionalNullableBundleStringV2(
    bundle,
    "patchBaseFileHash",
  );
  const patchFileHash = parseOptionalNullableBundleStringV2(
    bundle,
    "patchFileHash",
  );
  const patchStorageUri = parseOptionalNullableBundleStringV2(
    bundle,
    "patchStorageUri",
  );
  const rolloutCohortCount = parseBundleRolloutV2(bundle);
  const targetCohorts = parseBundleTargetCohortsV2(bundle);

  return {
    id: requireNonEmptyBundleStringV2(Reflect.get(bundle, "id"), "bundle ID"),
    platform: parsePlatform(Reflect.get(bundle, "platform")),
    shouldForceUpdate: requireBundleBooleanV2(
      Reflect.get(bundle, "shouldForceUpdate"),
      "bundle force-update flag",
    ),
    enabled: requireBundleBooleanV2(
      Reflect.get(bundle, "enabled"),
      "bundle enabled flag",
    ),
    fileHash: requireBundleStringV2(
      Reflect.get(bundle, "fileHash"),
      "bundle file hash",
    ),
    storageUri: requireBundleStringV2(
      Reflect.get(bundle, "storageUri"),
      "bundle storage URI",
    ),
    gitCommitHash: requireNullableBundleStringV2(
      Reflect.get(bundle, "gitCommitHash"),
      "bundle git commit hash",
    ),
    message: requireNullableBundleStringV2(
      Reflect.get(bundle, "message"),
      "bundle message",
    ),
    channel: requireBundleStringV2(
      Reflect.get(bundle, "channel"),
      "bundle channel",
    ),
    targetAppVersion: requireNullableBundleStringV2(
      Reflect.get(bundle, "targetAppVersion"),
      "bundle target app version",
    ),
    fingerprintHash: requireNullableBundleStringV2(
      Reflect.get(bundle, "fingerprintHash"),
      "bundle fingerprint hash",
    ),
    ...(metadata === undefined ? {} : { metadata }),
    ...(manifestStorageUri === undefined ? {} : { manifestStorageUri }),
    ...(manifestFileHash === undefined ? {} : { manifestFileHash }),
    ...(assetBaseStorageUri === undefined ? {} : { assetBaseStorageUri }),
    ...(patches === undefined ? {} : { patches }),
    ...(patchBaseBundleId === undefined ? {} : { patchBaseBundleId }),
    ...(patchBaseFileHash === undefined ? {} : { patchBaseFileHash }),
    ...(patchFileHash === undefined ? {} : { patchFileHash }),
    ...(patchStorageUri === undefined ? {} : { patchStorageUri }),
    ...(rolloutCohortCount === undefined ? {} : { rolloutCohortCount }),
    ...(targetCohorts === undefined ? {} : { targetCohorts }),
  };
};
