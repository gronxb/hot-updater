import { createHash } from "node:crypto";

import { assembleServer } from "@hot-updater/cli-tools";
import { mockDatabase, mockStorage } from "@hot-updater/mock";
import type { Bundle, Release } from "@hot-updater/protocol";
import {
  apiKeys,
  insights,
  type BundleEventRow,
  type InsightsApi,
  remoteConfig,
  type RemoteConfigApi,
  type RemoteConfigTemplate,
} from "@hot-updater/server/plugins";

type DemoReleaseFields = Pick<
  Release,
  | "enabled"
  | "fingerprintHash"
  | "message"
  | "rolloutCohortCount"
  | "shouldForceUpdate"
  | "targetAppVersion"
  | "targetCohorts"
> & {
  readonly channel: string;
};

type DemoDeployment = Bundle &
  DemoReleaseFields & { readonly demoFileHash: string };

type DemoDeploymentSeed = Omit<
  Bundle,
  "assetBaseStorageUri" | "manifestFileHash" | "manifestStorageUri"
> &
  Partial<
    Pick<
      Bundle,
      "assetBaseStorageUri" | "manifestFileHash" | "manifestStorageUri"
    >
  > & {
    readonly fileHash: string;
  } & Omit<DemoReleaseFields, "rolloutCohortCount" | "targetCohorts"> &
  Partial<Pick<DemoReleaseFields, "rolloutCohortCount" | "targetCohorts">>;

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

const createManifestUri = (bundleId: string) =>
  `${createReleaseRootUri(bundleId)}/manifest.json`;

const createAssetBaseUri = (bundleId: string) =>
  `${createReleaseRootUri(bundleId)}/assets`;

