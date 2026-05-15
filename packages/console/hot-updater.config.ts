import { createHash } from "node:crypto";

import { mockDatabase, mockStorage } from "@hot-updater/mock";
import type { Bundle } from "@hot-updater/plugin-core";

type BundleSeed = Omit<Bundle, "storageUri"> &
  Partial<
    Pick<
      Bundle,
      | "storageUri"
      | "manifestStorageUri"
      | "manifestFileHash"
      | "assetBaseStorageUri"
    >
  >;

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const toSeedHash = (kind: string, value: string) => {
  if (value.startsWith("sig:")) {
    return value;
  }

  if (SHA256_HEX_RE.test(value)) {
    return value.toLowerCase();
  }

  return sha256(`${kind}:${value}`);
};

const createReleaseRootUri = (bundleId: string) =>
  `storage://my-app/releases/${bundleId}`;

const createBundleUri = (bundleId: string) =>
  `${createReleaseRootUri(bundleId)}/bundle.zip`;

const createManifestUri = (bundleId: string) =>
  `${createReleaseRootUri(bundleId)}/manifest.json`;

const createAssetBaseUri = (bundleId: string) =>
  `${createReleaseRootUri(bundleId)}/files`;

const createPatchArtifact = (
  bundleId: string,
  baseBundle: Bundle,
  patchKey: string,
): NonNullable<Bundle["patches"]>[number] => ({
  baseBundleId: baseBundle.id,
  baseFileHash: baseBundle.fileHash,
  patchFileHash: toSeedHash("patch", patchKey),
  patchStorageUri:
    `${createReleaseRootUri(bundleId)}/patches/${baseBundle.id}/` +
    `index.${baseBundle.platform}.bundle.bsdiff`,
});

const normalizePatchArtifact = (
  patch: NonNullable<Bundle["patches"]>[number],
): NonNullable<Bundle["patches"]>[number] => ({
  ...patch,
  baseFileHash: toSeedHash("file", patch.baseFileHash),
  patchFileHash: toSeedHash("patch", patch.patchFileHash),
});

const createBundle = (bundle: BundleSeed): Bundle => {
  const fileHash = toSeedHash("file", bundle.fileHash);
  const patches = bundle.patches?.map(normalizePatchArtifact) ?? null;
  const primaryPatch = patches?.[0] ?? null;

  return {
    rolloutCohortCount: 1000,
    targetCohorts: null,
    metadata: undefined,
    ...bundle,
    storageUri: bundle.storageUri ?? createBundleUri(bundle.id),
    manifestStorageUri:
      bundle.manifestStorageUri ?? createManifestUri(bundle.id),
    assetBaseStorageUri:
      bundle.assetBaseStorageUri ?? createAssetBaseUri(bundle.id),
    patches,
    patchBaseBundleId:
      bundle.patchBaseBundleId ?? primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: bundle.patchBaseFileHash
      ? toSeedHash("file", bundle.patchBaseFileHash)
      : (primaryPatch?.baseFileHash ?? null),
    patchFileHash: bundle.patchFileHash
      ? toSeedHash("patch", bundle.patchFileHash)
      : (primaryPatch?.patchFileHash ?? null),
    patchStorageUri:
      bundle.patchStorageUri ?? primaryPatch?.patchStorageUri ?? null,
    fileHash,
    manifestFileHash: bundle.manifestFileHash
      ? toSeedHash("manifest", bundle.manifestFileHash)
      : toSeedHash("manifest", bundle.id),
    fingerprintHash: bundle.fingerprintHash
      ? toSeedHash("fingerprint", bundle.fingerprintHash)
      : null,
  };
};

const iosProdCoreBase = createBundle({
  id: "01971f10-1aa1-7445-8b8c-010101010101",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-prod-core-1400",
  gitCommitHash: "9c12ab40",
  platform: "ios",
  targetAppVersion: "1.4.x",
  message: "iOS 1.4 baseline with startup and navigation fixes",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
});

const iosProdPaymentsBase = createBundle({
  id: "01971f20-1aa1-7445-8b8c-020202020202",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-prod-payments-1400",
  gitCommitHash: "7f3412ac",
  platform: "ios",
  targetAppVersion: ">=1.4.0 <2.0.0",
  message: "Payments baseline with refreshed receipt screens",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
});

const androidProdBase = createBundle({
  id: "01971f30-1aa1-7445-8b8c-030303030303",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-prod-core-1320",
  gitCommitHash: "cf8302de",
  platform: "android",
  targetAppVersion: "1.3.x",
  message: "Android production baseline for 1.3.x",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
});

