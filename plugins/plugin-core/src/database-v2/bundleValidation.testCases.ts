import { createCompleteBundle } from "./bundleValidation.testFixtures";

export type MalformedBundleCase = {
  readonly label: string;
  readonly create: (observeGetter: () => void) => unknown;
};

const replaceField = (field: string, value: unknown): unknown => {
  const bundle = createCompleteBundle();
  Reflect.set(bundle, field, value);
  return bundle;
};

const removeField = (field: string): unknown => {
  const bundle = createCompleteBundle();
  Reflect.deleteProperty(bundle, field);
  return bundle;
};

export const malformedBundleCases = (): readonly MalformedBundleCase[] => [
  { label: "missing platform", create: () => removeField("platform") },
  { label: "invalid platform", create: () => replaceField("platform", "web") },
  {
    label: "non-boolean force flag",
    create: () => replaceField("shouldForceUpdate", 0),
  },
  {
    label: "non-boolean enabled flag",
    create: () => replaceField("enabled", "yes"),
  },
  {
    label: "non-string file hash",
    create: () => replaceField("fileHash", null),
  },
  {
    label: "non-string storage URI",
    create: () => replaceField("storageUri", 7),
  },
  {
    label: "invalid nullable git hash",
    create: () => replaceField("gitCommitHash", false),
  },
  {
    label: "invalid nullable message",
    create: () => replaceField("message", 1),
  },
  { label: "non-string channel", create: () => replaceField("channel", null) },
  {
    label: "invalid nullable target version",
    create: () => replaceField("targetAppVersion", true),
  },
  {
    label: "invalid nullable fingerprint",
    create: () => replaceField("fingerprintHash", {}),
  },
  { label: "null metadata", create: () => replaceField("metadata", null) },
  {
    label: "invalid metadata version",
    create: () => replaceField("metadata", { app_version: 1 }),
  },
  {
    label: "unknown metadata field",
    create: () => replaceField("metadata", { unexpected: "value" }),
  },
  {
    label: "invalid manifest URI",
    create: () => replaceField("manifestStorageUri", 1),
  },
  {
    label: "invalid manifest hash",
    create: () => replaceField("manifestFileHash", false),
  },
  {
    label: "invalid asset base URI",
    create: () => replaceField("assetBaseStorageUri", []),
  },
  { label: "non-array patches", create: () => replaceField("patches", {}) },
  { label: "null patch item", create: () => replaceField("patches", [null]) },
  {
    label: "incomplete patch item",
    create: () => replaceField("patches", [{ baseBundleId: "base" }]),
  },
  {
    label: "unknown patch field",
    create: () =>
      replaceField("patches", [
        {
          baseBundleId: "base",
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "memory://patch",
          unexpected: true,
        },
      ]),
  },
  {
    label: "non-string nested patch hash",
    create: () =>
      replaceField("patches", [
        {
          baseBundleId: "base",
          baseFileHash: 1,
          patchFileHash: "patch-hash",
          patchStorageUri: "memory://patch",
        },
      ]),
  },
  {
    label: "invalid legacy patch base",
    create: () => replaceField("patchBaseBundleId", 1),
  },
  {
    label: "invalid legacy base hash",
    create: () => replaceField("patchBaseFileHash", false),
  },
  {
    label: "invalid legacy patch hash",
    create: () => replaceField("patchFileHash", {}),
  },
  {
    label: "invalid legacy patch URI",
    create: () => replaceField("patchStorageUri", []),
  },
  {
    label: "non-finite rollout",
    create: () => replaceField("rolloutCohortCount", Number.POSITIVE_INFINITY),
  },
  {
    label: "negative-zero rollout",
    create: () => replaceField("rolloutCohortCount", -0),
  },
  {
    label: "fractional rollout",
    create: () => replaceField("rolloutCohortCount", 0.5),
  },
  {
    label: "out-of-range rollout",
    create: () => replaceField("rolloutCohortCount", 1001),
  },
  {
    label: "non-array target cohorts",
    create: () => replaceField("targetCohorts", "beta"),
  },
  {
    label: "non-string target cohort",
    create: () => replaceField("targetCohorts", ["beta", 1]),
  },
  {
    label: "unknown Bundle field",
    create: () => replaceField("unexpected", true),
  },
];