const createPatchArtifact = (
  bundleId: string,
  baseBundle: Bundle,
  patchKey: string,
): NonNullable<Bundle["patches"]>[number] => ({
  baseBundleId: baseBundle.id,
  baseFileHash: (baseBundle as DemoDeployment).demoFileHash,
  patchFileHash: toSeedHash("patch", patchKey),
  byteSize: 350_000,
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

const createBundle = (bundle: DemoDeploymentSeed): DemoDeployment => {
  const { fileHash, ...bundleFields } = bundle;
  const demoFileHash = toSeedHash("file", fileHash);
  const patches = bundle.patches?.map(normalizePatchArtifact) ?? null;

  return {
    rolloutCohortCount: 1000,
    targetCohorts: [],
    metadata: undefined,
    ...bundleFields,
    manifestStorageUri:
      bundle.manifestStorageUri ?? createManifestUri(bundle.id),
    assetBaseStorageUri:
      bundle.assetBaseStorageUri ?? createAssetBaseUri(bundle.id),
    patches,
    demoFileHash,
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
const bundles: DemoDeployment[] = [
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

/**
 * The demo console's database: in memory, seeded below, and as slow to
 * answer as a real one. hot-updater.config.ts lists it.
 */
export const database = mockDatabase({ latency: { min: 150, max: 320 } });
/** The demo's storage; the seed uploads no bundle files to it. */
export const storage = mockStorage({});
/** The plugins whose features the console shows; the seed writes through them too. */
export const plugins = [insights(), apiKeys(), remoteConfig()];
// Seeding writes through core and the plugins, assembled as the console
// assembles them, over the same data without the delay the console sees.
const seeding = assembleServer({
  database: database.withoutLatency(),
  storage,
  plugins,
});
const { core } = seeding;
// Oldest first, one deploy each, so a patch's base is stored before it.
const releaseIdByBundle = new Map<string, string>();
for (const deployment of [...bundles].sort((left, right) =>
  left.id.localeCompare(right.id),
)) {
  const {
    channel,
    enabled,
    fingerprintHash,
    message,
    rolloutCohortCount,
    shouldForceUpdate,
    targetAppVersion,
    targetCohorts,
    demoFileHash: _demoFileHash,
    ...bundle
  } = deployment;
  const [result] = await core.deploy([
    {
      bundle,
      release: {
        channel,
        enabled,
        fingerprintHash,
        message,
        shouldForceUpdate,
        targetAppVersion,
        ...(rolloutCohortCount === undefined ? {} : { rolloutCohortCount }),
        ...(targetCohorts === undefined
          ? {}
          : { targetCohorts: [...targetCohorts] }),
      },
    },
  ]);
  releaseIdByBundle.set(deployment.id, result!.release!.id);
}

const downloadDemo = {
  from_release_id: releaseIdByBundle.get(iosProdCorePatchA.id) ?? null,
  from_bundle_id: iosProdCorePatchA.id,
  to_release_id: releaseIdByBundle.get(iosProdCorePatchB.id) ?? null,
  to_bundle_id: iosProdCorePatchB.id,
  platform: "ios" as const,
  app_version: "1.4.2",
  channel: "production",
  metadata: {
    cohort: "download-demo",
    update_strategy: "appVersion" as const,
    fingerprint_hash: null,
    sdk_version: "1.0.0-rc",
  },

  user_id: "download-demo",
};

/** An update failure of the download demo's target, from its own installation. */
const failedDownload = (
  suffix: string,
  installId: string,
  minute: number,
  failure: Record<string, string | number>,
): BundleEventRow =>
  ({
    ...downloadDemo,
    id: `019f635e-f${suffix}-7000-8000-000000000${suffix}`,
    type: "UPDATE_FAILED",
    install_id: installId,
    ...(failure.stage === "check"
      ? { to_release_id: null, to_bundle_id: downloadDemo.from_bundle_id }
      : {}),
    metadata: { ...downloadDemo.metadata, failure },
    received_at_ms: Date.UTC(2026, 6, 18, 9, minute),
  }) as BundleEventRow;

const bundleEvents: readonly BundleEventRow[] = [
  {
    ...downloadDemo,
    id: "019f635e-d001-7000-8000-000000000001",
    type: "UPDATE_DOWNLOADED",
    install_id: "demo-download-pending",
    metadata: { ...downloadDemo.metadata, delivery: "patch" },
    received_at_ms: Date.UTC(2026, 6, 18, 9, 50),
  },
  {
    ...downloadDemo,
    id: "019f635e-d002-7000-8000-000000000002",
    type: "UPDATE_DOWNLOADED",
    install_id: "demo-download-applied",
    metadata: {
      ...downloadDemo.metadata,
      delivery: "archive",
      patch_fallback: true,
    },
    received_at_ms: Date.UTC(2026, 6, 18, 9, 55),
  },
  failedDownload("001", "demo-download-expired", 40, {
    stage: "download",
    reason: "http",
    resource: "artifact",
    http_status: 403,
    origin_code: "ExpiredToken",
  }),
  failedDownload("002", "demo-download-offline", 42, {
    stage: "download",
    reason: "network",
    resource: "manifest",
    transport: "timeout",
  }),
  failedDownload("003", "demo-install-corrupt", 44, {
    stage: "install",
    reason: "hash_mismatch",
    resource: "file",
  }),
  failedDownload("004", "demo-check-failed", 46, {
    stage: "check",
    reason: "http",
    resource: "catalog",
    http_status: 500,
  }),
  {
    ...downloadDemo,
    id: "019f635e-d003-7000-8000-000000000003",
    type: "UPDATE_APPLIED",
    install_id: "demo-download-applied",
    received_at_ms: Date.UTC(2026, 6, 18, 9, 58),
  },
  {
    id: "019f635e-0001-7000-8000-000000000001",
    type: "UPDATE_APPLIED",
    install_id: "019f635d-0001-7000-8000-000000000001",
    user_id: "detox-e2e",
    metadata: {
      cohort: "staff-ios",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: "0.37.0",
    },
    from_release_id: null,
    from_bundle_id: iosProdCorePatchA.id,
    to_release_id: null,
    to_bundle_id: iosProdCorePatchB.id,
    platform: "ios",
    app_version: "1.4.2",
    channel: "production",

    received_at_ms: Date.UTC(2026, 6, 15, 1, 20),
  },
  {
    id: "019f635e-0002-7000-8000-000000000002",
    type: "RECOVERED",
    install_id: "019f635d-0001-7000-8000-000000000001",
    user_id: "detox-e2e",
    metadata: {
      cohort: "staff-ios",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: "0.37.0",
    },
    from_release_id: null,
    from_bundle_id: iosProdCorePatchB.id,
    to_release_id: null,
    to_bundle_id: iosProdCorePatchA.id,
    platform: "ios",
    app_version: "1.4.2",
    channel: "production",

    received_at_ms: Date.UTC(2026, 6, 15, 1, 24),
  },
  {
    id: "019f635e-0003-7000-8000-000000000003",
    type: "UPDATE_APPLIED",
    install_id: "019f635d-0002-7000-8000-000000000002",
    user_id: "detox-e2e-beta",
    metadata: {
      cohort: "default",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: "0.37.0",
    },
    from_release_id: null,
    from_bundle_id: iosProdCorePatchA.id,
    to_release_id: null,
    to_bundle_id: iosProdCorePatchB.id,
    platform: "ios",
    app_version: "1.4.2",
    channel: "production",

    received_at_ms: Date.UTC(2026, 6, 15, 1, 28),
  },
  {
    id: "019f635e-0004-7000-8000-000000000004",
    type: "UPDATE_APPLIED",
    install_id: "019f635d-0002-7000-8000-000000000002",
    user_id: "detox-e2e-beta",
    metadata: {
      cohort: "default",
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: "0.37.0",
    },
    from_release_id: null,
    from_bundle_id: iosProdCorePatchB.id,
    to_release_id: null,
    to_bundle_id: iosProdCoreHotfix.id,
    platform: "ios",
    app_version: "1.4.2",
    channel: "production",

    received_at_ms: Date.UTC(2026, 6, 15, 1, 32),
  },
  ...(
    [
      [
        "0003",
        "UPDATE_APPLIED",
        "demo-alpha",
        iosProdCorePatchA.id,
        iosProdCorePatchB.id,
        12,
        10,
      ],
      [
        "0003",
        "UNCHANGED",
        "demo-alpha",
        iosProdCorePatchB.id,
        iosProdCorePatchB.id,
        14,
        10,
      ],
      [
        "0003",
        "UNCHANGED",
        "demo-alpha",
        iosProdCorePatchB.id,
        iosProdCorePatchB.id,
        16,
        10,
      ],
      [
        "0003",
        "UNCHANGED",
        "demo-alpha",
        iosProdCorePatchB.id,
        iosProdCorePatchB.id,
        18,
        9,
      ],
      [
        "0004",
        "UPDATE_APPLIED",
        "demo-beta",
        iosProdCorePatchA.id,
        iosProdCorePatchB.id,
        13,
        11,
      ],
      [
        "0004",
        "UNCHANGED",
        "demo-beta",
        iosProdCorePatchB.id,
        iosProdCorePatchB.id,
        15,
        11,
      ],
      [
        "0004",
        "UNCHANGED",
        "demo-beta",
        iosProdCorePatchB.id,
        iosProdCorePatchB.id,
        17,
        11,
      ],
      [
        "0005",
        "UPDATE_APPLIED",
        "demo-gamma",
        iosProdCorePatchA.id,
        iosProdCorePatchB.id,
        14,
        12,
      ],
      [
        "0005",
        "UPDATE_APPLIED",
        "demo-gamma",
        iosProdCorePatchB.id,
        iosProdCoreHotfix.id,
        17,
        12,
      ],
      [
        "0006",
        "UPDATE_APPLIED",
        "demo-delta",
        iosProdCorePatchA.id,
        iosProdCorePatchB.id,
        15,
        9,
      ],
      [
        "0006",
        "RECOVERED",
        "demo-delta",
        iosProdCorePatchB.id,
        iosProdCorePatchA.id,
        18,
        8,
      ],
      [
        "0007",
        "UPDATE_APPLIED",
        "demo-epsilon",
        iosProdCorePatchB.id,
        iosProdCoreHotfix.id,
        16,
        12,
      ],
      [
        "0007",
        "UNCHANGED",
        "demo-epsilon",
        iosProdCoreHotfix.id,
        iosProdCoreHotfix.id,
        18,
        10,
      ],
      [
        "0008",
        "UPDATE_APPLIED",
        "demo-zeta",
        iosProdCorePatchA.id,
        iosProdCorePatchB.id,
        17,
        13,
      ],
      [
        "0008",
        "UNCHANGED",
        "demo-zeta",
        iosProdCorePatchB.id,
        iosProdCorePatchB.id,
        18,
        9,
      ],
    ] as const
  ).map(
    (
      [installSuffix, type, userId, fromBundleId, toBundleId, day, hour],
      index,
    ): BundleEventRow => {
      const baseEvent = {
        id: `019f635e-1${String(index).padStart(3, "0")}-7000-8000-00000000${installSuffix}`,
        install_id: `019f635d-${installSuffix}-7000-8000-00000000${installSuffix}`,
        user_id: userId,
        metadata: {
          cohort: "default",
          fingerprint_hash: null,
          sdk_version: "0.37.0",
        },
        from_release_id: null,
        to_release_id: null,
        to_bundle_id: toBundleId,
        platform: "ios",
        app_version: "1.4.2",
        channel: "production",

        received_at_ms: Date.UTC(2026, 6, Number(day), Number(hour)),
      } as const;
      return type === "UNCHANGED"
        ? {
            ...baseEvent,
            type,
            from_bundle_id: null,
            metadata: { ...baseEvent.metadata, update_strategy: null },
          }
        : {
            ...baseEvent,
            type,
            from_bundle_id: fromBundleId,
            metadata: { ...baseEvent.metadata, update_strategy: "appVersion" },
          };
    },
  ),
];

// Keep the demo reporting windows useful regardless of the calendar date.
const receiptOffsetMs = Date.now() - Date.UTC(2026, 6, 18, 10) - 60_000;
const adjustedBundleEvents = bundleEvents.map((event) => ({
  ...event,
  received_at_ms: event.received_at_ms + receiptOffsetMs,
}));

const insightsApi = seeding.api.insights as InsightsApi;
for (const event of adjustedBundleEvents) {
  await insightsApi.recordEvent(event);
}

// Launches of the two newest iOS production bundles, and a crash of the
// newest, so Release health opens on both: the newest taking over, the one
// before it fading. Each installation downloads its bundle first, so a
// bundle's downloads are its launches and crashes.
const [demoNewest, demoPrevious] = [...bundles]
  .filter(
    (bundle) => bundle.channel === "production" && bundle.platform === "ios",
  )
  .sort((left, right) => right.id.localeCompare(left.id));
for (const [bundle, count] of [
  [demoPrevious, 3],
  [demoNewest, 8],
] as const) {
  if (bundle === undefined) continue;
  for (let installation = 0; installation < count; installation += 1) {
    const reportedAt = Date.now() + installation;
    for (const [type, idPrefix, receivedAtMs] of [
      ["UPDATE_DOWNLOADED", "eeea", reportedAt - 60_000],
      ["UPDATE_APPLIED", "eeed", reportedAt],
    ] as const) {
      await insightsApi.recordEvent({
        ...downloadDemo,
        id: `019f635e-${idPrefix}-7${bundle === demoNewest ? "1" : "0"}00-8000-${String(installation).padStart(12, "0")}`,
        type,
        install_id: `demo-adoption-${bundle.id}-${installation}`,
        from_release_id: null,
        from_bundle_id: "00000000-0000-0000-0000-000000000000",
        to_release_id: releaseIdByBundle.get(bundle.id) ?? null,
        to_bundle_id: bundle.id,
        received_at_ms: receivedAtMs,
      });
    }
  }
}
if (demoNewest !== undefined && demoPrevious !== undefined) {
  const crash = {
    ...downloadDemo,
    install_id: "demo-adoption-crash",
    from_release_id: releaseIdByBundle.get(demoPrevious.id) ?? null,
    from_bundle_id: demoPrevious.id,
    to_release_id: releaseIdByBundle.get(demoNewest.id) ?? null,
    to_bundle_id: demoNewest.id,
  };
  await insightsApi.recordEvent({
    ...crash,
    id: "019f635e-eeec-7000-8000-000000000000",
    type: "UPDATE_DOWNLOADED",
    received_at_ms: Date.now() + 50,
  });
  await insightsApi.recordEvent({
    ...crash,
    id: "019f635e-eeec-7000-8000-000000000001",
    type: "RECOVERED",
    from_release_id: crash.to_release_id,
    from_bundle_id: crash.to_bundle_id,
    to_release_id: crash.from_release_id,
    to_bundle_id: crash.from_bundle_id,
    received_at_ms: Date.now() + 100,
  });
}
// Downloads of patch B after its deploy.
const adoptionDemoNow = Date.now();
for (let installation = 0; installation < 6; installation += 1) {
  await insightsApi.recordEvent({
    ...downloadDemo,
    id: `019f635e-eeee-7000-8000-${String(installation).padStart(12, "0")}`,
    type: "UPDATE_DOWNLOADED",
    install_id: `demo-adoption-${installation}`,
    metadata: { ...downloadDemo.metadata, delivery: "archive" },
    received_at_ms: adoptionDemoNow + installation,
  });
}

// A stable reporting cohort makes the daily replacement curve visible in the demo.
const shareDemoNow = Date.now() - 60_000;
for (const [day, adopted] of [0, 2, 6, 12, 16, 18, 19].entries()) {
  for (let installation = 0; installation < 20; installation += 1) {
    const bundle =
      installation < adopted ? iosProdCorePatchB : iosProdCorePatchA;
    await insightsApi.recordEvent({
      ...downloadDemo,
      id: `019f635e-ffff-7000-8000-${String(day * 20 + installation).padStart(12, "0")}`,
      type: "UNCHANGED",
      install_id: `demo-share-${installation}`,
      user_id: null,
      app_version: installation < 16 ? "1.4.2" : "1.4.1",
      from_bundle_id: null,
      from_release_id: null,
      to_bundle_id: bundle.id,
      to_release_id: releaseIdByBundle.get(bundle.id)!,
      metadata: { ...downloadDemo.metadata, update_strategy: null },
      received_at_ms: shareDemoNow - (6 - day) * 86_400_000,
    });
  }
}

// Installations still on the bundle their native build shipped, which each
// report names as `min_bundle_id`, and one that downloads patch B and moves
// to it.
const builtinDemoNow = Date.now() - 30_000;
const builtinBundleIds = {
  "1.4.2": "019f2a00-0000-7000-8000-000000000000",
  "1.4.1": "019e8c00-0000-7000-8000-000000000000",
} as const;
for (const [index, appVersion] of (
  ["1.4.2", "1.4.2", "1.4.2", "1.4.1", "1.4.1"] as const
).entries()) {
  const builtin = builtinBundleIds[appVersion];
  await insightsApi.recordEvent({
    ...downloadDemo,
    id: `019f635e-bbbb-7000-8000-${String(index).padStart(12, "0")}`,
    type: "UNCHANGED",
    install_id: `demo-builtin-${index}`,
    user_id: null,
    app_version: appVersion,
    from_bundle_id: null,
    from_release_id: null,
    to_bundle_id: builtin,
    to_release_id: null,
    metadata: {
      ...downloadDemo.metadata,
      update_strategy: null,
      min_bundle_id: builtin,
    },
    received_at_ms: builtinDemoNow + index,
  });
}
// One on an SDK that reports no min_bundle_id: the Console still marks its
// bundle as built in, by the shape of the bundle's ID.
await insightsApi.recordEvent({
  ...downloadDemo,
  id: "019f635e-bbbd-7000-8000-000000000001",
  type: "UNCHANGED",
  install_id: "demo-builtin-unreported",
  user_id: null,
  app_version: "1.4.1",
  from_bundle_id: null,
  from_release_id: null,
  to_bundle_id: builtinBundleIds["1.4.1"],
  to_release_id: null,
  metadata: { ...downloadDemo.metadata, update_strategy: null },
  received_at_ms: builtinDemoNow + 5,
});
for (const [type, index] of [
  ["UPDATE_DOWNLOADED", 0],
  ["UPDATE_APPLIED", 1],
] as const) {
  await insightsApi.recordEvent({
    ...downloadDemo,
    id: `019f635e-bbbc-7000-8000-00000000000${index}`,
    type,
    install_id: "demo-builtin-applied",
    user_id: "demo-builtin",
    from_release_id: null,
    from_bundle_id: builtinBundleIds["1.4.2"],
    to_release_id: releaseIdByBundle.get(iosProdCorePatchB.id) ?? null,
    to_bundle_id: iosProdCorePatchB.id,
    metadata: {
      ...downloadDemo.metadata,
      min_bundle_id: builtinBundleIds["1.4.2"],
    },
    received_at_ms: builtinDemoNow + 9 + index,
  });
}

// Remote Config's history: launch copy, then conditions, then a checkout
// rollout to a quarter of installs.
const remoteConfigApi = seeding.api.remoteConfig as RemoteConfigApi;
const welcome = (beta: boolean): RemoteConfigTemplate["parameters"] => ({
  welcome_message: {
    valueType: "STRING",
    description: "The home screen's greeting.",
    defaultValue: { value: "Welcome back" },
    ...(beta
      ? { conditionalValues: { "Beta channel": { value: "Welcome, tester" } } }
      : {}),
  },
  max_items: {
    valueType: "NUMBER",
    defaultValue: { value: "20" },
    ...(beta
      ? { conditionalValues: { "iOS 1.4 and later": { value: "30" } } }
      : {}),
  },
});
const demoConditions: RemoteConfigTemplate["conditions"] = [
  {
    name: "Beta channel",
    rules: [{ type: "channel", channels: ["beta"] }],
  },
  {
    name: "iOS 1.4 and later",
    rules: [
      { type: "platform", platforms: ["ios"] },
      { type: "appVersion", range: ">=1.4.0" },
    ],
  },
];
for (const [baseVersion, template, description] of [
  [0, { conditions: [], parameters: welcome(false) }, "Launch copy"],
  [
    1,
    { conditions: demoConditions, parameters: welcome(true) },
    "Beta greeting and a longer list on iOS",
  ],
  [
    2,
    {
      conditions: [
        ...demoConditions,
        {
          name: "Checkout rollout",
          rules: [{ type: "percent", seed: "checkout", from: 0, to: 25 }],
        },
      ],
      parameters: {
        ...welcome(true),
        new_checkout: {
          valueType: "BOOLEAN",
          description: "Shows the redesigned checkout.",
          defaultValue: { value: "false" },
          conditionalValues: {
            "Beta channel": { value: "true" },
            "Checkout rollout": { value: "true" },
          },
        },
        onboarding_steps: {
          valueType: "JSON",
          defaultValue: { value: '["welcome","permissions","done"]' },
        },
        support_url: {
          valueType: "STRING",
          defaultValue: { useInAppDefault: true },
        },
      },
    },
    "Roll the new checkout out to 25% of installs",
  ],
] as const) {
  await remoteConfigApi.publish({ template, baseVersion, description });
}