const iosStagingBase = createBundle({
  id: "01971f40-1aa1-7445-8b8c-040404040404",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-staging-1500",
  gitCommitHash: "ad4e71b2",
  platform: "ios",
  targetAppVersion: "1.5.x",
  message: "Staging baseline for the iOS 1.5 train",
  channel: "staging",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
});

const androidStagingVisionBase = createBundle({
  id: "01971f50-1aa1-7445-8b8c-050505050505",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-staging-vision",
  gitCommitHash: "3bf7aa12",
  platform: "android",
  targetAppVersion: null,
  message: "Fingerprint cohort for the camera rewrite",
  channel: "staging",
  fingerprintHash: "fp-android-camera-v2",
  rolloutCohortCount: 200,
  targetCohorts: ["qa-android", "camera-lab"],
});

const iosDevBase = createBundle({
  id: "01971f60-1aa1-7445-8b8c-060606060606",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-dev-navigation",
  gitCommitHash: "11da82ff",
  platform: "ios",
  targetAppVersion: "1.6.x",
  message: "Development baseline for navigation experiments",
  channel: "dev",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
});

const androidDevBase = createBundle({
  id: "01971f70-1aa1-7445-8b8c-070707070707",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-dev-feed",
  gitCommitHash: "6e20c1da",
  platform: "android",
  targetAppVersion: null,
  message: "Development baseline for feed rendering work",
  channel: "dev",
  fingerprintHash: "fp-android-feed-dev",
  rolloutCohortCount: 300,
  targetCohorts: ["dev-team"],
});

const androidBetaBase = createBundle({
  id: "01971f80-1aa1-7445-8b8c-080808080808",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-beta-tablet",
  gitCommitHash: "5ae2114c",
  platform: "android",
  targetAppVersion: ">=2.0.0-beta.1",
  message: "Tablet beta baseline for Android 2.0",
  channel: "beta",
  fingerprintHash: null,
  rolloutCohortCount: 100,
});

const iosCanaryBase = createBundle({
  id: "01971f90-1aa1-7445-8b8c-090909090909",
  enabled: false,
  shouldForceUpdate: false,
  fileHash: "file-ios-canary-gesture",
  gitCommitHash: "0cb8fa71",
  platform: "ios",
  targetAppVersion: null,
  message: "Canary branch for new gesture responder",
  channel: "canary",
  fingerprintHash: "fp-ios-gesture-lab",
  rolloutCohortCount: 25,
  targetCohorts: ["design-review"],
});

const iosProdCorePatchA = createBundle({
  id: "01972010-1aa1-7445-8b8c-101010101010",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-prod-core-1401",
  gitCommitHash: "40bb1cde",
  platform: "ios",
  targetAppVersion: "1.4.x",
  message: "Incremental iOS patch for startup memory pressure",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 250,
  patches: [
    createPatchArtifact(
      "01972010-1aa1-7445-8b8c-101010101010",
      iosProdCoreBase,
      "ios-prod-core-a",
    ),
  ],
  targetCohorts: ["staff-ios"],
});

const iosProdCorePatchB = createBundle({
  id: "01972020-1aa1-7445-8b8c-111111111111",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-prod-core-1402",
  gitCommitHash: "6a901fbc",
  platform: "ios",
  targetAppVersion: "1.4.x",
  message: "Expanded rollout with deep link restore fixes",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 700,
  patches: [
    createPatchArtifact(
      "01972020-1aa1-7445-8b8c-111111111111",
      iosProdCorePatchA,
      "ios-prod-core-b",
    ),
  ],
});

const iosProdCoreHotfix = createBundle({
  id: "01972030-1aa1-7445-8b8c-121212121212",
  enabled: true,
  shouldForceUpdate: true,
  fileHash: "file-ios-prod-core-1403",
  gitCommitHash: "31fd6aa0",
  platform: "ios",
  targetAppVersion: "1.4.x",
  message: "Emergency hotfix for offline launch and restore flow",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  patches: [
    createPatchArtifact(
      "01972030-1aa1-7445-8b8c-121212121212",
      iosProdCoreBase,
      "ios-prod-core-hotfix-root",
    ),
    createPatchArtifact(
      "01972030-1aa1-7445-8b8c-121212121212",
      iosProdCorePatchB,
      "ios-prod-core-hotfix-b",
    ),
  ],
});

const iosProdPaymentsPatchA = createBundle({
  id: "01972040-1aa1-7445-8b8c-131313131313",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-prod-payments-1401",
  gitCommitHash: "9e1d27ab",
  platform: "ios",
  targetAppVersion: ">=1.4.0 <2.0.0",
  message: "Receipt rendering patch for payments surface",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 400,
  patches: [
    createPatchArtifact(
      "01972040-1aa1-7445-8b8c-131313131313",
      iosProdPaymentsBase,
      "ios-prod-payments-a",
    ),
  ],
});

const iosProdPaymentsPatchB = createBundle({
  id: "01972050-1aa1-7445-8b8c-141414141414",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-prod-payments-1402",
  gitCommitHash: "c1d2ef45",
  platform: "ios",
  targetAppVersion: ">=1.4.0 <2.0.0",
  message: "Checkout patch with wallet retry logic",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 850,
  patches: [
    createPatchArtifact(
      "01972050-1aa1-7445-8b8c-141414141414",
      iosProdPaymentsPatchA,
      "ios-prod-payments-b",
    ),
    createPatchArtifact(
      "01972050-1aa1-7445-8b8c-141414141414",
      iosProdPaymentsBase,
      "ios-prod-payments-b-root",
    ),
  ],
});

const androidProdPatchA = createBundle({
  id: "01972060-1aa1-7445-8b8c-151515151515",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-prod-core-1321",
  gitCommitHash: "ff21ab89",
  platform: "android",
  targetAppVersion: "1.3.x",
  message: "First Android production patch for image decode",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 300,
  patches: [
    createPatchArtifact(
      "01972060-1aa1-7445-8b8c-151515151515",
      androidProdBase,
      "android-prod-a",
    ),
  ],
});

const androidProdPatchB = createBundle({
  id: "01972070-1aa1-7445-8b8c-161616161616",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-prod-core-1322",
  gitCommitHash: "12ee4a71",
  platform: "android",
  targetAppVersion: "1.3.x",
  message: "Follow-up Android patch for cached asset reuse",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 600,
  patches: [
    createPatchArtifact(
      "01972070-1aa1-7445-8b8c-161616161616",
      androidProdPatchA,
      "android-prod-b",
    ),
  ],
});

const androidProdEmergency = createBundle({
  id: "01972080-1aa1-7445-8b8c-171717171717",
  enabled: true,
  shouldForceUpdate: true,
  fileHash: "file-android-prod-core-1323",
  gitCommitHash: "abce5510",
  platform: "android",
  targetAppVersion: "1.3.x",
  message: "Emergency Android rollback-prevention patch",
  channel: "production",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  patches: [
    createPatchArtifact(
      "01972080-1aa1-7445-8b8c-171717171717",
      androidProdBase,
      "android-prod-emergency-root",
    ),
    createPatchArtifact(
      "01972080-1aa1-7445-8b8c-171717171717",
      androidProdPatchB,
      "android-prod-emergency-b",
    ),
  ],
});

const iosStagingPatchA = createBundle({
  id: "01972090-1aa1-7445-8b8c-181818181818",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-staging-1501",
  gitCommitHash: "8cb550f1",
  platform: "ios",
  targetAppVersion: "1.5.x",
  message: "Staging patch for profile composer polish",
  channel: "staging",
  fingerprintHash: null,
  rolloutCohortCount: 500,
  patches: [
    createPatchArtifact(
      "01972090-1aa1-7445-8b8c-181818181818",
      iosStagingBase,
      "ios-staging-a",
    ),
  ],
});

const iosStagingPatchB = createBundle({
  id: "019720a0-1aa1-7445-8b8c-191919191919",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-staging-1502",
  gitCommitHash: "d31be972",
  platform: "ios",
  targetAppVersion: "1.5.x",
  message: "Staging patch for keyboard and modal overlap",
  channel: "staging",
  fingerprintHash: null,
  rolloutCohortCount: 800,
  patches: [
    createPatchArtifact(
      "019720a0-1aa1-7445-8b8c-191919191919",
      iosStagingPatchA,
      "ios-staging-b",
    ),
  ],
});

const androidStagingVisionPatchA = createBundle({
  id: "019720b0-1aa1-7445-8b8c-202020202020",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-staging-vision-a",
  gitCommitHash: "20be7311",
  platform: "android",
  targetAppVersion: null,
  message: "Camera rewrite patch for staged QA cohort",
  channel: "staging",
  fingerprintHash: "fp-android-camera-v2",
  rolloutCohortCount: 450,
  patches: [
    createPatchArtifact(
      "019720b0-1aa1-7445-8b8c-202020202020",
      androidStagingVisionBase,
      "android-staging-vision-a",
    ),
  ],
  targetCohorts: ["qa-android", "camera-lab", "staff-android"],
});

const androidStagingVisionPatchB = createBundle({
  id: "019720c0-1aa1-7445-8b8c-212121212121",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-staging-vision-b",
  gitCommitHash: "f0a9bb37",
  platform: "android",
  targetAppVersion: null,
  message: "Extended camera patch with recovery guardrails",
  channel: "staging",
  fingerprintHash: "fp-android-camera-v2",
  rolloutCohortCount: 900,
  patches: [
    createPatchArtifact(
      "019720c0-1aa1-7445-8b8c-212121212121",
      androidStagingVisionPatchA,
      "android-staging-vision-b",
    ),
    createPatchArtifact(
      "019720c0-1aa1-7445-8b8c-212121212121",
      androidStagingVisionBase,
      "android-staging-vision-b-root",
    ),
  ],
});

const iosDevPatchA = createBundle({
  id: "019720d0-1aa1-7445-8b8c-222222222222",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-ios-dev-navigation-a",
  gitCommitHash: "512be6ac",
  platform: "ios",
  targetAppVersion: "1.6.x",
  message: "Dev patch for stack reset and tab restoration",
  channel: "dev",
  fingerprintHash: null,
  rolloutCohortCount: 650,
  patches: [
    createPatchArtifact(
      "019720d0-1aa1-7445-8b8c-222222222222",
      iosDevBase,
      "ios-dev-a",
    ),
  ],
});

const iosDevPatchB = createBundle({
  id: "019720e0-1aa1-7445-8b8c-232323232323",
  enabled: false,
  shouldForceUpdate: false,
  fileHash: "file-ios-dev-navigation-b",
  gitCommitHash: "4ffad810",
  platform: "ios",
  targetAppVersion: "1.6.x",
  message: "Paused dev patch after regression in modal dismissal",
  channel: "dev",
  fingerprintHash: null,
  rolloutCohortCount: 150,
  patches: [
    createPatchArtifact(
      "019720e0-1aa1-7445-8b8c-232323232323",
      iosDevPatchA,
      "ios-dev-b",
    ),
  ],
});

const androidDevPatchA = createBundle({
  id: "019720f0-1aa1-7445-8b8c-242424242424",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-dev-feed-a",
  gitCommitHash: "e8124bc2",
  platform: "android",
  targetAppVersion: null,
  message: "Dev patch for feed card recycling",
  channel: "dev",
  fingerprintHash: "fp-android-feed-dev",
  rolloutCohortCount: 750,
  patches: [
    createPatchArtifact(
      "019720f0-1aa1-7445-8b8c-242424242424",
      androidDevBase,
      "android-dev-a",
    ),
  ],
});

const androidBetaPatchA = createBundle({
  id: "01972100-1aa1-7445-8b8c-252525252525",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "file-android-beta-tablet-a",
  gitCommitHash: "2dcab671",
  platform: "android",
  targetAppVersion: ">=2.0.0-beta.1",
  message: "Tablet beta patch for split-screen persistence",
  channel: "beta",
  fingerprintHash: null,
  rolloutCohortCount: 500,
  patches: [
    createPatchArtifact(
      "01972100-1aa1-7445-8b8c-252525252525",
      androidBetaBase,
      "android-beta-a",
    ),
  ],
});

const iosCanaryPatchA = createBundle({
  id: "01972110-1aa1-7445-8b8c-262626262626",
  enabled: false,
  shouldForceUpdate: false,
  fileHash: "file-ios-canary-gesture-a",
  gitCommitHash: "8120de44",
  platform: "ios",
  targetAppVersion: null,
  message: "Canary patch for gesture responder edge cases",
  channel: "canary",
  fingerprintHash: "fp-ios-gesture-lab",
  rolloutCohortCount: 50,
  patches: [
    createPatchArtifact(
      "01972110-1aa1-7445-8b8c-262626262626",
      iosCanaryBase,
      "ios-canary-a",
    ),
  ],
  targetCohorts: ["design-review", "ios-lab"],
});

// Seed lineages so filters, pagination, detail sheets, and patch tables all
// have enough variety to be useful during local development.
const bundles: Bundle[] = [
  iosCanaryPatchA,
  androidBetaPatchA,
  androidDevPatchA,
  iosDevPatchB,
  iosDevPatchA,
  androidStagingVisionPatchB,
  androidStagingVisionPatchA,
  iosStagingPatchB,
  iosStagingPatchA,
  androidProdEmergency,
  androidProdPatchB,
  androidProdPatchA,
  iosProdPaymentsPatchB,
  iosProdPaymentsPatchA,
  iosProdCoreHotfix,
  iosProdCorePatchB,
  iosProdCorePatchA,
  iosCanaryBase,
  androidBetaBase,
  androidDevBase,
  iosDevBase,
  androidStagingVisionBase,
  iosStagingBase,
  androidProdBase,
  iosProdPaymentsBase,
  iosProdCoreBase,
];

export default {
  projectPath: __dirname,
  updateStrategy: "fingerprint" as const,
  build: async () => null,
  storage: mockStorage({}),
  database: mockDatabase({
    latency: { min: 150, max: 320 },
    initialBundles: bundles,
  }),
  console: {
    gitUrl: "https://github.com/gronxb/hot-updater",
  },
};
