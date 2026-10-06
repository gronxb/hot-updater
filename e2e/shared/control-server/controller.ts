import { spawn, spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";

import type {
  AnyHotUpdaterPlugin,
  ConfiguredDatabase,
  DeployReleasePolicy,
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import type { InsightsModel } from "@hot-updater/plugin-insights/server";
import type { Bundle } from "@hot-updater/protocol";

import { lynxE2eRuntimeId } from "../../lynx/embedded-bundle.ts";
import {
  createLynxAndroidLaunchConfigurationArguments,
  createLynxNativeLaunchConfiguration,
  HOT_UPDATER_LYNX_IOS_LAUNCH_CONFIGURATION_PREFIX,
  serializeLynxNativeLaunchConfiguration,
} from "../../lynx/native-launch-configuration.ts";
import {
  ConsoleInsightsQaError,
  readObservedInsightsEvent,
  verifyConsoleInsights,
  type ObservedInsightsEvent,
} from "../console-insights-qa.ts";
import { createConsoleInsightsHttpClient } from "../insights-http-client.ts";
import { createConsoleInsightsProviderClient } from "../insights-provider-client.ts";
import {
  PAX_LONG_ASSET_ANDROID_MANIFEST_PATH,
  PAX_LONG_ASSET_MANIFEST_PATH,
  PAX_LONG_ASSET_RELATIVE_PATH,
} from "../pax-long-path-fixture.ts";
import { importPublished, publishedBin } from "../published.ts";
import {
  advanceAndroidRestartWait,
  hasLynxNativeRestartEvidence,
  hasNativeRestartEvidenceAfterMarker,
  isAndroidRecoveryProcessReady,
  isLynxManagedRuntimeReplacementReady,
} from "./android-restart-wait.ts";
import { createControlJobs, type JobExecutionContext } from "./control-jobs.ts";
import {
  createCrashRecoveryArtifactNames,
  getLaunchReportState,
  waitForCrashRecoveryState,
} from "./crash-recovery-wait.ts";
import type { CrashRecoveryArtifactNames } from "./crash-recovery-wait.ts";
import {
  type BundleProfile,
  createDeployAssetGuardSource,
} from "./deploy-asset-guard.ts";
import { restoreDeployFixtures } from "./deploy-fixture-reset.ts";
import { acquireFairFileLock, DEPLOY_LOCK_CAPACITY } from "./fair-file-lock.ts";
import {
  getFixtureResetChannels as resolveFixtureResetChannels,
  resetFixtureReleases,
} from "./fixture-release-reset.ts";
import {
  e2eBuiltInBundleId,
  isLynxE2eAppId,
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  lynxAndroidInstalledManifestPaths,
  lynxStoredExclusions,
  lynxReceipt,
  synthesizeLynxCrashHistory,
  readLynxLaunchReport,
  assertLynxStartupHang,
  assertLynxStartupInterruption,
  synthesizeLynxMetadata,
} from "./lynx-store.ts";
import {
  captureCommandWithDeadline,
  captureArtifactSelectionEvidence,
  classifyArtifactSelectionHistory,
  collectManifestDiffLogs,
  getExpectedArtifactFilePaths,
  type ArtifactFileTransferMode,
  type ArtifactSelectionEvidence,
} from "./manifest-diff-assertion.ts";
import {
  isExpectedMetadataStateReached,
  resolveMetadataWaitReleaseId,
} from "./metadata-wait.ts";
import { hasNativeInstallEvent } from "./native-install-log.ts";
import { inferPatchAssetPathFromStorageUri } from "./patch-storage-path.ts";
import { resetPendingE2eAction } from "./pending-action.ts";
import { resetProviderAfterReady } from "./provider-reset-retry.ts";
import { buildReleaseCatalogUrl } from "./release-catalog-url.ts";
import {
  prepareE2eStartupCheck,
  readE2eScreenStateSnapshot,
  resetE2eScreenState,
  setE2eScreenStateLaunchGeneration,
} from "./screen-state.ts";
import { terminateApp } from "./terminate-app.ts";
import {
  shouldProbeUpdateCheckVisibility,
  validateArtifactInfoVisibility,
} from "./update-check-visibility.ts";

// Hot Updater's packages through the entries they publish, as the example
// app installs them.
const {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
  getBundlePatch,
  getBundlePatches,
  getRolledOutNumericCohorts,
} = await importPublished<typeof import("@hot-updater/protocol")>(
  "@hot-updater/protocol",
);
const { createUUIDv7After, rowToBundle } = await importPublished<
  typeof import("@hot-updater/plugin-core")
>("@hot-updater/plugin-core");
const { assembleServer, loadConfig } = await importPublished<
  typeof import("@hot-updater/cli-tools")
>("@hot-updater/cli-tools");
const { createInsightsModel, createInsightsProvider } = await importPublished<
  typeof import("@hot-updater/server/plugins/insights")
>("@hot-updater/server/plugins/insights");

type Platform = "ios" | "android";
const BUILT_IN_MIN_BUNDLE_ID_SUFFIX = "7000-8000-000000000000";

type JobResult = Record<string, unknown>;

type DeployMode = "crash" | "hang" | "reset";

type DeployedBundleRecord = {
  bundleId: string;
  bundleProfile: BundleProfile;
  channel: string;
  crossProvenance: boolean;
  diffBaseBundleId: string | null;
  diffPatchAssetPath: string | null;
  enabled: boolean;
  marker: string;
  mode: DeployMode;
  patchBaseBundleIds: string[];
  releaseId: string;
  runtimeId: string | null;
  rolloutCohortCount: number | null;
  scopeKey: string;
  shouldForceUpdate: boolean;
  targetCohorts: string[] | null;
};

type SessionState = {
  appBaseUrl: string;
  appBackupPath: string | null;
  appId: string;
  appSourceFile: string;
  bootstrapResult: JobResult | null;
  builtInBundleId: string | null;
  configBackupPath: string | null;
  configSourceFile: string;
  deployedBundles: DeployedBundleRecord[];
  envBackupPath: string | null;
  envSourceFile: string;
  exampleDir: string;
  initialMarker: string;
  multiAssetBackupPaths: Record<string, string | null>;
  observedInsightsEvents: ObservedInsightsEvent[];
  platform: Platform;
  resultsDir: string;
  sizeAwareLargeAssetBackupCaptured: boolean;
  sizeAwareLargeAssetBackupPath: string | null;
  sizeAwareLargeAssetPath: string;
  storePath: string | null;
  lynxScopePath: string | null;
};

type DeployBundleRequest = {
  crossProvenance?: boolean;
  bundleProfile?: BundleProfile;
  channel: string;
  disabled?: boolean;
  diffBaseBundleId?: string;
  forceUpdate?: boolean;
  marker: string;
  message?: string;
  mode: DeployMode;
  patchMaxBaseBundles?: number;
  rollout?: number;
  safeBundleIds: string[];
  strategy?: "appVersion" | "fingerprint";
  targetAppVersion: string;
  targetCohorts?: string[];
};

type PatchReleaseRequest = {
  releaseId: string;
  enabled?: boolean;
  rolloutCohortCount?: number | null;
  shouldForceUpdate?: boolean;
  targetCohorts?: string[] | null;
};

type LaunchReportAssertion = {
  fromBundleId?: string;
  fromReleaseId?: string;
  optional: boolean;
  status: string;
  toBundleId?: string;
  toReleaseId?: string;
};

type JsonSnapshot = {
  exists: boolean;
  path: string;
  readError: string | null;
  value: Record<string, unknown> | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../../..");
// The CLI the example app installs, as `npx hot-updater` runs it there.
const HOT_UPDATER_CLI_PATH = publishedBin("hot-updater");
const COMMAND_STDIO_DRAIN_GRACE_MS = 500;
const EXAMPLE_DIR = path.resolve(
  process.env.HOT_UPDATER_E2E_ENV_TARGET_DIR ??
    path.join(REPO_DIR, "examples/v0.85.0"),
);
const E2E_PATCH_SOURCE_FILE = path.join(
  EXAMPLE_DIR,
  "src/e2eApp/patchSurface.ts",
);
const HOT_UPDATER_ENV_FILE = path.join(EXAMPLE_DIR, ".env.hotupdater");
const HOT_UPDATER_CONFIG_FILE = path.join(EXAMPLE_DIR, "hot-updater.config.ts");
const BARE_BUILD_CACHE_VERSION = 1;
const BARE_BUILD_CACHE_LOCK_STALE_MS = 45 * 60 * 1000;
const BARE_BUILD_CACHE_LOCK_WAIT_MS = 500;
const BARE_BUILD_CACHE_INPUT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "examples/v0.85.0/.env.hotupdater",
  "examples/v0.85.0/App.tsx",
  "examples/v0.85.0/index.js",
  "examples/v0.85.0/package.json",
  "examples/v0.85.0/babel.config.js",
  "examples/v0.85.0/metro.config.js",
  "examples/v0.85.0/rspack.config.mjs",
  "examples/v0.85.0/e2e-build-config.cjs",
  "examples/v0.85.0/src/e2eApp",
  "examples/v0.85.0/src/e2eRuntimeConfig.ts",
  "examples/v0.85.0/src/test",
  "plugins/bare",
  "packages/protocol",
  "packages/hot-updater/src/utils/bundleManifest.ts",
  "packages/react-native",
];
const SIGNING_PRIVATE_KEY_RELATIVE_PATH = "keys/private-key.pem";
const EMPTY_CRASH_HISTORY = {
  bundles: [],
  maxHistorySize: 10,
};
const CRASH_GUARD_START = "/* E2E_CRASH_GUARD_START */";
const CRASH_GUARD_END = "/* E2E_CRASH_GUARD_END */";
const CRASH_GUARD_PATTERN =
  /\/\* E2E_CRASH_GUARD_START \*\/[\s\S]*?\/\* E2E_CRASH_GUARD_END \*\//;
const DEPLOY_ASSET_GUARD_PATTERN =
  /\/\* E2E_DEPLOY_ASSET_GUARD_START \*\/[\s\S]*?\/\* E2E_DEPLOY_ASSET_GUARD_END \*\//;
const AUTO_PATCH_CONFIG_GUARD_START = "/* E2E_AUTO_PATCH_CONFIG_START */";
const AUTO_PATCH_CONFIG_GUARD_END = "/* E2E_AUTO_PATCH_CONFIG_END */";
const AUTO_PATCH_CONFIG_PATTERN =
  /\/\* E2E_AUTO_PATCH_CONFIG_START \*\/[\s\S]*?\/\* E2E_AUTO_PATCH_CONFIG_END \*\//;
const BARE_BUILD_INLINE_PATTERN =
  /(build:\s*bare\(\{\s*)([^}\n]*?)(\s*\}\s*\))/;
const STANDALONE_REPOSITORY_BASE_URL_PATTERN =
  /(standaloneRepository\(\{\s*baseUrl:\s*)["'][^"']+["']/;
const UPDATE_STRATEGY_CONFIG_PATTERN =
  /updateStrategy:\s*["'](?:appVersion|fingerprint)["']/;
const MARKER_PATTERN =
  /export\s+const\s+E2E_SCENARIO_MARKER\s*(?::\s*string)?\s*=\s*["'][^"']*["'];/;
const BUILT_IN_APP_MARKER = "targeted-qa-detox";
const E2E_APP_VERSION = "1.0";
const E2E_DEFAULT_COHORT = process.env.HOT_UPDATER_E2E_DEFAULT_COHORT || "782";
const E2E_IOS_COHORT_DEFAULTS_KEY = "HotUpdater_CustomCohort";
const E2E_ANDROID_COHORT_PREFS_FILE = "HotUpdaterCohort.xml";
const E2E_ANDROID_COHORT_PREFS_KEY = "custom_cohort";
const E2E_RUNTIME_CONFIG_URL_ENV_KEY = "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL";
const DEPLOY_MAX_OLD_SPACE_SIZE_ENV_KEY =
  "HOT_UPDATER_E2E_DEPLOY_MAX_OLD_SPACE_SIZE_MB";
const DEPLOY_PROCESS_LOCK_DIR_ENV_KEY = "HOT_UPDATER_E2E_DEPLOY_LOCK_DIR";
const DEFAULT_DEPLOY_MAX_OLD_SPACE_SIZE_MB = 8192;
const NODE_MAX_OLD_SPACE_SIZE_PATTERN = /^--max-old-space-size(?:=|$)/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SIZE_AWARE_LARGE_ASSET_RELATIVE_PATH =
  "src/test/_fixture-size-aware-large-compressible.bmp";
const SIZE_AWARE_LARGE_BMP_WIDTH = 4096;
const SIZE_AWARE_LARGE_BMP_HEIGHT = 4096;
const SIZE_AWARE_LARGE_BMP_HEADER_SIZE = 54;
const SIZE_AWARE_LARGE_BMP_ROW_SIZE = SIZE_AWARE_LARGE_BMP_WIDTH * 3;
const SIZE_AWARE_LARGE_ASSET_SIZE_BYTES =
  SIZE_AWARE_LARGE_BMP_HEADER_SIZE +
  SIZE_AWARE_LARGE_BMP_ROW_SIZE * SIZE_AWARE_LARGE_BMP_HEIGHT;
const MULTI_ASSET_FIXTURES = [
  {
    androidManifestPath: "raw/src_test__fixturemultiasseta.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-a.bmp",
    relativePath: "src/test/_fixture-multi-asset-a.bmp",
  },
  {
    androidManifestPath: "raw/src_test__fixturemultiassetb.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-b.bmp",
    relativePath: "src/test/_fixture-multi-asset-b.bmp",
  },
  {
    androidManifestPath: "raw/src_test__fixturemultiassetc.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-c.bmp",
    relativePath: "src/test/_fixture-multi-asset-c.bmp",
  },
  {
    androidManifestPath: PAX_LONG_ASSET_ANDROID_MANIFEST_PATH,
    manifestPath: PAX_LONG_ASSET_MANIFEST_PATH,
    relativePath: PAX_LONG_ASSET_RELATIVE_PATH,
  },
] as const;
const MULTI_ASSET_BMP_WIDTH = 64;
const MULTI_ASSET_BMP_HEIGHT = 64;
const MULTI_ASSET_BMP_HEADER_SIZE = 54;
const MULTI_ASSET_BMP_ROW_SIZE = Math.ceil((MULTI_ASSET_BMP_WIDTH * 3) / 4) * 4;
const MULTI_ASSET_BMP_SIZE_BYTES =
  MULTI_ASSET_BMP_HEADER_SIZE +
  MULTI_ASSET_BMP_ROW_SIZE * MULTI_ASSET_BMP_HEIGHT;
const PROVIDER_READY_WAIT_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_PROVIDER_READY_WAIT_ATTEMPTS || 120,
);
const PROVIDER_READY_WAIT_DELAY_MS = Number(
  process.env.HOT_UPDATER_E2E_PROVIDER_READY_WAIT_DELAY_MS || 1000,
);
const PROVIDER_READY_HTTP_TIMEOUT_MS = Number(
  process.env.HOT_UPDATER_E2E_PROVIDER_READY_HTTP_TIMEOUT_MS || 2000,
);
const REMOTE_RESET_READINESS_LIMIT = 100;
const PROVIDER_READY_BUNDLE_LIMITS = [1, REMOTE_RESET_READINESS_LIMIT] as const;
const UPDATE_CHECK_HTTP_TIMEOUT_MS = Number(
  process.env.HOT_UPDATER_E2E_UPDATE_CHECK_HTTP_TIMEOUT_MS || 2000,
);
const UPDATE_CHECK_VISIBILITY_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_UPDATE_CHECK_VISIBILITY_ATTEMPTS || 60,
);
const UPDATE_CHECK_EXCLUSION_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_UPDATE_CHECK_EXCLUSION_ATTEMPTS || 60,
);
const UPDATE_CHECK_PROGRESS_LOG_INTERVAL = 10;
const AUTO_PATCH_METADATA_WAIT_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_AUTO_PATCH_METADATA_WAIT_ATTEMPTS || 120,
);
const AUTO_PATCH_METADATA_WAIT_DELAY_MS = Number(
  process.env.HOT_UPDATER_E2E_AUTO_PATCH_METADATA_WAIT_DELAY_MS || 500,
);
const E2E_POLL_INTERVAL_MS = Number(
  process.env.HOT_UPDATER_E2E_POLL_INTERVAL_MS || 250,
);
const E2E_IOS_LOG_SHOW_TIMEOUT_MS = Number(
  process.env.HOT_UPDATER_E2E_IOS_LOG_SHOW_TIMEOUT_MS || 30_000,
);
const E2E_ANDROID_LAUNCH_SETTLE_MS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_LAUNCH_SETTLE_MS || 1000,
);
const E2E_ANDROID_FOREGROUND_POLL_MS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_FOREGROUND_POLL_MS || 500,
);
const E2E_ANDROID_RESTART_WAIT_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_RESTART_WAIT_ATTEMPTS || 120,
);
const E2E_ANDROID_RESTART_STABLE_OBSERVATIONS = 3;
const E2E_ANDROID_ANR_DISMISS_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_ANR_DISMISS_ATTEMPTS || 6,
);
const E2E_IOS_LAUNCH_SETTLE_MS = Number(
  process.env.HOT_UPDATER_E2E_IOS_LAUNCH_SETTLE_MS || 1000,
);
const E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH = Number(
  process.env.HOT_UPDATER_E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH || 120,
);
const E2E_ANDROID_METADATA_WAIT_ATTEMPTS_PER_LAUNCH = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_METADATA_WAIT_ATTEMPTS_PER_LAUNCH || 40,
);
const E2E_METADATA_WAIT_RELAUNCH_LIMIT = Number(
  process.env.HOT_UPDATER_E2E_METADATA_WAIT_RELAUNCH_LIMIT || 2,
);
const LOG_PREFIX = "[e2e]";

function truncateForLog(value: string, maxLength = 400) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatLogValue(value: unknown) {
  if (typeof value === "string") {
    return truncateForLog(value);
  }

  try {
    return truncateForLog(JSON.stringify(value));
  } catch {
    return truncateForLog(String(value));
  }
}

function logE2eFixture(event: string, details?: unknown) {
  const suffix = details === undefined ? "" : ` ${formatLogValue(details)}`;
  console.log(`${LOG_PREFIX} ${event}${suffix}`);
}

function shouldLogUpdateCheckProgress(attempt: number, attempts: number) {
  return (
    attempt === 1 ||
    attempt === attempts ||
    attempt % UPDATE_CHECK_PROGRESS_LOG_INTERVAL === 0
  );
}

function writeResultDiagnosticFile(fileName: string, contents: string) {
  const filePath = path.join(fixtureSession.resultsDir, fileName);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatErrorCause(error: unknown) {
  if (!(error instanceof Error) || error.cause === undefined) {
    return undefined;
  }

  const cause = error.cause;
  if (cause instanceof Error) {
    return {
      message: cause.message,
      name: cause.name,
      stack: cause.stack,
    };
  }

  return String(cause);
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const platform = process.env.HOT_UPDATER_E2E_PLATFORM as Platform | undefined;
const appId = process.env.HOT_UPDATER_E2E_APP_ID;
const deviceId = process.env.HOT_UPDATER_E2E_DEVICE_ID;
const resultsDir = process.env.HOT_UPDATER_E2E_RESULTS_DIR;

if (!platform || (platform !== "ios" && platform !== "android")) {
  throw new Error("HOT_UPDATER_E2E_PLATFORM must be ios or android");
}
if (!appId) {
  throw new Error("HOT_UPDATER_E2E_APP_ID is required");
}
if (!deviceId) {
  throw new Error("HOT_UPDATER_E2E_DEVICE_ID is required");
}
if (!resultsDir) {
  throw new Error("HOT_UPDATER_E2E_RESULTS_DIR is required");
}

const fixtureSession: SessionState = {
  appBaseUrl:
    process.env.HOT_UPDATER_E2E_APP_BASE_URL ??
    "http://localhost:3007/hot-updater",
  appBackupPath: null,
  appId,
  appSourceFile: E2E_PATCH_SOURCE_FILE,
  bootstrapResult: null,
  builtInBundleId: null,
  configBackupPath: null,
  configSourceFile: HOT_UPDATER_CONFIG_FILE,
  deployedBundles: [],
  envBackupPath: null,
  envSourceFile: HOT_UPDATER_ENV_FILE,
  exampleDir: EXAMPLE_DIR,
  initialMarker: BUILT_IN_APP_MARKER,
  multiAssetBackupPaths: {},
  observedInsightsEvents: [],
  platform,
  resultsDir,
  sizeAwareLargeAssetBackupCaptured: false,
  sizeAwareLargeAssetBackupPath: null,
  sizeAwareLargeAssetPath: path.join(
    EXAMPLE_DIR,
    SIZE_AWARE_LARGE_ASSET_RELATIVE_PATH,
  ),
  storePath: null,
  lynxScopePath: null,
};

const channelNamespace =
  process.env.HOT_UPDATER_E2E_CHANNEL_NAMESPACE?.trim() || null;

function getFixtureChannel(channel: string) {
  return channelNamespace ? `${channelNamespace}-${channel}` : channel;
}

function getFixtureResetChannels() {
  return resolveFixtureResetChannels(channelNamespace);
}

const jobs = createControlJobs({
  onError: (jobId, error, cancelled) => {
    logE2eFixture(cancelled ? "control job cancelled" : "control job failed", {
      cause: formatErrorCause(error),
      error: error instanceof Error ? error.message : String(error),
      jobId,
      stack: error instanceof Error ? error.stack : undefined,
    });
  },
});
type RemoteAssetKind = "archive" | "file" | "manifest" | "patch";
type RemoteAssetProxyTarget = {
  readonly assetPath?: string;
  readonly kind: RemoteAssetKind;
  readonly url: string;
};
const remoteAssetProxyTargets = new Map<string, RemoteAssetProxyTarget>();
type CapturedProxyResponse = {
  readonly body: string;
  readonly headers: readonly [string, string][];
  readonly status: number;
  readonly statusText: string;
};
type CapturedArtifactSelection = ArtifactSelectionEvidence & {
  readonly archiveUrl: string | null;
  readonly assets: ReadonlyArray<{
    fileHash: string;
    fileUrl: string;
    patchUrl: string | null;
    path: string;
  }>;
  readonly artifactProtocolVersion: number | null;
  readonly assetCount: number;
  readonly assetFileCount: number;
  readonly assetPatchCount: number;
  readonly assetsPresent: boolean;
  readonly currentBundleId: string;
  readonly manifestFileHashPresent: boolean;
  readonly manifestUrlPresent: boolean;
  readonly targetBundleId: string;
};
const proxyRequestCounts = {
  artifact: 0,
  catalog: 0,
  legacy: 0,
};
const capturedArtifactSelections: CapturedArtifactSelection[] = [];
const remoteAssetTransfers = new Map<
  string,
  { requests: number; bytes: number }
>();
let artifactFailuresRemaining = 0;
let downloadAvailable = true;
let failedDownloads = 0;
let changedAssetMutation: {
  assetPath: string;
  mode: "corrupt" | "missing";
  remaining: number;
} | null = null;
let archiveAvailable = true;
let archiveFailureMode: "corrupt" | "not-found" | null = null;
let archiveFailuresRemaining = 0;
const proxyPathCounts = new Map<string, number>();
const capturedCatalogResponses = new Map<
  string,
  Map<number, CapturedProxyResponse>
>();
let catalogProxyMode: "freeze" | "live" | "replay" = "live";
let replayCatalogGeneration: number | null = null;
let catalogResponseDelayMs = 0;
let artifactResponseDelayMs = 0;
let bootstrapJobId: string | null = null;
let androidLaunchLogMarker: string | null = null;
let automaticForceUpdate: boolean | null = null;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

async function abortableSleep(durationMs: number, signal?: AbortSignal) {
  await sleep(durationMs, undefined, signal ? { signal } : undefined);
}

function fetchSignal(timeoutMs: number, signal?: AbortSignal) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

function captureCommand(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.status}\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

async function runLoggedCommand(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logPath: string;
    signal?: AbortSignal;
    onInterrupted?: () => void;
  },
) {
  throwIfAborted(options.signal);
  await fsPromises.mkdir(path.dirname(options.logPath), { recursive: true });

  const output: Buffer[] = [];
  const logStream = fs.createWriteStream(options.logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childExited = false;
  let killTimer: NodeJS.Timeout | null = null;
  const killChildGroup = () => {
    if (childExited || child.pid === undefined) {
      return;
    }

    options.onInterrupted?.();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }
    }
    killTimer = setTimeout(() => {
      if (childExited || child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
      }
    }, 5000);
    killTimer.unref();
  };
  process.once("exit", killChildGroup);
  options.signal?.addEventListener("abort", killChildGroup, { once: true });
  if (options.signal?.aborted) {
    killChildGroup();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    output.push(chunk);
    logStream.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.push(chunk);
    logStream.write(chunk);
  });

  const exitResult = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      childExited = true;
      process.removeListener("exit", killChildGroup);
      options.signal?.removeEventListener("abort", killChildGroup);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ code, signal });
    });
  });

  await new Promise((resolve) =>
    setTimeout(resolve, COMMAND_STDIO_DRAIN_GRACE_MS),
  );
  logStream.end();
  throwIfAborted(options.signal);

  if ((exitResult.code !== 0 || exitResult.signal) && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${
        exitResult.signal ?? `code ${exitResult.code}`
      }. See ${options.logPath}`,
    );
  }

  return Buffer.concat(output).toString("utf8");
}

const RELEASE_BUNDLE_ENV = {
  NODE_ENV: "production",
  BABEL_ENV: "production",
} satisfies NodeJS.ProcessEnv;

function stripAnsi(value: string) {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

function extractDeployReleaseId(output: string) {
  const plainOutput = stripAnsi(output);
  const match = plainOutput.match(
    /^[ \t│]*ID:[ \t]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*$/im,
  );

  return match?.[1] ?? null;
}

function bareBuildCacheRoot() {
  const cacheDir = process.env.HOT_UPDATER_E2E_BARE_BUILD_CACHE_DIR;
  if (!cacheDir) {
    return null;
  }

  return path.resolve(REPO_DIR, cacheDir);
}

function deployProcessLockRoot() {
  const lockDir = process.env[DEPLOY_PROCESS_LOCK_DIR_ENV_KEY];
  if (lockDir) {
    return path.resolve(REPO_DIR, lockDir);
  }

  const worktreeHash = createHash("sha256")
    .update(REPO_DIR)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), "hot-updater-e2e-deploy-lock", worktreeHash);
}

function readGitTrackedInputFiles(inputPaths: string[]) {
  const output = captureCommand(
    "git",
    ["ls-files", "-z", "--", ...inputPaths],
    {
      cwd: REPO_DIR,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  return output.split("\0").filter(Boolean).sort();
}

function readCacheInputFiles(inputPaths: string[]) {
  const files = new Set(readGitTrackedInputFiles(inputPaths));
  for (const relativePath of inputPaths) {
    const absolutePath = path.join(REPO_DIR, relativePath);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      files.add(relativePath);
    }
  }

  return [...files].sort();
}

function hashCacheInputFiles(inputPaths: string[]) {
  const hash = createHash("sha256");
  for (const relativePath of readCacheInputFiles(inputPaths)) {
    const absolutePath = path.join(REPO_DIR, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      continue;
    }

    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function hashBareBuildInputs() {
  return hashCacheInputFiles(BARE_BUILD_CACHE_INPUT_PATHS);
}

function bareBuildConfigFingerprint() {
  const source = fs.existsSync(HOT_UPDATER_CONFIG_FILE)
    ? fs.readFileSync(HOT_UPDATER_CONFIG_FILE, "utf8")
    : "";
  const match = source.match(BARE_BUILD_INLINE_PATTERN);

  return hashText(match?.[0] ?? "missing");
}

async function exportNativePublicKeyFromSigningKey() {
  const privateKeyPath = path.join(
    fixtureSession.exampleDir,
    SIGNING_PRIVATE_KEY_RELATIVE_PATH,
  );

  if (!fs.existsSync(privateKeyPath)) {
    logE2eFixture("native public key export skipped", {
      privateKeyPath: path.relative(REPO_DIR, privateKeyPath),
      reason: "private key file missing",
    });
    return;
  }

  await runLoggedCommand(
    "node",
    [HOT_UPDATER_CLI_PATH, "keys", "export-public", "--yes"],
    {
      cwd: fixtureSession.exampleDir,
      env: RELEASE_BUNDLE_ENV,
      logPath: path.join(fixtureSession.resultsDir, "keys-export-public.log"),
    },
  );

  logE2eFixture("native public key exported", {
    privateKeyPath: path.relative(REPO_DIR, privateKeyPath),
  });
}

async function backupFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const backupDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hu-e2e-"));
  const backupPath = path.join(backupDir, path.basename(filePath));
  await fsPromises.copyFile(filePath, backupPath);
  return backupPath;
}

async function restoreFile(sourcePath: string | null, targetPath: string) {
  if (!sourcePath) {
    await fsPromises.rm(targetPath, { force: true });
    return;
  }

  await fsPromises.copyFile(sourcePath, targetPath);
}

function fillDeterministicPseudoRandomChunk(buffer: Buffer, seed: number) {
  let state = seed >>> 0;
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    buffer.writeUInt32LE(state, offset);
    offset += 4;
  }

  if (offset < buffer.length) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;

    for (let index = offset; index < buffer.length; index += 1) {
      buffer[index] = (state >>> ((index - offset) * 8)) & 0xff;
    }
  }

  return state;
}

function createMultiAssetBmpHeader() {
  const header = Buffer.alloc(MULTI_ASSET_BMP_HEADER_SIZE);
  const pixelDataSize = MULTI_ASSET_BMP_ROW_SIZE * MULTI_ASSET_BMP_HEIGHT;

  header.write("BM", 0, "ascii");
  header.writeUInt32LE(MULTI_ASSET_BMP_SIZE_BYTES, 2);
  header.writeUInt32LE(MULTI_ASSET_BMP_HEADER_SIZE, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(MULTI_ASSET_BMP_WIDTH, 18);
  header.writeInt32LE(MULTI_ASSET_BMP_HEIGHT, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixelDataSize, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);

  return header;
}

function createMultiAssetBmpBuffer(seedInput: string) {
  const seed = createHash("sha256").update(seedInput).digest().readUInt32LE(0);
  const pixelData = Buffer.alloc(
    MULTI_ASSET_BMP_ROW_SIZE * MULTI_ASSET_BMP_HEIGHT,
  );

  fillDeterministicPseudoRandomChunk(pixelData, seed);

  return Buffer.concat([createMultiAssetBmpHeader(), pixelData]);
}

async function ensureMultiAssetFixtures(marker: string) {
  for (const fixture of MULTI_ASSET_FIXTURES) {
    const assetPath = path.join(EXAMPLE_DIR, fixture.relativePath);

    if (!(fixture.relativePath in fixtureSession.multiAssetBackupPaths)) {
      fixtureSession.multiAssetBackupPaths[fixture.relativePath] =
        await backupFile(assetPath);
    }

    await fsPromises.mkdir(path.dirname(assetPath), { recursive: true });
    await fsPromises.writeFile(
      assetPath,
      createMultiAssetBmpBuffer(`${marker}:${fixture.relativePath}`),
    );
  }

  logE2eFixture("multi asset fixtures ready", {
    marker,
    paths: MULTI_ASSET_FIXTURES.map((fixture) => fixture.relativePath),
    sizeBytes: MULTI_ASSET_BMP_SIZE_BYTES,
  });
}

async function restoreGeneratedDeployFixtures() {
  await restoreDeployFixtures([
    {
      backupPath: fixtureSession.sizeAwareLargeAssetBackupPath,
      targetPath: fixtureSession.sizeAwareLargeAssetPath,
    },
    ...MULTI_ASSET_FIXTURES.map((fixture) => ({
      backupPath:
        fixtureSession.multiAssetBackupPaths[fixture.relativePath] ?? null,
      targetPath: path.join(EXAMPLE_DIR, fixture.relativePath),
    })),
  ]);
}

function createSizeAwareLargeBmpHeader() {
  const header = Buffer.alloc(SIZE_AWARE_LARGE_BMP_HEADER_SIZE);
  const pixelDataSize =
    SIZE_AWARE_LARGE_BMP_ROW_SIZE * SIZE_AWARE_LARGE_BMP_HEIGHT;

  header.write("BM", 0, "ascii");
  header.writeUInt32LE(SIZE_AWARE_LARGE_ASSET_SIZE_BYTES, 2);
  header.writeUInt32LE(SIZE_AWARE_LARGE_BMP_HEADER_SIZE, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(SIZE_AWARE_LARGE_BMP_WIDTH, 18);
  header.writeInt32LE(SIZE_AWARE_LARGE_BMP_HEIGHT, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixelDataSize, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);

  return header;
}

async function ensureSizeAwareLargeAsset(marker: string) {
  if (!fixtureSession.sizeAwareLargeAssetBackupCaptured) {
    fixtureSession.sizeAwareLargeAssetBackupPath = await backupFile(
      fixtureSession.sizeAwareLargeAssetPath,
    );
    fixtureSession.sizeAwareLargeAssetBackupCaptured = true;
  }

  await fsPromises.mkdir(path.dirname(fixtureSession.sizeAwareLargeAssetPath), {
    recursive: true,
  });
  const handle = await fsPromises.open(
    fixtureSession.sizeAwareLargeAssetPath,
    "w",
  );
  try {
    const header = createSizeAwareLargeBmpHeader();
    await handle.write(header, 0, header.length);
    await handle.truncate(SIZE_AWARE_LARGE_ASSET_SIZE_BYTES);
    const variantBytes = createHash("sha256").update(marker).digest();
    await handle.write(
      variantBytes,
      0,
      variantBytes.length,
      SIZE_AWARE_LARGE_BMP_HEADER_SIZE,
    );
  } finally {
    await handle.close();
  }

  logE2eFixture("size-aware compressible asset ready", {
    marker,
    path: path.relative(REPO_DIR, fixtureSession.sizeAwareLargeAssetPath),
    sizeBytes: SIZE_AWARE_LARGE_ASSET_SIZE_BYTES,
  });
}

function resolveBundleProfile(value: BundleProfile | undefined): BundleProfile {
  return value ?? "default";
}

async function applyAppScenario({
  bundleProfile,
  marker,
  mode,
  safeBundleIds,
}: {
  bundleProfile: BundleProfile;
  marker: string;
  mode: DeployMode;
  safeBundleIds: string[];
}) {
  const source = await fsPromises.readFile(
    fixtureSession.appSourceFile,
    "utf8",
  );

  if (!MARKER_PATTERN.test(source)) {
    throw createEndpointError(
      "Failed to locate E2E scenario marker in patchSurface.ts",
      {
        sourceFile: path.relative(REPO_DIR, fixtureSession.appSourceFile),
        sourceSnippet: sourceSnippet(source, "E2E_SCENARIO_MARKER"),
      },
    );
  }
  if (!CRASH_GUARD_PATTERN.test(source)) {
    throw new Error(
      "Failed to locate E2E crash guard markers in patchSurface.ts",
    );
  }
  if (!DEPLOY_ASSET_GUARD_PATTERN.test(source)) {
    throw new Error(
      "Failed to locate E2E deploy asset guard markers in patchSurface.ts",
    );
  }

  const crashGuardSource = isLynxE2eApp()
    ? [
        CRASH_GUARD_START,
        ...(mode === "crash"
          ? [
              '  await callE2eDiagnostic("armNextPageFatalFailure");',
              '  navigate({path: "detail.lynx.bundle"}, () => undefined);',
              "  return true;",
            ]
          : mode === "hang"
            ? [
                "  const { running } = await HotUpdater.getLaunchInfo();",
                "  await onStartupHang(running.bundleId);",
                "  const hangUntil = Date.now() + 600_000;",
                "  while (Date.now() < hangUntil) {}",
                "  return true;",
              ]
            : ["  return false;"]),
        CRASH_GUARD_END,
      ].join("\n")
    : mode !== "reset"
      ? [
          CRASH_GUARD_START,
          `  const E2E_SAFE_BUNDLE_IDS = new Set(${JSON.stringify(safeBundleIds, null, 2)});`,
          `  const E2E_BUILT_IN_MIN_BUNDLE_ID_SUFFIX = ${JSON.stringify(BUILT_IN_MIN_BUNDLE_ID_SUFFIX)};`,
          "  const E2E_CURRENT_BUNDLE_ID = HotUpdater.getManifest().bundleId;",
          "  const E2E_IS_BUILT_IN_BUNDLE =",
          '    typeof E2E_CURRENT_BUNDLE_ID === "string" &&',
          "    E2E_CURRENT_BUNDLE_ID.endsWith(E2E_BUILT_IN_MIN_BUNDLE_ID_SUFFIX);",
          "",
          "  if (!E2E_IS_BUILT_IN_BUNDLE && !E2E_SAFE_BUNDLE_IDS.has(E2E_CURRENT_BUNDLE_ID)) {",
          ...(mode === "hang"
            ? [
                '    console.log("HotUpdaterE2EStartupHang:" + E2E_CURRENT_BUNDLE_ID);',
                "    const hangUntil = Date.now() + 600_000;",
                "    while (Date.now() < hangUntil) {}",
              ]
            : ['    throw new Error("hot-updater e2e crash bundle");']),
          "  }",
          `  ${CRASH_GUARD_END}`,
        ].join("\n")
      : `${CRASH_GUARD_START}\n  ${CRASH_GUARD_END}`;
  const deployAssetSource = createDeployAssetGuardSource(
    bundleProfile,
    fixtureSession.appId,
  );

  const nextSource = source
    .replace(
      MARKER_PATTERN,
      `export const E2E_SCENARIO_MARKER = ${JSON.stringify(marker)};`,
    )
    .replace(CRASH_GUARD_PATTERN, crashGuardSource)
    .replace(DEPLOY_ASSET_GUARD_PATTERN, deployAssetSource);

  await fsPromises.writeFile(fixtureSession.appSourceFile, nextSource);
  logE2eFixture("app scenario applied", {
    bundleProfile,
    marker,
    mode,
    safeBundleIds,
    sourceFile: path.relative(REPO_DIR, fixtureSession.appSourceFile),
  });
}

async function applyDeployConfig({
  patchEnabled,
  patchMaxBaseBundles,
  strategy,
}: {
  patchEnabled: boolean;
  patchMaxBaseBundles?: number;
  strategy: "appVersion" | "fingerprint";
}) {
  const source = await fsPromises.readFile(
    fixtureSession.configSourceFile,
    "utf8",
  );

  if (!AUTO_PATCH_CONFIG_PATTERN.test(source)) {
    throw new Error(
      "Failed to locate E2E auto patch config markers in hot-updater.config.ts",
    );
  }
  if (!UPDATE_STRATEGY_CONFIG_PATTERN.test(source)) {
    throw new Error("Failed to locate updateStrategy in hot-updater.config.ts");
  }

  const autoPatchSource = patchEnabled
    ? [
        AUTO_PATCH_CONFIG_GUARD_START,
        "  patch: {",
        "    enabled: true,",
        ...(typeof patchMaxBaseBundles === "number"
          ? [`    maxBaseBundles: ${patchMaxBaseBundles},`]
          : []),
        "  },",
        `  ${AUTO_PATCH_CONFIG_GUARD_END}`,
      ].join("\n")
    : `${AUTO_PATCH_CONFIG_GUARD_START}\n  ${AUTO_PATCH_CONFIG_GUARD_END}`;

  const sourceWithUpdateStrategy = source.replace(
    UPDATE_STRATEGY_CONFIG_PATTERN,
    `updateStrategy: ${JSON.stringify(strategy)}`,
  );
  const sourceWithWarmMetroCache = sourceWithUpdateStrategy.replace(
    BARE_BUILD_INLINE_PATTERN,
    (match, prefix: string, options: string, suffix: string) => {
      if (/\bresetCache\s*:/.test(options)) {
        return match;
      }

      const trimmedOptions = options.trim();
      const nextOptions = trimmedOptions
        ? `${trimmedOptions}, resetCache: false`
        : "resetCache: false";
      return `${prefix}${nextOptions}${suffix}`;
    },
  );
  const deployBaseUrl = getControllerReachableAppBaseUrl();
  const sourceWithDeployBaseUrl = sourceWithWarmMetroCache.replace(
    STANDALONE_REPOSITORY_BASE_URL_PATTERN,
    (_match, prefix: string) =>
      `${prefix}${JSON.stringify(`${deployBaseUrl}/admin`)}`,
  );

  await fsPromises.writeFile(
    fixtureSession.configSourceFile,
    sourceWithDeployBaseUrl.replace(AUTO_PATCH_CONFIG_PATTERN, autoPatchSource),
  );
  logE2eFixture("deploy config applied", {
    deployBaseUrl,
    patchEnabled,
    patchMaxBaseBundles: patchMaxBaseBundles ?? null,
    resetMetroCache: false,
    sourceFile: path.relative(REPO_DIR, fixtureSession.configSourceFile),
    strategy,
  });
}

async function waitForFile(filePath: string, attempts = 360) {
  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(E2E_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

/** The server the example's config describes: its database, core on it, and the plugins it runs. */
type ConfiguredServer = {
  readonly core: HotUpdaterCoreApi;
  readonly database: ConfiguredDatabase;
  readonly plugins: readonly AnyHotUpdaterPlugin[];
};

async function withConfiguredDatabase<T>(
  callback: (configured: ConfiguredServer) => Promise<T>,
): Promise<T> {
  const originalCwd = process.cwd();

  try {
    process.chdir(fixtureSession.exampleDir);
    return await withHotUpdaterControlEnv(async () => {
      const { database, plugins } = await loadConfig(null);
      if (database === undefined) {
        throw new Error(
          "The example's hot-updater.config.ts sets no database.",
        );
      }
      try {
        return await callback({
          // Core alone, so the plugins' tables, which the server's
          // migrations create, never gate the fixtures the controller
          // writes. Over standaloneRepository, it is the server's admin API.
          core: assembleServer({ database }).core,
          database,
          plugins,
        });
      } finally {
        await database.dispose?.();
      }
    });
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * Insights read in process, as the console does: through the plugins the
 * server runs. Null, over standaloneRepository or without insights(), sends
 * the verification to the server's admin routes.
 */
function readInsightsModel({
  database,
  plugins,
}: ConfiguredServer): InsightsModel | null {
  // Insights alone, so the server's other plugins, whose tables the server's
  // migrations create, never gate what the verification reads.
  const { api } = assembleServer({
    database,
    plugins: plugins.filter(({ id }) => id === "insights"),
  });
  return api?.insights === undefined
    ? null
    : createInsightsModel(
        api.insights as Parameters<typeof createInsightsModel>[0],
      );
}

async function verifyConfiguredConsoleInsights(args: { sinceMs: number }) {
  return withConfiguredDatabase(async (configured) => {
    const insights = readInsightsModel(configured);
    const client = insights
      ? createConsoleInsightsProviderClient(createInsightsProvider(insights))
      : createConsoleInsightsHttpClient({
          baseUrl: `${getControllerReachableAppBaseUrl()}/admin`,
          headers: getHotUpdaterAdminHeaders(),
        });
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        const evidence = await verifyConsoleInsights(client, {
          observedEvents: fixtureSession.observedInsightsEvents,
          sinceMs: args.sinceMs,
        });
        return { skipped: false, ...evidence };
      } catch (error) {
        if (!(error instanceof ConsoleInsightsQaError) || attempt === 30) {
          throw error;
        }
        await sleep(1_000);
      }
    }
    throw new Error("Console Insights verification exhausted its retries.");
  });
}

async function fetchProviderBundleById(bundleId: string) {
  const detail = await withConfiguredDatabase(({ core }) =>
    core.getBundle(bundleId),
  );
  const bundle =
    detail === null ? null : rowToBundle(detail.bundle, detail.patches);

  if (!bundle) {
    throw new Error(`Failed to fetch bundle ${bundleId}: bundle not found`);
  }

  logE2eFixture("provider file details", {
    assetBaseStorageUri: bundle.assetBaseStorageUri,
    bundleId: bundle.id,
    manifestFileHash: bundle.manifestFileHash,
    manifestStorageUri: bundle.manifestStorageUri,
    platform: bundle.platform,
  });

  return bundle;
}

type DeployedRelease = {
  readonly catalogId: string;
  readonly catalog: ReleaseCatalogRow;
  readonly release: ReleaseRow;
};

async function resolveDeployedRelease(
  releaseId: string,
  channel: string,
): Promise<DeployedRelease> {
  let lastObserved: ReleaseRow | null = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = await withConfiguredDatabase(
      async ({ core }): Promise<DeployedRelease | null> => {
        const channelId = (await core.findChannelByName(channel))?.id;
        if (channelId === undefined) return null;
        const release = await core.getRelease(releaseId);
        lastObserved = release;
        if (
          release === null ||
          release.channel_id !== channelId ||
          release.platform !== fixtureSession.platform
        )
          return null;
        const catalog = await core.getReleaseCatalogRow(release.scope_key);
        return catalog === null
          ? null
          : { catalogId: catalog.catalog_id, catalog, release };
      },
    );
    if (result !== null) return result;
    await sleep(1_000);
  }

  throw createEndpointError(
    `Failed to resolve deployed update ID ${releaseId}`,
    { releaseId, channel, lastObserved },
  );
}

async function fetchProviderReleaseById(releaseId: string) {
  const release = await withConfiguredDatabase(({ core }) =>
    core.getRelease(releaseId),
  );
  if (release === null) {
    throw new Error(`No Release with id ${releaseId}.`);
  }
  return release;
}

async function patchProviderRelease(
  releaseId: string,
  patch: Omit<PatchReleaseRequest, "releaseId">,
) {
  const result = await withConfiguredDatabase(({ core }) =>
    core.updateReleasePolicy({
      patch: {
        enabled: patch.enabled,
        rolloutCohortCount: patch.rolloutCohortCount ?? undefined,
        shouldForceUpdate: patch.shouldForceUpdate,
        targetCohorts: patch.targetCohorts ?? undefined,
      },
      releaseId,
    }),
  );
  if (result.release === null) {
    throw new Error(`Release ${releaseId} disappeared during its policy edit.`);
  }
  logE2eFixture("hot-updater Release policy patch", {
    generation: result.catalog.generation,
    patch,
    releaseId,
    revision: result.release.revision,
  });
  return result;
}

function resolvePatchAssetPath(
  bundle: Bundle | null | undefined,
  baseBundleId: string,
) {
  const patch = bundle ? getBundlePatch(bundle, baseBundleId) : null;
  return patch
    ? inferPatchAssetPathFromStorageUri({
        baseBundleId,
        patchFileHash: patch.patchFileHash,
        patchStorageUri: patch.patchStorageUri,
      })
    : null;
}

function getBundlePatchBaseBundleIds(bundle: Bundle | null | undefined) {
  if (!bundle) {
    return [];
  }

  return getBundlePatches(bundle).map((patch) => patch.baseBundleId);
}

async function resolveAutoPatchBundleDiff(
  baseBundleId: string,
  bundleId: string,
) {
  let observed: Record<string, string | null> | null = null;

  for (
    let attempt = 1;
    attempt <= AUTO_PATCH_METADATA_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    const bundle = await fetchProviderBundleById(bundleId);
    const patchAssetPath = resolvePatchAssetPath(bundle, baseBundleId);
    const matchingPatch = getBundlePatch(bundle, baseBundleId);
    const patchBaseBundleId = matchingPatch?.baseBundleId ?? null;
    const patchBaseFileHash = matchingPatch?.baseFileHash ?? null;
    const patchFileHash = matchingPatch?.patchFileHash ?? null;
    const patchStorageUri = matchingPatch?.patchStorageUri ?? null;

    observed = {
      bundleId: bundle.id,
      patchAssetPath,
      patchBaseBundleId,
      patchBaseFileHash,
      patchFileHash,
      patchStorageUri,
    };

    if (
      bundle.id === bundleId &&
      patchBaseBundleId === baseBundleId &&
      patchAssetPath &&
      patchBaseFileHash &&
      patchFileHash &&
      patchStorageUri
    ) {
      logE2eFixture("auto patch metadata resolved", {
        attempt,
        baseBundleId,
        bundleId,
        patchAssetPath,
        patchStorageUri,
        platform: fixtureSession.platform,
      });

      return {
        baseBundleId,
        patchAssetPath,
      };
    }

    if (attempt < AUTO_PATCH_METADATA_WAIT_ATTEMPTS) {
      await sleep(AUTO_PATCH_METADATA_WAIT_DELAY_MS);
    }
  }

  throw createEndpointError(
    `Failed to resolve automatic bsdiff patch metadata for bundle ${bundleId}`,
    {
      attempts: AUTO_PATCH_METADATA_WAIT_ATTEMPTS,
      autoPatch: true,
      baseBundleId,
      bundleId,
      observed,
      retryDelayMs: AUTO_PATCH_METADATA_WAIT_DELAY_MS,
    },
  );
}

async function createFixtureBundleDiff(input: {
  baseBundleId: string;
  bundleId: string;
}) {
  await withHotUpdaterControlEnv(async () => {
    await runLoggedCommand(
      process.execPath,
      [
        HOT_UPDATER_CLI_PATH,
        "patch",
        "--artifact-id",
        input.bundleId,
        "--base-artifact-id",
        input.baseBundleId,
        "--platform",
        fixtureSession.platform,
      ],
      {
        cwd: fixtureSession.exampleDir,
        logPath: path.join(
          fixtureSession.resultsDir,
          `patch-${input.bundleId}-from-${input.baseBundleId}.log`,
        ),
      },
    );
  });
  const diff = await resolveAutoPatchBundleDiff(
    input.baseBundleId,
    input.bundleId,
  );
  const record = fixtureSession.deployedBundles.find(
    ({ bundleId }) => bundleId === input.bundleId,
  );
  if (record) {
    record.diffBaseBundleId = diff.baseBundleId;
    record.diffPatchAssetPath = diff.patchAssetPath;
    record.patchBaseBundleIds = getBundlePatchBaseBundleIds(
      await fetchProviderBundleById(input.bundleId),
    );
  }
  return diff;
}

async function clearProviderReleases() {
  const result = await withConfiguredDatabase(({ core }) =>
    resetFixtureReleases({
      core,
      namespace: channelNamespace,
      platform: fixtureSession.platform,
    }),
  );
  logE2eFixture("remote Releases reset", {
    channels: result.channels,
    clearedCount: result.clearedReleaseIds.length,
    clearedReleaseIds: result.clearedReleaseIds,
    platform: fixtureSession.platform,
  });
}

async function clearProviderReleasesAfterReadiness() {
  await resetProviderAfterReady(clearProviderReleases, {
    onRetry: ({ attempt, error, retryDelayMs }) => {
      logE2eFixture("provider reset connection retry", {
        attempt,
        error: formatErrorMessage(error),
        platform: fixtureSession.platform,
        retryDelayMs,
      });
    },
  });
}

function updateTrackedReleaseRecord(
  releaseId: string,
  patch: {
    enabled?: boolean;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[] | null;
  },
) {
  const record = fixtureSession.deployedBundles.find(
    (entry) => entry.releaseId === releaseId,
  );

  if (!record) {
    return;
  }

  if (patch.enabled !== undefined) {
    record.enabled = patch.enabled;
  }

  if (patch.rolloutCohortCount !== undefined) {
    record.rolloutCohortCount = patch.rolloutCohortCount;
  }

  if (patch.shouldForceUpdate !== undefined) {
    record.shouldForceUpdate = patch.shouldForceUpdate;
  }

  if (patch.targetCohorts !== undefined) {
    record.targetCohorts = patch.targetCohorts;
  }
}

function isLynxE2eApp() {
  return isLynxE2eAppId(fixtureSession.appId);
}

function iosAppDataDir() {
  return captureCommand("xcrun", [
    "simctl",
    "get_app_container",
    deviceId as string,
    fixtureSession.appId,
    "data",
  ]);
}

function lynxIosStoresDir() {
  return path.join(
    iosAppDataDir(),
    "Library/Application Support/HotUpdaterLynxPublic/stores",
  );
}

function listAndroidRunAsEntries(relativeDir: string) {
  const output = captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      fixtureSession.appId,
      "ls",
      "-1",
      relativeDir,
    ],
    { allowFailure: true },
  );
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "." && entry !== "..");
}

function rememberLynxStore(scopePath: string, storePath: string) {
  fixtureSession.lynxScopePath = scopePath;
  fixtureSession.storePath = storePath;
  return storePath;
}

function ensureLynxIosStorePath() {
  const stores = lynxIosStoresDir();
  try {
    for (const scope of fs.readdirSync(stores)) {
      const scopePath = path.join(stores, scope);
      const bundles = path.join(scopePath, "bundles");
      if (!fs.existsSync(bundles)) {
        continue;
      }
      for (const bundleId of fs.readdirSync(bundles)) {
        if (fs.existsSync(path.join(bundles, bundleId, "manifest.json"))) {
          return rememberLynxStore(scopePath, bundles);
        }
      }
      if (fs.existsSync(path.join(scopePath, "state.json"))) {
        return rememberLynxStore(scopePath, bundles);
      }
    }
  } catch {
    // The Lynx store is created on first launch.
  }
  return null;
}

function ensureLynxAndroidStorePath() {
  const scopesRoot = `files/hot-updater-lynx/scopes`;
  for (const scope of listAndroidRunAsEntries(scopesRoot)) {
    const installations = `${scopesRoot}/${scope}/artifacts/installations`;
    const bundleIds = listAndroidRunAsEntries(installations);
    const hasManifest = bundleIds.some((bundleId) =>
      lynxAndroidInstalledManifestPaths(
        fixtureSession.appId,
        scope,
        bundleId,
      ).some((manifestPath) => androidFileExists(manifestPath)),
    );
    if (
      hasManifest ||
      androidFileExists(
        `/data/data/${fixtureSession.appId}/${scopesRoot}/${scope}/state.json`,
      )
    ) {
      return rememberLynxStore(
        `/data/data/${fixtureSession.appId}/${scopesRoot}/${scope}`,
        `/data/data/${fixtureSession.appId}/${installations}`,
      );
    }
  }
  return null;
}

function ensureLynxScopePath() {
  if (fixtureSession.lynxScopePath) {
    return fixtureSession.lynxScopePath;
  }
  if (fixtureSession.platform === "ios") {
    ensureLynxIosStorePath();
  } else {
    ensureLynxAndroidStorePath();
  }
  return fixtureSession.lynxScopePath;
}

function ensureStorePath() {
  if (fixtureSession.storePath) {
    return fixtureSession.storePath;
  }

  if (fixtureSession.platform === "ios") {
    if (isLynxE2eApp()) {
      const lynxStorePath = ensureLynxIosStorePath();
      if (lynxStorePath) {
        return lynxStorePath;
      }
    }
    fixtureSession.storePath = path.join(
      iosAppDataDir(),
      "Documents/bundle-store",
    );
    return fixtureSession.storePath;
  }

  if (isLynxE2eApp()) {
    const lynxStorePath = ensureLynxAndroidStorePath();
    if (lynxStorePath) {
      return lynxStorePath;
    }
  }

  fixtureSession.storePath = `/data/data/${fixtureSession.appId}/files/bundle-store`;
  return fixtureSession.storePath;
}

function findLynxIosBundleDir(bundleId: string) {
  if (bundleId === LYNX_E2E_BUILTIN_BUNDLE_ID) {
    const app = captureCommand("xcrun", [
      "simctl",
      "get_app_container",
      deviceId as string,
      fixtureSession.appId,
      "app",
    ]);
    for (const relative of ["Embedded/Public/react", "Public/react"]) {
      const directory = path.join(app, relative);
      const manifest = readOptionalJsonSnapshot(
        path.join(directory, "manifest.json"),
      );
      if (manifest.value?.bundleId === bundleId) return directory;
    }
    return null;
  }
  const stores = lynxIosStoresDir();
  try {
    for (const scope of fs.readdirSync(stores)) {
      const bundleDir = path.join(stores, scope, "bundles", bundleId);
      if (fs.existsSync(path.join(bundleDir, "manifest.json"))) {
        rememberLynxStore(path.join(stores, scope), path.dirname(bundleDir));
        return bundleDir;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function findLynxAndroidBundleDir(bundleId: string) {
  if (bundleId === LYNX_E2E_BUILTIN_BUNDLE_ID) {
    const root = "files/hot-updater-lynx/embedded";
    for (const digest of listAndroidRunAsEntries(root)) {
      if (!/^[a-f0-9]{64}$/.test(digest)) continue;
      const directory = `/data/data/${fixtureSession.appId}/${root}/${digest}`;
      const { fileBuffer } = readAndroidFileBuffer(
        `${directory}/manifest.json`,
      );
      if (
        !fileBuffer ||
        createHash("sha256").update(fileBuffer).digest("hex") !== digest
      )
        continue;
      if (JSON.parse(fileBuffer.toString("utf8")).bundleId === bundleId)
        return directory;
    }
    return null;
  }
  const scopesRoot = `files/hot-updater-lynx/scopes`;
  for (const scope of listAndroidRunAsEntries(scopesRoot)) {
    for (const manifestPath of lynxAndroidInstalledManifestPaths(
      fixtureSession.appId,
      scope,
      bundleId,
    )) {
      if (!androidFileExists(manifestPath)) {
        continue;
      }
      const bundleDir = path.posix.dirname(manifestPath);
      rememberLynxStore(
        `/data/data/${fixtureSession.appId}/${scopesRoot}/${scope}`,
        path.posix.dirname(
          bundleDir.endsWith("/payload")
            ? bundleDir.slice(0, -"/payload".length)
            : bundleDir,
        ),
      );
      return bundleDir;
    }
  }
  return null;
}

function readLynxJournalValue(): Record<string, unknown> | null {
  const scopePath = ensureLynxScopePath();
  if (!scopePath) {
    return null;
  }
  if (fixtureSession.platform === "ios") {
    const journalPath = path.join(scopePath, "state.json");
    if (!fs.existsSync(journalPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(journalPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }
  const result = readAndroidFileBuffer(`${scopePath}/state.json`);
  if (!result.fileBuffer) {
    return null;
  }
  try {
    return JSON.parse(result.fileBuffer.toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function readLynxSynthesizedSnapshot(
  fileName: "metadata.json" | "crashed-history.json" | "launch-report.json",
): JsonSnapshot {
  const scopePath = ensureLynxScopePath();
  const journalPath = scopePath
    ? `${scopePath.replace(/\\/g, "/")}/state.json`
    : "lynx-state.json";
  const journal = readLynxJournalValue();
  if (!journal) {
    return {
      exists: false,
      path: journalPath,
      readError: null,
      value: null,
    };
  }
  if (fileName === "metadata.json") {
    return {
      exists: true,
      path: journalPath,
      readError: null,
      value: synthesizeLynxMetadata(journal, fixtureSession.platform),
    };
  }
  if (fileName === "crashed-history.json") {
    return {
      exists: true,
      path: journalPath,
      readError: null,
      value: synthesizeLynxCrashHistory(journal, fixtureSession.platform),
    };
  }
  const report = readLynxLaunchReport(readE2eScreenStateSnapshot());
  return {
    exists: report !== null,
    path: "screen-state.nativeLaunchReport",
    readError: null,
    value: report,
  };
}

async function clearIosLocalBundleState() {
  captureCommand(
    "xcrun",
    ["simctl", "terminate", deviceId as string, fixtureSession.appId],
    { allowFailure: true },
  );
  captureCommand(
    "xcrun",
    [
      "simctl",
      "spawn",
      deviceId as string,
      "defaults",
      "delete",
      fixtureSession.appId,
    ],
    { allowFailure: true },
  );

  const appDataDir = iosAppDataDir();
  const documentsDir = path.join(appDataDir, "Documents");
  await fsPromises.rm(
    path.join(appDataDir, "Library/Application Support/HotUpdaterLynxPublic"),
    {
      force: true,
      recursive: true,
    },
  );

  await fsPromises.rm(path.join(documentsDir, "bundle-store"), {
    force: true,
    recursive: true,
  });
  await fsPromises.rm(path.join(documentsDir, "bundle-temp"), {
    force: true,
    recursive: true,
  });
  await fsPromises.rm(path.join(documentsDir, "bundle-manifest-temp"), {
    force: true,
    recursive: true,
  });
  await fsPromises.rm(path.join(appDataDir, "Library/Preferences"), {
    force: true,
    recursive: true,
  });
  // The install id and client plugin storage, such as the Insights plugin's
  // daily launch report and pause, live outside backups in Application
  // Support. Clearing them starts each scenario as a new installation, as
  // `pm clear` does on Android; the Release Catalog cache beside them stays.
  const noBackupDir = path.join(
    appDataDir,
    "Library/Application Support/HotUpdater",
  );
  const noBackupEntries = await fsPromises
    .readdir(noBackupDir)
    .catch((): string[] => []);
  for (const entry of noBackupEntries) {
    if (entry === "ReleaseCatalogCache") continue;
    await fsPromises.rm(path.join(noBackupDir, entry), {
      force: true,
      recursive: true,
    });
  }

  const stalePaths = [
    path.join(documentsDir, "bundle-store", "metadata.json"),
    path.join(documentsDir, "bundle-store"),
    path.join(documentsDir, "bundle-temp"),
    path.join(documentsDir, "bundle-manifest-temp"),
    path.join(noBackupDir, "storage.json"),
    path.join(noBackupDir, "install-identity.json"),
  ];
  for (const stalePath of stalePaths) {
    if (fs.existsSync(stalePath)) {
      throw new Error(`Failed to clear iOS local bundle state: ${stalePath}`);
    }
  }

  fixtureSession.storePath = null;
  fixtureSession.lynxScopePath = null;
  logE2eFixture("ios local bundle state reset", {
    documentsDir,
    noBackupDir,
  });
}

function ensureAndroidFilesDir() {
  return `/data/data/${fixtureSession.appId}/files`;
}

function clearAndroidLocalAppState() {
  resetAndroidPackageData();
  captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      fixtureSession.appId,
      "sh",
      "-c",
      [
        `rm -rf ${ensureAndroidFilesDir()}/bundle-store`,
        `${ensureAndroidFilesDir()}/bundle-temp`,
        `${ensureAndroidFilesDir()}/bundle-manifest-temp`,
        `${ensureAndroidFilesDir()}/hot-updater-lynx`,
        `/data/data/${fixtureSession.appId}/shared_prefs/HotUpdaterPrefs_*.xml`,
      ].join(" "),
    ],
    { allowFailure: true },
  );
  if (androidPathExists(`${ensureAndroidFilesDir()}/bundle-store`)) {
    throw new Error("Failed to clear Android bundle-store state");
  }
  fixtureSession.storePath = null;
  fixtureSession.lynxScopePath = null;
  logE2eFixture("android local app state reset", {
    appId: fixtureSession.appId,
  });
}

function resetAndroidPackageData() {
  captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "am",
      "force-stop",
      fixtureSession.appId,
    ],
    { allowFailure: true },
  );
  captureCommand(
    "adb",
    ["-s", deviceId as string, "shell", "pm", "clear", fixtureSession.appId],
    { allowFailure: true },
  );
}

function androidRunAsReadablePath(remotePath: string) {
  const appFilesPrefix = `/data/data/${fixtureSession.appId}/files/`;
  const userFilesPrefix = `/data/user/0/${fixtureSession.appId}/files/`;

  if (remotePath.startsWith(appFilesPrefix)) {
    return `files/${remotePath.slice(appFilesPrefix.length)}`;
  }
  if (remotePath.startsWith(userFilesPrefix)) {
    return `files/${remotePath.slice(userFilesPrefix.length)}`;
  }

  return remotePath;
}

function readAndroidFileBuffer(remotePath: string) {
  const runAsPath = androidRunAsReadablePath(remotePath);
  const readAttempts = [
    [
      "-s",
      deviceId as string,
      "exec-out",
      "run-as",
      fixtureSession.appId,
      "cat",
      runAsPath,
    ],
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      fixtureSession.appId,
      "cat",
      runAsPath,
    ],
    ["-s", deviceId as string, "shell", "cat", remotePath],
  ];
  const readErrors: string[] = [];

  for (const args of readAttempts) {
    const result = spawnSync("adb", args, {
      // Final-file assertions also read multi-megabyte Hermes bundles.
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return { fileBuffer: result.stdout, readError: null };
    }

    readErrors.push(
      result.stderr.toString().trim() ||
        result.error?.message ||
        `adb exited ${String(result.status)}`,
    );
  }

  return { fileBuffer: null, readError: readErrors.join(" | ") };
}

function copyAndroidFile(remotePath: string, localPath: string) {
  const result = readAndroidFileBuffer(remotePath);
  if (!result.fileBuffer) {
    throw new Error(
      `Failed to read ${remotePath} from Android device: ${result.readError}`,
    );
  }

  fs.writeFileSync(localPath, result.fileBuffer);
}

function androidFileExists(remotePath: string) {
  return androidPathExists(remotePath, "-f");
}

function androidPathExists(remotePath: string, testFlag = "-e") {
  const runAsPath = androidRunAsReadablePath(remotePath);
  let exists = spawnSync(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      fixtureSession.appId,
      "test",
      testFlag,
      runAsPath,
    ],
    { stdio: "ignore" },
  );

  if (exists.status !== 0) {
    exists = spawnSync(
      "adb",
      ["-s", deviceId as string, "shell", "[", testFlag, remotePath, "]"],
      { stdio: "ignore" },
    );
  }

  return exists.status === 0;
}

function copyAndroidFileIfExists(remotePath: string, localPath: string) {
  if (!androidFileExists(remotePath)) {
    return false;
  }

  copyAndroidFile(remotePath, localPath);
  return true;
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

function terminateFixtureApp() {
  if (fixtureSession.platform === "ios") {
    captureCommand(
      "xcrun",
      ["simctl", "terminate", deviceId as string, fixtureSession.appId],
      { allowFailure: true },
    );
    return;
  }
  captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "am",
      "force-stop",
      fixtureSession.appId,
    ],
    { allowFailure: true },
  );
}

function readDeviceStoreJson(fileName: string) {
  const storePath = ensureStorePath();
  if (fixtureSession.platform === "ios") {
    const filePath = path.join(storePath, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Device store file does not exist: ${filePath}`);
    }
    return readJson(filePath);
  }

  const result = readAndroidFileBuffer(`${storePath}/${fileName}`);
  if (result.fileBuffer === null) {
    throw new Error(
      `Failed to read Android device store file ${fileName}: ${result.readError}`,
    );
  }
  return JSON.parse(result.fileBuffer.toString("utf8")) as Record<
    string,
    unknown
  >;
}

function writeDeviceStoreJson(
  fileName: "crashed-history.json" | "metadata.json",
  value: Record<string, unknown>,
) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const storePath = ensureStorePath();
  if (fixtureSession.platform === "ios") {
    fs.mkdirSync(storePath, { recursive: true });
    fs.writeFileSync(path.join(storePath, fileName), serialized);
    return;
  }

  const result = spawnSync(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      fixtureSession.appId,
      "sh",
      "-c",
      shellSingleQuote(
        `mkdir -p files/bundle-store && cat > files/bundle-store/${fileName}`,
      ),
    ],
    { input: serialized, stdio: ["pipe", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to write Android device store file ${fileName}: ${result.stderr.toString()}`,
    );
  }
}

async function seedDeviceCrashHistory(bundleIds: readonly string[]) {
  terminateFixtureApp();
  const clamped = bundleIds.slice(-10);
  if (isLynxE2eApp()) {
    if (!ensureLynxScopePath()) {
      if (fixtureSession.platform === "ios") {
        launchIosApp();
      } else {
        launchAndroidApp();
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (ensureLynxScopePath()) break;
        await sleep(E2E_POLL_INTERVAL_MS);
      }
      terminateFixtureApp();
    }
    const scopePath = ensureLynxScopePath();
    if (!scopePath) {
      throw new Error("Lynx state store was not initialized by the app launch");
    }
    const state = readLynxJournalValue();
    if (!state) {
      throw new Error("Lynx state journal is unavailable");
    }
    state.revision = randomUUID();
    if (fixtureSession.platform === "ios") {
      state.crashedBundleIds = clamped;
      const statePath = path.join(scopePath, "state.json");
      const temporaryPath = path.join(scopePath, `.e2e-state-${randomUUID()}`);
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`);
      fs.renameSync(temporaryPath, statePath);
    } else {
      state.crashed = clamped;
      const statePath = androidRunAsReadablePath(`${scopePath}/state.json`);
      const temporaryPath = `${statePath}.e2e-${randomUUID()}`;
      const command = `cat > ${temporaryPath} && mv ${temporaryPath} ${statePath}`;
      const result = spawnSync(
        "adb",
        [
          "-s",
          deviceId as string,
          "shell",
          "run-as",
          fixtureSession.appId,
          "sh",
          "-c",
          shellSingleQuote(command),
        ],
        {
          input: `${JSON.stringify(state)}\n`,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `Failed to write Android Lynx state: ${result.stderr.toString()}`,
        );
      }
    }
    return { bundleIds: clamped, count: clamped.length };
  }
  writeDeviceStoreJson("crashed-history.json", {
    bundles: clamped.map((bundleId, index) => ({
      bundleId,
      crashCount: 1,
      crashedAt: Date.now() + index,
    })),
    maxHistorySize: 10,
  });
  return { bundleIds: clamped, count: clamped.length };
}

function seedLegacyDeviceMetadata() {
  if (isLynxE2eApp()) {
    throw createEndpointError(
      "metadata-v1-migration is unsupported for Lynx: legacy metadata belongs to React Native",
    );
  }
  terminateFixtureApp();
  const metadata = readDeviceStoreJson("metadata.json");
  metadata.schema = "metadata-v1";
  if (fixtureSession.platform === "ios") {
    delete metadata.stable_selection;
    delete metadata.staging_selection;
    delete metadata.pending_selection_transition;
    delete metadata.highest_seen_catalogs;
    delete metadata.current_selection_contexts;
  } else {
    delete metadata.stableSelection;
    delete metadata.stagingSelection;
    delete metadata.pendingTransition;
    delete metadata.highestSeenCatalogs;
    delete metadata.currentSelectionContexts;
  }
  writeDeviceStoreJson("metadata.json", metadata);
  const state = getMetadataState(metadata);
  return {
    schema: state.schema,
    stableBundleId: state.stableBundleId,
    stagingBundleId: state.stagingBundleId,
  };
}

function assertMetadataState(
  metadata: Record<string, unknown>,
  bundleId: string,
  releaseId?: string,
) {
  const metadataState = getMetadataState(metadata);
  const verificationPending = metadataState.verificationPending;

  if (!isMetadataActiveBundle(metadataState, bundleId)) {
    throw new Error(
      `Expected active bundle ${bundleId} but received stableBundleId=${String(metadataState.stableBundleId)} and stagingBundleId=${String(metadataState.stagingBundleId)}`,
    );
  }

  if (verificationPending !== false) {
    throw new Error(
      `Expected verificationPending false but received ${String(verificationPending)}`,
    );
  }

  const selection =
    metadataState.stagingSelection?.bundleId === bundleId
      ? metadataState.stagingSelection
      : metadataState.stableSelection?.bundleId === bundleId
        ? metadataState.stableSelection
        : null;
  if (selection === null || selection.kind !== "BUNDLE") {
    throw new Error(`Expected a BUNDLE receipt for active Bundle ${bundleId}`);
  }
  if (releaseId !== undefined && selection.releaseId !== releaseId) {
    throw new Error(
      `Expected active Release ${releaseId} but received ${String(selection.releaseId)}`,
    );
  }
  if (
    selection.releaseId === null ||
    selection.catalogId === null ||
    selection.scopeKey === null ||
    selection.generation === null ||
    selection.catalogHash === null ||
    selection.channel === null ||
    selection.selectionContextHash === null
  ) {
    throw new Error("Active Release receipt is incomplete");
  }
  const highWater =
    metadataState.highestSeenCatalogs[
      `${selection.catalogId}|${selection.scopeKey}`
    ];
  if (
    highWater === undefined ||
    highWater.generation < selection.generation ||
    (highWater.generation === selection.generation &&
      highWater.catalogHash !== selection.catalogHash)
  ) {
    throw new Error("Active Release receipt exceeds catalog high-water");
  }
}

function assertMetadataReset(metadata: Record<string, unknown>) {
  const metadataState = getMetadataState(metadata);
  const stableBundleId = metadataState.stableBundleId;
  const verificationPending = metadataState.verificationPending;

  if (stableBundleId !== null) {
    throw new Error(
      `Expected stableBundleId null but received ${String(stableBundleId)}`,
    );
  }

  if (verificationPending === true) {
    throw new Error(
      `Expected verificationPending false or null but received ${String(verificationPending)}`,
    );
  }
  const selection = metadataState.stagingSelection;
  if (
    selection?.kind !== "BUILTIN" ||
    selection.releaseId !== null ||
    selection.catalogId === null ||
    selection.scopeKey === null ||
    selection.generation === null ||
    selection.catalogHash === null ||
    selection.channel === null ||
    selection.selectionContextHash === null
  ) {
    throw new Error("Expected a complete persisted BUILTIN receipt");
  }
}

function assertLaunchReport(
  filePath: string,
  expected: {
    fromBundleId?: string;
    fromReleaseId?: string;
    status: string;
    toBundleId?: string;
    toReleaseId?: string;
  },
) {
  const report = readJson(filePath);

  if (report.status !== expected.status) {
    throw new Error(
      `Expected launch status ${expected.status} but received ${String(report.status)}`,
    );
  }

  for (const field of [
    "fromBundleId",
    "fromReleaseId",
    "toBundleId",
    "toReleaseId",
  ] as const) {
    const expectedValue = expected[field];
    if (expectedValue !== undefined && report[field] !== expectedValue) {
      throw new Error(
        `Expected ${field} ${expectedValue} but received ${String(report[field])}`,
      );
    }
  }
}

function assertCrashHistoryContains(filePath: string, bundleId: string) {
  const history = readJson(filePath);
  const bundles = Array.isArray(history.bundles) ? history.bundles : [];

  if (
    !bundles.some((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      return (entry as { bundleId?: string }).bundleId === bundleId;
    })
  ) {
    throw new Error(`Crash history is missing bundle ${bundleId}`);
  }
}

function createEndpointError(message: string, details?: unknown) {
  return Object.assign(new Error(message), { details });
}

function sourceSnippet(source: string, token: string) {
  const tokenIndex = source.indexOf(token);
  const center = tokenIndex === -1 ? 0 : tokenIndex;
  const start = Math.max(0, center - 160);
  const end = Math.min(source.length, center + token.length + 240);

  return source.slice(start, end);
}

function readOptionalJsonSnapshot(filePath: string): JsonSnapshot {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      path: filePath,
      readError: null,
      value: null,
    };
  }

  try {
    return {
      exists: true,
      path: filePath,
      readError: null,
      value: readJson(filePath),
    };
  } catch (error) {
    return {
      exists: true,
      path: filePath,
      readError: error instanceof Error ? error.message : String(error),
      value: null,
    };
  }
}

function firstMetadataValue(...values: unknown[]) {
  return values.find((value) => value !== undefined) ?? null;
}

function normalizeMetadataString(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "null"
  ) {
    return null;
  }

  return typeof value === "string" ? value : String(value);
}

function normalizeMetadataBoolean(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "null"
  ) {
    return null;
  }

  if (value === true || value === false) {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

type MetadataSelection = {
  catalogId: string | null;
  bundleId: string | null;
  catalogHash: string | null;
  channel: string | null;
  generation: number | null;
  kind: string | null;
  releaseId: string | null;
  scopeKey: string | null;
  selectionContextHash: string | null;
};

function normalizeMetadataNumber(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function normalizeMetadataSelection(value: unknown): MetadataSelection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const selection = value as Record<string, unknown>;
  return {
    catalogId: normalizeMetadataString(selection.catalogId),
    bundleId: normalizeMetadataString(selection.bundleId),
    catalogHash: normalizeMetadataString(selection.catalogHash),
    channel: normalizeMetadataString(selection.channel),
    generation: normalizeMetadataNumber(selection.generation),
    kind: normalizeMetadataString(selection.kind),
    releaseId: normalizeMetadataString(selection.releaseId),
    scopeKey: normalizeMetadataString(selection.scopeKey),
    selectionContextHash: normalizeMetadataString(
      selection.selectionContextHash,
    ),
  };
}

function normalizeCatalogHighWaters(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, raw]) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return [];
      }
      const highWater = raw as Record<string, unknown>;
      const generation = normalizeMetadataNumber(highWater.generation);
      const catalogHash = normalizeMetadataString(highWater.catalogHash);
      return generation === null || catalogHash === null
        ? []
        : [[key, { catalogHash, generation }]];
    }),
  ) as Record<string, { catalogHash: string; generation: number }>;
}

function readScreenMetadataState() {
  const screen = readE2eScreenStateSnapshot();
  if (screen.stagingBundleId == null && screen.stableBundleId == null) {
    return null;
  }
  return {
    highestSeenCatalogs: null,
    schema: null,
    stableBundleId: screen.stableBundleId,
    stableSelection: null,
    stagingBundleId: screen.stagingBundleId,
    stagingSelection:
      screen.stagingReleaseId == null
        ? null
        : {
            catalogHash: null,
            catalogId: null,
            bundleId: screen.stagingBundleId,
            channel: null,
            generation: null,
            kind: null,
            releaseId: screen.stagingReleaseId,
            scopeKey: null,
            selectionContextHash: null,
          },
    verificationPending: screen.verificationPending,
  };
}

function resolveMetadataState(metadata: Record<string, unknown> | null) {
  const journalState = metadata ? getMetadataState(metadata) : null;
  const screenState = readScreenMetadataState();
  if (
    isLynxE2eApp() &&
    screenState?.stagingBundleId &&
    screenState.stagingBundleId !== LYNX_E2E_BUILTIN_BUNDLE_ID &&
    (journalState === null ||
      journalState.stagingBundleId === null ||
      journalState.stagingBundleId === LYNX_E2E_BUILTIN_BUNDLE_ID)
  ) {
    return screenState;
  }
  if (journalState) {
    return journalState;
  }
  return screenState ?? getMetadataState(null);
}

function getMetadataState(metadata: Record<string, unknown> | null) {
  return {
    highestSeenCatalogs: normalizeCatalogHighWaters(
      firstMetadataValue(
        metadata?.highestSeenCatalogs,
        metadata?.highest_seen_catalogs,
      ),
    ),
    schema: normalizeMetadataString(metadata?.schema),
    stableBundleId: normalizeMetadataString(
      firstMetadataValue(metadata?.stableBundleId, metadata?.stable_bundle_id),
    ),
    stableSelection: normalizeMetadataSelection(
      firstMetadataValue(metadata?.stableSelection, metadata?.stable_selection),
    ),
    stagingBundleId: normalizeMetadataString(
      firstMetadataValue(
        metadata?.stagingBundleId,
        metadata?.staging_bundle_id,
      ),
    ),
    stagingSelection: normalizeMetadataSelection(
      firstMetadataValue(
        metadata?.stagingSelection,
        metadata?.staging_selection,
      ),
    ),
    verificationPending: normalizeMetadataBoolean(
      firstMetadataValue(
        metadata?.verificationPending,
        metadata?.verification_pending,
      ),
    ),
  };
}

function isMetadataActiveBundle(
  metadataState: {
    stableBundleId: string | null;
    stagingBundleId: string | null;
  },
  bundleId: string,
) {
  return (
    metadataState.stagingBundleId === bundleId ||
    metadataState.stableBundleId === bundleId
  );
}

function isExpectedCrashRecoveryReached(
  metadataState: {
    stagingBundleId: string | null;
    verificationPending: boolean | null;
  },
  launchReportState: {
    fromBundleId: string | null;
    status: string | null;
    toBundleId: string | null;
  },
  crashedBundleId: string,
  stableBundleId: string | undefined,
) {
  return (
    stableBundleId !== undefined &&
    metadataState.stagingBundleId === stableBundleId &&
    metadataState.verificationPending === false &&
    launchReportState.status === "RECOVERED" &&
    launchReportState.fromBundleId === crashedBundleId &&
    launchReportState.toBundleId === stableBundleId
  );
}

function formatObservedMetadataState(details: {
  stagingBundleId: string | null;
  verificationPending: boolean | null;
}) {
  return [
    `Observed stagingBundleId=${String(details.stagingBundleId)}`,
    `verificationPending=${String(details.verificationPending)}`,
  ].join(" and ");
}

function createWaitForMetadataTimeoutError(args: {
  attempts: number;
  bundleId: string;
  releaseId?: string | null;
  crashHistory: JsonSnapshot;
  launchReport: JsonSnapshot;
  metadata: JsonSnapshot;
  verificationPending: boolean;
}) {
  const observedState = getMetadataState(args.metadata.value);
  const nativeLogs = readHotUpdaterNativeLogs();
  const nativeLogPath = writeResultDiagnosticFile(
    "wait-for-metadata-native.log",
    nativeLogs,
  );
  const nativeLogTail = nativeLogs.split("\n").filter(Boolean).slice(-30);
  const signatureFailure = nativeLogTail.find((line) =>
    /signature verification failed|SIGNATURE_VERIFICATION_FAILED/i.test(line),
  );
  const message = [
    "Timed out waiting for metadata state.",
    `Expected stagingBundleId=${args.bundleId} and verificationPending=${String(args.verificationPending)}.`,
    `${formatObservedMetadataState(observedState)}.`,
    ...(args.releaseId !== undefined
      ? [
          `Expected releaseId=${String(args.releaseId)}; observed releaseId=${String(observedState.stagingSelection?.releaseId)}.`,
        ]
      : []),
    ...(signatureFailure ? [`Native failure: ${signatureFailure}`] : []),
    `Metadata path: ${args.metadata.path}`,
    `Native log path: ${nativeLogPath}`,
  ].join("\n");

  return createEndpointError(message, {
    attempts: args.attempts,
    expected: {
      bundleId: args.bundleId,
      releaseId: args.releaseId,
      verificationPending: args.verificationPending,
    },
    observed: {
      crashHistory: args.crashHistory,
      launchReport: args.launchReport,
      metadata: args.metadata,
      metadataState: observedState,
      nativeLogPath,
      nativeLogTail,
    },
    platform: fixtureSession.platform,
  });
}

function createWaitForMetadataResetTimeoutError(args: {
  attempts: number;
  crashHistory: JsonSnapshot;
  launchReport: JsonSnapshot;
  metadata: JsonSnapshot;
}) {
  const observedState = getMetadataState(args.metadata.value);
  const message = [
    "Timed out waiting for metadata reset state.",
    "Expected stableBundleId=null and verificationPending=false/null.",
    `Observed stableBundleId=${String(observedState.stableBundleId)} and ${formatObservedMetadataState(observedState)}.`,
    `Metadata path: ${args.metadata.path}`,
  ].join("\n");

  return createEndpointError(message, {
    attempts: args.attempts,
    expected: {
      stableBundleId: null,
      verificationPending: "false/null",
    },
    observed: {
      crashHistory: args.crashHistory,
      launchReport: args.launchReport,
      metadata: args.metadata,
      metadataState: observedState,
    },
    platform: fixtureSession.platform,
  });
}

function readIosWaitForMetadataDiagnostics() {
  if (isLynxE2eApp()) {
    return {
      crashHistory: readLynxSynthesizedSnapshot("crashed-history.json"),
      launchReport: readLynxSynthesizedSnapshot("launch-report.json"),
      metadata: readLynxSynthesizedSnapshot("metadata.json"),
    };
  }
  const storePath = ensureStorePath();
  return {
    crashHistory: readOptionalJsonSnapshot(
      path.join(storePath, "crashed-history.json"),
    ),
    launchReport: readOptionalJsonSnapshot(
      path.join(storePath, "launch-report.json"),
    ),
    metadata: readOptionalJsonSnapshot(path.join(storePath, "metadata.json")),
  };
}

function readIosMetadataSnapshot() {
  if (isLynxE2eApp()) {
    return readLynxSynthesizedSnapshot("metadata.json");
  }
  return readOptionalJsonSnapshot(
    path.join(ensureStorePath(), "metadata.json"),
  );
}

function readAndroidStoreSnapshot(
  remoteFileName: string,
  localFileName: string,
) {
  if (
    isLynxE2eApp() &&
    (remoteFileName === "metadata.json" ||
      remoteFileName === "crashed-history.json" ||
      remoteFileName === "launch-report.json")
  ) {
    return readLynxSynthesizedSnapshot(remoteFileName);
  }
  const storePath = ensureStorePath();
  const remotePath = `${storePath}/${remoteFileName}`;
  const localPath = path.join(fixtureSession.resultsDir, localFileName);

  if (!copyAndroidFileIfExists(remotePath, localPath)) {
    return {
      exists: false,
      path: remotePath,
      readError: null,
      value: null,
    } satisfies JsonSnapshot;
  }

  const localSnapshot = readOptionalJsonSnapshot(localPath);
  return {
    ...localSnapshot,
    path: remotePath,
  };
}

function androidRecoveryLaunchReportPath(
  args: {
    crashedBundleId?: string;
    stableBundleId?: string;
  } = {},
) {
  if (args.crashedBundleId && args.stableBundleId) {
    const artifactNames = createCrashRecoveryArtifactNames({
      crashedBundleId: args.crashedBundleId,
      stableBundleId: args.stableBundleId,
    });
    return path.join(fixtureSession.resultsDir, artifactNames.launchReport);
  }

  return path.join(fixtureSession.resultsDir, "recovery-launch-report.json");
}

function readAndroidMetadataSnapshot(localFileName: string) {
  return readAndroidStoreSnapshot("metadata.json", localFileName);
}

function readAndroidWaitForMetadataDiagnostics() {
  return {
    crashHistory: readAndroidStoreSnapshot(
      "crashed-history.json",
      "wait-for-metadata-crashed-history.json",
    ),
    launchReport: readAndroidStoreSnapshot(
      "launch-report.json",
      "wait-for-metadata-launch-report.json",
    ),
    metadata: readAndroidMetadataSnapshot("wait-for-metadata-metadata.json"),
  };
}

function readWaitForMetadataDiagnostics() {
  return fixtureSession.platform === "ios"
    ? readIosWaitForMetadataDiagnostics()
    : readAndroidWaitForMetadataDiagnostics();
}

function lynxBundleFileName() {
  return "main.lynx.bundle";
}

function readBundleFileSnapshot(bundleId: string) {
  const bundleFileName = isLynxE2eApp()
    ? lynxBundleFileName()
    : fixtureSession.platform === "ios"
      ? "index.ios.bundle"
      : "index.android.bundle";
  const lynxBundleDir =
    isLynxE2eApp() && fixtureSession.platform === "ios"
      ? findLynxIosBundleDir(bundleId)
      : isLynxE2eApp()
        ? findLynxAndroidBundleDir(bundleId)
        : null;
  const storePath = lynxBundleDir
    ? path.dirname(lynxBundleDir)
    : ensureStorePath();

  if (fixtureSession.platform === "ios") {
    const bundleFilePath = path.join(
      lynxBundleDir ?? path.join(storePath, bundleId),
      bundleFileName,
    );
    return {
      exists: fs.existsSync(bundleFilePath),
      path: bundleFilePath,
    };
  }

  const remotePath = `${lynxBundleDir ?? `${storePath}/${bundleId}`}/${bundleFileName}`;

  return {
    exists: androidFileExists(remotePath),
    path: remotePath,
  };
}

function readBundleManifestSnapshot(bundleId: string) {
  if (fixtureSession.platform === "ios") {
    if (isLynxE2eApp()) {
      const bundleDir = findLynxIosBundleDir(bundleId);
      if (bundleDir) {
        return readOptionalJsonSnapshot(path.join(bundleDir, "manifest.json"));
      }
    }
    return readOptionalJsonSnapshot(
      path.join(ensureStorePath(), bundleId, "manifest.json"),
    );
  }

  if (isLynxE2eApp()) {
    const bundleDir = findLynxAndroidBundleDir(bundleId);
    if (bundleDir) {
      const remotePath = `${bundleDir}/manifest.json`;
      const localPath = path.join(
        fixtureSession.resultsDir,
        `bundle-${bundleId}-manifest.json`,
      );
      if (!copyAndroidFileIfExists(remotePath, localPath)) {
        return {
          exists: false,
          path: remotePath,
          readError: null,
          value: null,
        } satisfies JsonSnapshot;
      }
      return {
        ...readOptionalJsonSnapshot(localPath),
        path: remotePath,
      };
    }
  }

  return readAndroidStoreSnapshot(
    `${bundleId}/manifest.json`,
    `bundle-${bundleId}-manifest.json`,
  );
}

function getManifestAssetFileHash(manifest: JsonSnapshot, assetPath: string) {
  const assets = manifest.value?.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    return null;
  }

  const asset = (assets as Record<string, unknown>)[assetPath];
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    return null;
  }

  const fileHash = (asset as { fileHash?: unknown }).fileHash;
  return typeof fileHash === "string" && fileHash.length > 0 ? fileHash : null;
}

function resolveManifestAssetPath(assetPath: string) {
  if (fixtureSession.platform === "ios") {
    return assetPath;
  }

  if (isLynxE2eApp()) {
    return assetPath;
  }

  return (
    MULTI_ASSET_FIXTURES.find((fixture) => fixture.manifestPath === assetPath)
      ?.androidManifestPath ?? assetPath
  );
}

function readIosBundleAssetFileHash(bundleId: string, assetPath: string) {
  const lynxBundleDir = isLynxE2eApp() ? findLynxIosBundleDir(bundleId) : null;
  const bundleRoot = lynxBundleDir ?? path.join(ensureStorePath(), bundleId);
  const candidates = [path.join(bundleRoot, assetPath)];
  if (isLynxE2eApp()) {
    candidates.push(
      path.join(bundleRoot, "static/image", path.basename(assetPath)),
    );
  }
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    return {
      exists: false,
      fileHash: null,
      path: candidates[0],
      readError: null,
    };
  }

  try {
    const fileHash = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    return {
      exists: true,
      fileHash,
      path: filePath,
      readError: null,
    };
  } catch (error) {
    return {
      exists: true,
      fileHash: null,
      path: filePath,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

function readAndroidBundleAssetFileHash(bundleId: string, assetPath: string) {
  const lynxBundleDir = isLynxE2eApp()
    ? findLynxAndroidBundleDir(bundleId)
    : null;
  const remotePath = `${lynxBundleDir ?? `${ensureStorePath()}/${bundleId}`}/${assetPath}`;
  const result = readAndroidFileBuffer(remotePath);
  if (!result.fileBuffer) {
    return {
      exists: false,
      fileHash: null,
      path: remotePath,
      readError: result.readError,
    };
  }

  const fileBuffer = result.fileBuffer;
  const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

  return {
    exists: true,
    fileHash,
    path: remotePath,
    readError: null,
  };
}

function readBundleAssetFileHash(bundleId: string, assetPath: string) {
  return fixtureSession.platform === "ios"
    ? readIosBundleAssetFileHash(bundleId, assetPath)
    : readAndroidBundleAssetFileHash(bundleId, assetPath);
}

function readBundleAssetsStoredEvidence(args: {
  assetPaths: string[];
  bundleId: string;
}) {
  const manifest = readBundleManifestSnapshot(args.bundleId);
  const assets = args.assetPaths.map((assetPath) => {
    const manifestAssetPath = resolveManifestAssetPath(assetPath);
    const expectedHash = getManifestAssetFileHash(manifest, manifestAssetPath);
    const assetFile = readBundleAssetFileHash(args.bundleId, manifestAssetPath);

    return {
      assetFile,
      assetPath: manifestAssetPath,
      expectedHash,
      ok:
        expectedHash !== null &&
        assetFile.exists &&
        assetFile.readError === null &&
        assetFile.fileHash === expectedHash,
      requestedAssetPath: assetPath,
    };
  });
  const ok =
    manifest.exists &&
    manifest.readError === null &&
    assets.every((asset) => asset.ok);

  return {
    assets,
    bundleId: args.bundleId,
    manifest,
    ok,
  };
}

function readMultipleAssetsReplacementEvidence(args: {
  assetPaths: string[];
  bundleId: string;
  previousBundleId: string;
}) {
  const previousManifest = readBundleManifestSnapshot(args.previousBundleId);
  const currentManifest = readBundleManifestSnapshot(args.bundleId);
  const assets = args.assetPaths.map((assetPath) => {
    const manifestAssetPath = resolveManifestAssetPath(assetPath);
    const previousHash = getManifestAssetFileHash(
      previousManifest,
      manifestAssetPath,
    );
    const currentHash = getManifestAssetFileHash(
      currentManifest,
      manifestAssetPath,
    );
    const assetFile = readBundleAssetFileHash(args.bundleId, manifestAssetPath);

    return {
      assetFile,
      assetPath: manifestAssetPath,
      currentHash,
      ok:
        previousHash !== null &&
        currentHash !== null &&
        previousHash !== currentHash &&
        assetFile.exists &&
        assetFile.readError === null &&
        assetFile.fileHash === currentHash,
      previousHash,
      requestedAssetPath: assetPath,
    };
  });
  const ok =
    previousManifest.exists &&
    previousManifest.readError === null &&
    currentManifest.exists &&
    currentManifest.readError === null &&
    assets.every((asset) => asset.ok);

  return {
    assets,
    bundleId: args.bundleId,
    currentManifest,
    ok,
    previousBundleId: args.previousBundleId,
    previousManifest,
  };
}

function readFirstOtaManifestState(bundleId: string) {
  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  const bundleFile = readBundleFileSnapshot(bundleId);
  const manifest = readBundleManifestSnapshot(bundleId);
  const assetPath = getPrimaryBundleAssetPath();
  const expectedHash = getManifestAssetFileHash(manifest, assetPath);
  const assetFile = readBundleAssetFileHash(bundleId, assetPath);

  return {
    assetFile,
    assetPath,
    bundleFile,
    diagnostics,
    expectedHash,
    manifest,
    metadataState,
  };
}

function getControllerReachableAppBaseUrl() {
  const url = new URL(fixtureSession.appBaseUrl);
  const androidReverseHostPort =
    fixtureSession.platform === "android"
      ? process.env.HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT
      : undefined;
  if (
    androidReverseHostPort &&
    /^\d+$/.test(androidReverseHostPort) &&
    isLoopbackHost(url.hostname)
  ) {
    url.hostname = "127.0.0.1";
    url.port = androidReverseHostPort;
  }
  if (
    url.hostname === "localhost" ||
    url.hostname === "10.0.2.2" ||
    url.hostname === "10.0.3.2"
  ) {
    url.hostname = "127.0.0.1";
  }
  return url.toString().replace(/\/+$/, "");
}

/** A page of bundles on the admin API: the provider answers once its database is migrated. */
function getControllerReachableProviderReadinessUrl({
  limit,
}: {
  readonly limit: number;
}) {
  const url = new URL(`${getControllerReachableAppBaseUrl()}/admin/bundles`);
  if (!isLoopbackHost(url.hostname)) {
    return null;
  }

  url.searchParams.set("platform", fixtureSession.platform);
  url.searchParams.set("limit", String(limit));
  url.hash = "";
  return url.toString();
}

function getLocalProviderReadinessUrls() {
  return PROVIDER_READY_BUNDLE_LIMITS.flatMap((limit) => {
    const url = getControllerReachableProviderReadinessUrl({ limit });
    return url === null ? [] : [url];
  });
}

function getAndroidControlDevicePort() {
  const port = Number.parseInt(
    process.env.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT ?? "3107",
    10,
  );
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      "HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT must be a positive integer.",
    );
  }
  return port;
}

function getControlServerHostPort() {
  const port = Number.parseInt(
    process.env.PORT || process.env.HOT_UPDATER_E2E_CONTROL_PORT || "3107",
    10,
  );
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer.");
  }
  return port;
}

function getAppReachableControlBaseUrl() {
  const port =
    fixtureSession.platform === "android"
      ? getAndroidControlDevicePort()
      : getControlServerHostPort();
  const hostname =
    fixtureSession.platform === "android" ? "127.0.0.1" : "localhost";
  return `http://${hostname}:${port}`;
}

function getRuntimeConfigUrl() {
  return `${getAppReachableControlBaseUrl()}/e2e/runtime-config`;
}

async function patchEnvRuntimeConfigUrl() {
  const source = fs.existsSync(fixtureSession.envSourceFile)
    ? await fsPromises.readFile(fixtureSession.envSourceFile, "utf8")
    : "";
  const lines = source.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith(`${E2E_RUNTIME_CONFIG_URL_ENV_KEY}=`);
  });
  lines.push(`${E2E_RUNTIME_CONFIG_URL_ENV_KEY}=${getRuntimeConfigUrl()}`);
  await fsPromises.writeFile(
    fixtureSession.envSourceFile,
    `${lines.join("\n")}\n`,
  );
  logE2eFixture("runtime config url injected", {
    key: E2E_RUNTIME_CONFIG_URL_ENV_KEY,
    value: getRuntimeConfigUrl(),
  });
}

function getHotUpdaterAdminHeaders() {
  const adminToken = readHotUpdaterAdminToken();
  return adminToken ? { Authorization: `Bearer ${adminToken}` } : undefined;
}

function readHotUpdaterAdminToken() {
  return readHotUpdaterEnvValue("HOT_UPDATER_ADMIN_TOKEN");
}

function readHotUpdaterApiKey() {
  return readHotUpdaterEnvValue("HOT_UPDATER_API_KEY");
}

export function getHotUpdaterClientRequestHeaders() {
  const headers = new Headers();
  const apiKey = readHotUpdaterApiKey();
  if (apiKey) headers.set("x-api-key", apiKey);
  return headers;
}

function readHotUpdaterEnvValue(
  key: "HOT_UPDATER_API_KEY" | "HOT_UPDATER_ADMIN_TOKEN",
) {
  const envValue = process.env[key]?.trim();
  if (envValue) return envValue;

  if (!fs.existsSync(fixtureSession.envSourceFile)) {
    return null;
  }

  const source = fs.readFileSync(fixtureSession.envSourceFile, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*(.*)$`));
    const value = match ? parseEnvTokenValue(match[1]).trim() : "";
    if (value) return value;
  }

  return null;
}

function parseEnvTokenValue(rawValue: string) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s#/);
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}

async function waitForLocalProviderReady() {
  const urls = getLocalProviderReadinessUrls();
  if (urls.length === 0) {
    return;
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= PROVIDER_READY_WAIT_ATTEMPTS; attempt += 1) {
    let ready = true;
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: getHotUpdaterAdminHeaders(),
          signal: AbortSignal.timeout(PROVIDER_READY_HTTP_TIMEOUT_MS),
        });
        if (!response.ok) {
          ready = false;
          lastError = `${url} HTTP ${response.status}`;
          break;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        ready = false;
        lastError = `${url} ${formatErrorMessage(error)}`;
        break;
      }
    }

    if (ready) {
      logE2eFixture("local provider ready", {
        attempt,
        platform: fixtureSession.platform,
        urls,
      });
      return;
    }

    if (attempt === 1 || attempt % 10 === 0) {
      logE2eFixture("local provider readiness pending", {
        attempt,
        lastError,
        platform: fixtureSession.platform,
        retryDelayMs: PROVIDER_READY_WAIT_DELAY_MS,
        urls,
      });
    }
    await sleep(PROVIDER_READY_WAIT_DELAY_MS);
  }

  throw new Error(
    `Timed out waiting for local provider ${urls.join(", ")}: ${lastError ?? "unknown error"}`,
  );
}

function getUrlPort(url: URL) {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function assertConfiguredBaseUrl() {
  try {
    const url = new URL(fixtureSession.appBaseUrl);
    if (!url.protocol || !url.hostname) {
      throw new Error("missing protocol or host");
    }
  } catch (error) {
    throw new Error(
      `HOT_UPDATER_E2E_APP_BASE_URL must be a valid absolute URL. Received ${JSON.stringify(fixtureSession.appBaseUrl)} (${formatErrorMessage(error)})`,
    );
  }
}

function getAndroidReversePorts() {
  const appBaseUrl = new URL(fixtureSession.appBaseUrl);
  if (!isLoopbackHost(appBaseUrl.hostname)) {
    return null;
  }

  const devicePort = getUrlPort(appBaseUrl);
  const hostPort = Number.parseInt(
    process.env.HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT ?? String(devicePort),
    10,
  );
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    throw new Error(
      "HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT must be a positive integer.",
    );
  }

  return { devicePort, hostPort };
}

function ensureAndroidReverse() {
  if (fixtureSession.platform !== "android") {
    return;
  }

  const reversePorts = getAndroidReversePorts();
  if (reversePorts === null) {
    return;
  }

  captureCommand("adb", [
    "-s",
    deviceId as string,
    "reverse",
    `tcp:${reversePorts.devicePort}`,
    `tcp:${reversePorts.hostPort}`,
  ]);
  logE2eFixture("android reverse ready", reversePorts);
}

function ensureAndroidControlReverse() {
  if (fixtureSession.platform !== "android") {
    return;
  }

  const devicePort = getAndroidControlDevicePort();
  const hostPort = getControlServerHostPort();
  captureCommand("adb", [
    "-s",
    deviceId as string,
    "reverse",
    `tcp:${devicePort}`,
    `tcp:${hostPort}`,
  ]);
  logE2eFixture("android control reverse ready", { devicePort, hostPort });
}

export function getHotUpdaterControlEnv(
  env: NodeJS.ProcessEnv | undefined = undefined,
) {
  const baseEnv = {
    ...env,
    ...RELEASE_BUNDLE_ENV,
    HOT_UPDATER_CONTROL_BASE_URL: getControllerReachableAppBaseUrl(),
  } satisfies NodeJS.ProcessEnv;

  return {
    ...baseEnv,
    NODE_OPTIONS: nodeOptionsForDeployChild(baseEnv),
  } satisfies NodeJS.ProcessEnv;
}

function nodeOptionsForDeployChild(env: NodeJS.ProcessEnv) {
  const existingOptions = (env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean);
  if (
    existingOptions.some((option) =>
      NODE_MAX_OLD_SPACE_SIZE_PATTERN.test(option),
    )
  ) {
    return existingOptions.join(" ");
  }

  const configuredSize = Number.parseInt(
    env[DEPLOY_MAX_OLD_SPACE_SIZE_ENV_KEY] ?? "",
    10,
  );
  const maxOldSpaceSizeMb =
    Number.isFinite(configuredSize) && configuredSize > 0
      ? configuredSize
      : DEFAULT_DEPLOY_MAX_OLD_SPACE_SIZE_MB;

  return [...existingOptions, `--max-old-space-size=${maxOldSpaceSizeMb}`].join(
    " ",
  );
}

async function withHotUpdaterControlEnv<T>(callback: () => Promise<T>) {
  const hadControlBaseUrl = Object.prototype.hasOwnProperty.call(
    process.env,
    "HOT_UPDATER_CONTROL_BASE_URL",
  );
  const previousControlBaseUrl = process.env.HOT_UPDATER_CONTROL_BASE_URL;

  process.env.HOT_UPDATER_CONTROL_BASE_URL = getControllerReachableAppBaseUrl();

  try {
    return await callback();
  } finally {
    if (hadControlBaseUrl) {
      process.env.HOT_UPDATER_CONTROL_BASE_URL = previousControlBaseUrl;
    } else {
      delete process.env.HOT_UPDATER_CONTROL_BASE_URL;
    }
  }
}

function getRemoteChannelPathSegment(channelSegment: string) {
  const channel = decodeURIComponent(channelSegment);
  if (!channelNamespace || channel.startsWith(`${channelNamespace}-`)) {
    return channelSegment;
  }

  return encodeURIComponent(getFixtureChannel(channel));
}

function rewriteProxiedUpdatePath(pathname: string) {
  const proxyPrefix = "/hot-updater";
  const targetBase = new URL(getControllerReachableAppBaseUrl());
  const targetBasePath = targetBase.pathname.replace(/\/+$/, "");
  const suffix = pathname.startsWith(`${proxyPrefix}/`)
    ? pathname.slice(proxyPrefix.length + 1)
    : "";
  const segments = suffix.split("/").filter(Boolean);

  if (
    (segments[0] === "app-version" || segments[0] === "fingerprint") &&
    segments[3]
  ) {
    segments[3] = getRemoteChannelPathSegment(segments[3]);
  }
  if (
    segments[0] === "release-catalogs" &&
    (segments[1] === "app-version" || segments[1] === "fingerprint") &&
    segments[3]
  ) {
    const channel = decodeChannelKey(decodeURIComponent(segments[3]));
    segments[3] = encodeChannelKey(
      !channelNamespace || channel.startsWith(`${channelNamespace}-`)
        ? channel
        : getFixtureChannel(channel),
    );
  }

  return `${targetBasePath}/${segments.join("/")}`;
}

export function handleRuntimeConfig() {
  return {
    automaticForceUpdate:
      automaticForceUpdate ??
      process.env.HOT_UPDATER_E2E_SCENARIO_NAME === "force-update-auto-reload",
    baseURL: `${getAppReachableControlBaseUrl()}/hot-updater`,
    channelNamespace,
    screenState: readE2eScreenStateSnapshot(),
    updateServerBaseURL: fixtureSession.appBaseUrl,
  };
}

export function handleRuntimeConfigUpdate(input: {
  automaticForceUpdate?: unknown;
}) {
  if (typeof input.automaticForceUpdate !== "boolean") {
    throw new Error("automaticForceUpdate must be a boolean");
  }
  automaticForceUpdate = input.automaticForceUpdate;
  return handleRuntimeConfig();
}

function toAppReachableProxyUrl(
  url: string,
  metadata: Omit<RemoteAssetProxyTarget, "url">,
) {
  const targetId = randomUUID();
  remoteAssetProxyTargets.set(targetId, { ...metadata, url });
  return `${getAppReachableControlBaseUrl()}/e2e/proxy-url/${targetId}`;
}

function rewriteRemoteAssetUrl(
  value: unknown,
  metadata: Omit<RemoteAssetProxyTarget, "url">,
): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (/^https?:\/\//.test(value)) {
    return toAppReachableProxyUrl(value, metadata);
  }

  if (value.startsWith("/storage/")) {
    return toAppReachableProxyUrl(
      `${getControllerReachableAppBaseUrl()}/${value.slice(1)}`,
      metadata,
    );
  }

  return value;
}

function rewriteUpdateInfoAssetUrls(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const updateInfo = payload as {
    archiveUrl?: unknown;
    assets?: Record<string, unknown>;
    manifestUrl?: unknown;
  };

  const rewritten: typeof updateInfo = {
    ...updateInfo,
    archiveUrl: rewriteRemoteAssetUrl(updateInfo.archiveUrl, {
      kind: "archive",
    }),
    manifestUrl: rewriteRemoteAssetUrl(updateInfo.manifestUrl, {
      kind: "manifest",
    }),
  };

  if (updateInfo.assets && typeof updateInfo.assets === "object") {
    rewritten.assets = Object.fromEntries(
      Object.entries(updateInfo.assets).map(([assetPath, asset]) => {
        if (!asset || typeof asset !== "object") {
          return [assetPath, asset];
        }

        const assetInfo = asset as {
          file?: { url?: unknown };
          patch?: { patchUrl?: unknown };
        };
        const file =
          assetInfo.file && typeof assetInfo.file === "object"
            ? {
                ...assetInfo.file,
                url: rewriteRemoteAssetUrl(assetInfo.file.url, {
                  assetPath,
                  kind: "file",
                }),
              }
            : assetInfo.file;
        const patch =
          assetInfo.patch && typeof assetInfo.patch === "object"
            ? {
                ...assetInfo.patch,
                patchUrl: rewriteRemoteAssetUrl(assetInfo.patch.patchUrl, {
                  assetPath,
                  kind: "patch",
                }),
              }
            : assetInfo.patch;

        return [assetPath, { ...assetInfo, file, patch }];
      }),
    );
  }
  if (!archiveAvailable) {
    delete rewritten.archiveUrl;
  }

  return rewritten;
}

function rewriteReleaseCatalogScope(
  payload: unknown,
  requestPathname: string,
): unknown {
  if (!payload || typeof payload !== "object") return payload;

  const segments = requestPathname.split("/").filter(Boolean);
  if (
    segments[0] !== "hot-updater" ||
    segments[1] !== "release-catalogs" ||
    (segments[2] !== "app-version" && segments[2] !== "fingerprint") ||
    (segments[3] !== "ios" && segments[3] !== "android") ||
    !segments[4] ||
    !segments[5]
  ) {
    return payload;
  }

  const catalogId = Reflect.get(payload, "catalogId");
  if (typeof catalogId !== "string" || catalogId.length === 0) {
    return payload;
  }

  const channelKey = decodeURIComponent(segments[4]);
  const scopeKey = createReleaseCatalogScopeKey(
    segments[2] === "app-version"
      ? {
          channelKey,
          platform: segments[3],
          strategy: "APP_VERSION",
        }
      : {
          channelKey,
          fingerprintHash: decodeURIComponent(segments[5]),
          platform: segments[3],
          strategy: "FINGERPRINT",
        },
  );

  return { ...payload, scopeKey };
}

function summarizeUpdateInfoPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { kind: typeof payload };
  }

  const updateInfo = payload as {
    archiveUrl?: unknown;
    artifactProtocolVersion?: unknown;
    assets?: Record<string, unknown> | null;
    id?: unknown;
    manifestUrl?: unknown;
    status?: unknown;
  };
  const appReachableBaseUrl = getAppReachableControlBaseUrl();
  const assetEntries =
    updateInfo.assets && typeof updateInfo.assets === "object"
      ? Object.values(updateInfo.assets)
      : [];
  const assetUrlCount = assetEntries.filter((asset) => {
    if (!asset || typeof asset !== "object") {
      return false;
    }

    const file = (asset as { file?: { url?: unknown } }).file;
    return typeof file?.url === "string";
  }).length;
  const proxiedAssetUrlCount = assetEntries.filter((asset) => {
    if (!asset || typeof asset !== "object") {
      return false;
    }

    const file = (asset as { file?: { url?: unknown } }).file;
    return (
      typeof file?.url === "string" && file.url.startsWith(appReachableBaseUrl)
    );
  }).length;

  return {
    archiveUrlPresent: typeof updateInfo.archiveUrl === "string",
    archiveUrlProxied:
      typeof updateInfo.archiveUrl === "string" &&
      updateInfo.archiveUrl.startsWith(appReachableBaseUrl),
    artifactProtocolVersion: updateInfo.artifactProtocolVersion ?? null,
    assetUrlCount,
    id: typeof updateInfo.id === "string" ? updateInfo.id : null,
    manifestUrlPresent: typeof updateInfo.manifestUrl === "string",
    manifestUrlProxied:
      typeof updateInfo.manifestUrl === "string" &&
      updateInfo.manifestUrl.startsWith(appReachableBaseUrl),
    proxiedAssetUrlCount,
    status: typeof updateInfo.status === "string" ? updateInfo.status : null,
  };
}

function captureArtifactSelection(pathname: string, payload: unknown) {
  const match = pathname.match(
    /^\/hot-updater\/artifacts\/v1\/([^/]+)\/from\/([^/]+)\/?$/,
  );
  if (!match || !payload || typeof payload !== "object") {
    return;
  }

  let targetBundleId: string;
  let currentBundleId: string;
  try {
    targetBundleId = decodeURIComponent(match[1]!);
    currentBundleId = decodeURIComponent(match[2]!);
  } catch {
    return;
  }

  const artifact = payload as {
    archiveUrl?: unknown;
    artifactProtocolVersion?: unknown;
    assets?: unknown;
    manifestFileHash?: unknown;
    manifestUrl?: unknown;
  };
  const assetsPresent =
    artifact.assets !== undefined && artifact.assets !== null;
  const assetEntries =
    assetsPresent &&
    typeof artifact.assets === "object" &&
    !Array.isArray(artifact.assets)
      ? Object.values(artifact.assets as Record<string, unknown>)
      : [];

  const evidence = captureArtifactSelectionEvidence(payload);
  if (!evidence) return;
  capturedArtifactSelections.push({
    ...evidence,
    archiveUrl:
      typeof artifact.archiveUrl === "string" ? artifact.archiveUrl : null,
    assets: Object.entries(
      (artifact.assets ?? {}) as Record<
        string,
        {
          fileHash?: unknown;
          file?: { url?: unknown };
          patch?: { patchUrl?: unknown };
        }
      >,
    ).flatMap(([path, asset]) => {
      if (
        typeof asset?.file?.url !== "string" ||
        typeof asset.fileHash !== "string"
      )
        return [];
      return [
        {
          fileHash: asset.fileHash,
          fileUrl: asset.file.url,
          patchUrl:
            typeof asset.patch?.patchUrl === "string"
              ? asset.patch.patchUrl
              : null,
          path,
        },
      ];
    }),
    artifactProtocolVersion:
      typeof artifact.artifactProtocolVersion === "number"
        ? artifact.artifactProtocolVersion
        : null,
    assetCount: assetEntries.length,
    assetFileCount: assetEntries.filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        Reflect.get(entry, "file") !== undefined,
    ).length,
    assetPatchCount: assetEntries.filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        Reflect.get(entry, "patch") !== undefined,
    ).length,
    assetsPresent,
    currentBundleId,
    manifestFileHashPresent: typeof artifact.manifestFileHash === "string",
    manifestUrlPresent: typeof artifact.manifestUrl === "string",
    targetBundleId,
  });
}

function classifyProxiedUpdatePath(pathname: string) {
  if (pathname.includes("/release-catalogs/")) return "catalog" as const;
  if (pathname.includes("/artifacts/")) return "artifact" as const;
  return "legacy" as const;
}

function recordProxyRequest(
  kind: keyof typeof proxyRequestCounts,
  path: string,
) {
  proxyRequestCounts[kind] += 1;
  proxyPathCounts.set(path, (proxyPathCounts.get(path) ?? 0) + 1);
}

function capturedResponse(response: CapturedProxyResponse) {
  return new Response(response.body, {
    headers: [...response.headers],
    status: response.status,
    statusText: response.statusText,
  });
}

function selectCapturedCatalog(pathname: string) {
  const generations = capturedCatalogResponses.get(pathname);
  if (generations === undefined || generations.size === 0) return null;
  if (catalogProxyMode === "replay") {
    return replayCatalogGeneration === null
      ? null
      : (generations.get(replayCatalogGeneration) ?? null);
  }
  if (catalogProxyMode === "freeze") {
    return (
      [...generations.entries()].toSorted(
        ([left], [right]) => right - left,
      )[0]?.[1] ?? null
    );
  }
  return null;
}

function captureCatalogResponse(
  pathname: string,
  response: Response,
  body: string,
) {
  let generation: unknown;
  try {
    generation = (JSON.parse(body) as { generation?: unknown }).generation;
  } catch {
    return;
  }
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) {
    return;
  }
  const generations =
    capturedCatalogResponses.get(pathname) ??
    new Map<number, CapturedProxyResponse>();
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  generations.set(generation, {
    body,
    headers: [...headers.entries()],
    status: response.status,
    statusText: response.statusText,
  });
  capturedCatalogResponses.set(pathname, generations);
}

export function handleProxyState() {
  return {
    archiveAvailable,
    archiveFailureMode,
    archiveFailuresRemaining,
    artifactFailuresRemaining,
    downloadAvailable,
    failedDownloads,
    changedAssetMutation,
    capturedArtifactSelections: [...capturedArtifactSelections],
    capturedCatalogGenerations: Object.fromEntries(
      [...capturedCatalogResponses].map(([pathname, generations]) => [
        pathname,
        [...generations.keys()].toSorted((left, right) => left - right),
      ]),
    ),
    catalogProxyMode,
    delays: {
      artifactMs: artifactResponseDelayMs,
      catalogMs: catalogResponseDelayMs,
    },
    pathCardinality: proxyPathCounts.size,
    pathCounts: Object.fromEntries(proxyPathCounts),
    requestCounts: { ...proxyRequestCounts },
    remoteTransfers: [...remoteAssetProxyTargets].map(([targetId, target]) => {
      const proxyPath = `/e2e/proxy-url/${targetId}`;
      return {
        assetPath: target.assetPath ?? null,
        kind: target.kind,
        proxyPath,
        ...(remoteAssetTransfers.get(proxyPath) ?? {
          bytes: 0,
          requests: 0,
        }),
      };
    }),
    assetTransfers: Object.fromEntries(remoteAssetTransfers),
    replayCatalogGeneration,
  };
}

export function handleConfigureProxy(input: {
  downloadAvailable?: boolean;
  archiveAvailable?: boolean;
  archiveFailureMode?: "corrupt" | "not-found" | null;
  archiveFailures?: number;
  artifactDelayMs?: number;
  artifactFailures?: number;
  catalogDelayMs?: number;
  catalogMode?: "freeze" | "live" | "replay";
  changedAssetMutation?: {
    assetPath: string;
    mode: "corrupt" | "missing";
    remaining: number;
  } | null;
  replayGeneration?: number | null;
  reset?: boolean;
}) {
  if (input.reset) {
    proxyRequestCounts.artifact = 0;
    proxyRequestCounts.catalog = 0;
    proxyRequestCounts.legacy = 0;
    proxyPathCounts.clear();
    capturedArtifactSelections.length = 0;
    remoteAssetTransfers.clear();
    capturedCatalogResponses.clear();
    artifactFailuresRemaining = 0;
    downloadAvailable = true;
    failedDownloads = 0;
    changedAssetMutation = null;
    archiveAvailable = true;
    archiveFailureMode = null;
    archiveFailuresRemaining = 0;
  }
  if (input.downloadAvailable !== undefined) {
    downloadAvailable = input.downloadAvailable;
  }
  if (input.changedAssetMutation !== undefined) {
    changedAssetMutation = input.changedAssetMutation;
  }
  if (input.catalogMode !== undefined) catalogProxyMode = input.catalogMode;
  if (input.replayGeneration !== undefined) {
    replayCatalogGeneration = input.replayGeneration;
  }
  if (input.catalogDelayMs !== undefined) {
    catalogResponseDelayMs = input.catalogDelayMs;
  }
  if (input.artifactDelayMs !== undefined) {
    artifactResponseDelayMs = input.artifactDelayMs;
  }
  if (input.artifactFailures !== undefined) {
    artifactFailuresRemaining = input.artifactFailures;
  }
  if (input.archiveFailureMode !== undefined) {
    archiveFailureMode = input.archiveFailureMode;
  }
  if (input.archiveFailures !== undefined) {
    archiveFailuresRemaining = input.archiveFailures;
  }
  if (input.archiveAvailable !== undefined) {
    archiveAvailable = input.archiveAvailable;
  }
  return handleProxyState();
}

export function handleAssertBundleArtifactSelection(input: {
  currentBundleId: string;
  selection: "manifest-v1";
  requireArchiveAbsent?: boolean;
  requiredPatchAssetPaths?: string[];
  requiredRawAssetPaths?: string[];
  targetBundleId: string;
}) {
  const observed = capturedArtifactSelections.findLast(
    (entry) =>
      entry.currentBundleId === input.currentBundleId &&
      entry.targetBundleId === input.targetBundleId,
  );
  if (!observed) {
    throw createEndpointError("Bundle artifact request was not observed", {
      expected: input,
      observed: [...capturedArtifactSelections],
    });
  }

  const matches =
    observed.artifactProtocolVersion === 1 &&
    observed.assetsPresent &&
    observed.assetCount > 0 &&
    observed.assetFileCount === observed.assetCount &&
    observed.manifestFileHashPresent &&
    observed.manifestUrlPresent;
  if (!matches) {
    throw createEndpointError("Unexpected Bundle artifact selection", {
      expected: input,
      observed,
    });
  }
  if (input.requireArchiveAbsent === true && observed.archiveUrl !== null) {
    throw createEndpointError("Delta selection retained an archive fallback", {
      expected: input,
      observed,
    });
  }
  for (const path of input.requiredPatchAssetPaths ?? []) {
    if (!observed.assetPatchPaths.includes(path)) {
      throw createEndpointError("Required patched asset was not observed", {
        expected: input,
        observed,
      });
    }
  }
  for (const path of input.requiredRawAssetPaths ?? []) {
    if (!observed.unpatchedAssetPaths.includes(path)) {
      throw createEndpointError("Required raw-only asset was not observed", {
        expected: input,
        observed,
      });
    }
  }

  logE2eFixture("Bundle artifact selection verified", {
    ...observed,
    platform: fixtureSession.platform,
    selection: input.selection,
  });
  return observed;
}

function getRemoteTransfer(url: string | null) {
  if (url === null) return { bytes: 0, requests: 0 };
  const pathname = new URL(url).pathname;
  return remoteAssetTransfers.get(pathname) ?? { bytes: 0, requests: 0 };
}

export function handleAssertBundleArtifactTransfers(input: {
  archiveRequests: number;
  currentBundleId: string;
  fileRequests: number | ArtifactFileTransferMode;
  maxRequestsPerAsset?: number;
  minNetworkAssets?: number;
  patchRequests: number;
  targetBundleId: string;
  verifyAllAssetHashes?: boolean;
}) {
  const artifact = capturedArtifactSelections.findLast(
    (entry) =>
      entry.currentBundleId === input.currentBundleId &&
      entry.targetBundleId === input.targetBundleId,
  );
  if (!artifact) {
    throw createEndpointError("Bundle artifact request was not observed", {
      expected: input,
      observed: [...capturedArtifactSelections],
    });
  }

  const expectedFilePaths =
    typeof input.fileRequests === "number"
      ? null
      : getExpectedArtifactFilePaths({
          assets: artifact.assets,
          baseManifest:
            input.fileRequests === "manifest-diff"
              ? readBundleManifestSnapshot(input.currentBundleId).value
              : null,
          mode: input.fileRequests,
          preflightAssetPaths: isLynxE2eApp() ? ["hot-updater-lynx.json"] : [],
        });
  const expectedFileRequests = expectedFilePaths?.length ?? input.fileRequests;
  const archive = getRemoteTransfer(artifact.archiveUrl);
  const assets = artifact.assets.map((asset) => ({
    file: getRemoteTransfer(asset.fileUrl),
    patch: getRemoteTransfer(asset.patchUrl),
    path: asset.path,
  }));
  const fileRequests = assets.reduce(
    (total, asset) => total + asset.file.requests,
    0,
  );
  const patchRequests = assets.reduce(
    (total, asset) => total + asset.patch.requests,
    0,
  );
  const networkAssets = assets.filter(
    (asset) => asset.file.requests + asset.patch.requests > 0,
  );
  const finalFiles =
    input.verifyAllAssetHashes === true
      ? readBundleAssetsStoredEvidence({
          assetPaths: artifact.assets.map((asset) => asset.path),
          bundleId: input.targetBundleId,
        })
      : null;
  const observed = {
    archive,
    archiveFailureMode,
    archiveFailuresRemaining,
    assets,
    fileRequests,
    expectedFilePaths,
    finalFiles,
    networkAssetCount: networkAssets.length,
    patchRequests,
  };
  const requestsAreBounded =
    input.maxRequestsPerAsset === undefined ||
    networkAssets.every(
      (asset) =>
        asset.file.requests + asset.patch.requests <=
        input.maxRequestsPerAsset!,
    );
  const transferBytesPresent =
    (archive.requests === 0 || archive.bytes > 0) &&
    networkAssets.every(
      (asset) =>
        (asset.file.requests === 0 || asset.file.bytes > 0) &&
        (asset.patch.requests === 0 || asset.patch.bytes > 0),
    );
  const matches =
    archive.requests === input.archiveRequests &&
    fileRequests === expectedFileRequests &&
    (expectedFilePaths === null ||
      assets.every(
        (asset) =>
          asset.file.requests ===
          (expectedFilePaths.includes(asset.path) ? 1 : 0),
      )) &&
    patchRequests === input.patchRequests &&
    archiveFailuresRemaining === 0 &&
    (input.minNetworkAssets === undefined ||
      networkAssets.length >= input.minNetworkAssets) &&
    requestsAreBounded &&
    transferBytesPresent &&
    (finalFiles === null || finalFiles.ok);
  if (!matches) {
    throw createEndpointError("Unexpected Bundle artifact transfers", {
      expected: input,
      observed,
    });
  }

  fs.writeFileSync(
    path.join(
      fixtureSession.resultsDir,
      `artifact-transfers-${input.targetBundleId}.json`,
    ),
    JSON.stringify(
      {
        currentBundleId: input.currentBundleId,
        expected: input,
        observed,
        platform: fixtureSession.platform,
        targetBundleId: input.targetBundleId,
      },
      null,
      2,
    ),
  );
  logE2eFixture("Bundle artifact transfers verified", {
    ...observed,
    platform: fixtureSession.platform,
  });
  return observed;
}

export class ProxyAssertionError extends Error {
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.name = "ProxyAssertionError";
    this.details = details;
  }
}

export function handleAssertProxy(input: {
  minFailedDownloads?: number;
  artifactFailuresRemaining?: number;
  artifactRequests?: number;
  catalogRequests?: number;
  changedAssetMutationMode?: "corrupt" | "missing" | null;
  changedAssetMutationRemaining?: number;
  maxPathCardinality?: number;
}) {
  const observed = {
    artifactFailuresRemaining,
    pathCardinality: proxyPathCounts.size,
    requestCounts: { ...proxyRequestCounts },
  };
  if (
    input.minFailedDownloads !== undefined &&
    failedDownloads < input.minFailedDownloads
  ) {
    throw createEndpointError("Expected a failed asset download", {
      expectedMinimum: input.minFailedDownloads,
      observed,
    });
  }

  if (
    input.artifactFailuresRemaining !== undefined &&
    artifactFailuresRemaining !== input.artifactFailuresRemaining
  ) {
    throw new ProxyAssertionError("Unexpected remaining artifact failures", {
      expected: input.artifactFailuresRemaining,
      observed,
    });
  }
  if (
    input.artifactRequests !== undefined &&
    proxyRequestCounts.artifact !== input.artifactRequests
  ) {
    throw new ProxyAssertionError("Unexpected artifact request count", {
      expected: input.artifactRequests,
      observed,
    });
  }
  if (
    input.changedAssetMutationMode !== undefined &&
    changedAssetMutation?.mode !== input.changedAssetMutationMode
  ) {
    throw createEndpointError("Unexpected changed asset mutation mode", {
      expected: input.changedAssetMutationMode,
      observed,
    });
  }
  if (
    input.changedAssetMutationRemaining !== undefined &&
    changedAssetMutation?.remaining !== input.changedAssetMutationRemaining
  ) {
    throw createEndpointError("Unexpected remaining changed asset mutations", {
      expected: input.changedAssetMutationRemaining,
      observed,
    });
  }
  if (
    input.catalogRequests !== undefined &&
    proxyRequestCounts.catalog !== input.catalogRequests
  ) {
    throw new ProxyAssertionError("Unexpected catalog request count", {
      expected: input.catalogRequests,
      observed,
    });
  }
  if (
    input.maxPathCardinality !== undefined &&
    proxyPathCounts.size > input.maxPathCardinality
  ) {
    throw new ProxyAssertionError("Proxy path cardinality exceeded", {
      expectedMaximum: input.maxPathCardinality,
      observed,
    });
  }
  return handleProxyState();
}

export async function handleProxyUpdateRequest(request: Request) {
  const requestUrl = new URL(request.url);
  const requestKind = classifyProxiedUpdatePath(requestUrl.pathname);
  recordProxyRequest(requestKind, requestUrl.pathname);
  if (requestKind === "artifact" && artifactFailuresRemaining > 0) {
    artifactFailuresRemaining -= 1;
    return new Response("Injected E2E artifact download failure", {
      status: 503,
    });
  }
  if (requestKind === "catalog") {
    const replay = selectCapturedCatalog(requestUrl.pathname);
    if (replay !== null) {
      if (catalogResponseDelayMs > 0) await sleep(catalogResponseDelayMs);
      return capturedResponse(replay);
    }
  }
  const targetUrl = new URL(getControllerReachableAppBaseUrl());
  targetUrl.pathname = rewriteProxiedUpdatePath(requestUrl.pathname);
  targetUrl.search = requestUrl.search;
  targetUrl.hash = "";

  const headers = new Headers(request.headers);
  headers.delete("host");
  const clientApiKey = readHotUpdaterApiKey();
  let clientApiKeyInjected = false;
  if (clientApiKey && !headers.has("x-api-key")) {
    headers.set("x-api-key", clientApiKey);
    clientApiKeyInjected = true;
  }

  const requestBody =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const response = await fetch(targetUrl, {
    body: requestBody,
    headers,
    method: request.method,
  });

  if (requestKind === "artifact" && artifactResponseDelayMs > 0) {
    await sleep(artifactResponseDelayMs);
  }

  if (requestUrl.pathname.endsWith("/events") && response.ok && requestBody) {
    try {
      const event = readObservedInsightsEvent(
        JSON.parse(new TextDecoder().decode(requestBody)),
        Date.now(),
      );
      if (event) fixtureSession.observedInsightsEvents.push(event);
    } catch (error) {
      logE2eFixture("insights event observation skipped", {
        error: formatErrorMessage(error),
      });
    }
  }

  logE2eFixture("proxied update request", {
    clientApiKeyInjected,
    method: request.method,
    source: requestUrl.pathname,
    target: targetUrl.toString(),
  });

  const headersToApp = new Headers(response.headers);
  if (
    request.method === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    return new Response(null, {
      headers: headersToApp,
      status: response.status,
      statusText: response.statusText,
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    const body = await response.text();
    try {
      const payload = JSON.parse(body);
      const rewrittenPayload =
        requestKind === "catalog"
          ? rewriteReleaseCatalogScope(
              rewriteUpdateInfoAssetUrls(payload),
              requestUrl.pathname,
            )
          : rewriteUpdateInfoAssetUrls(payload);
      if (requestKind === "artifact" && response.ok) {
        captureArtifactSelection(requestUrl.pathname, rewrittenPayload);
      }
      const rewrittenBody = JSON.stringify(rewrittenPayload);
      if (requestKind === "catalog" && response.ok) {
        captureCatalogResponse(requestUrl.pathname, response, rewrittenBody);
        if (catalogResponseDelayMs > 0) await sleep(catalogResponseDelayMs);
      }
      logE2eFixture("proxied update response", {
        original: summarizeUpdateInfoPayload(payload),
        rewritten: summarizeUpdateInfoPayload(rewrittenPayload),
        status: response.status,
      });
      headersToApp.delete("content-encoding");
      headersToApp.delete("content-length");
      return new Response(rewrittenBody, {
        headers: headersToApp,
        status: response.status,
        statusText: response.statusText,
      });
    } catch {
      return new Response(body, {
        headers: headersToApp,
        status: response.status,
        statusText: response.statusText,
      });
    }
  }

  return new Response(response.body, {
    headers: headersToApp,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function handleProxyRemoteAssetRequest(request: Request) {
  const requestUrl = new URL(request.url);
  const target = getRemoteAssetProxyTarget(requestUrl);

  if (!target) {
    return new Response("Missing url", { status: 400 });
  }
  const transfer = remoteAssetTransfers.get(requestUrl.pathname) ?? {
    requests: 0,
    bytes: 0,
  };
  transfer.requests += 1;
  remoteAssetTransfers.set(requestUrl.pathname, transfer);
  if (!downloadAvailable) {
    failedDownloads += 1;
    return new Response("Injected E2E download outage", { status: 503 });
  }
  if (artifactFailuresRemaining > 0) {
    artifactFailuresRemaining -= 1;
    return new Response("Injected E2E artifact download failure", {
      status: 503,
    });
  }

  const targetUrl = new URL(target.url);
  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return new Response("Unsupported url protocol", { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.delete("host");

  let response: Response;
  if (
    changedAssetMutation &&
    changedAssetMutation.remaining > 0 &&
    target.kind === "file" &&
    target.assetPath === changedAssetMutation.assetPath
  ) {
    changedAssetMutation.remaining -= 1;
    response =
      changedAssetMutation.mode === "missing"
        ? new Response("Injected missing asset", { status: 404 })
        : new Response("corrupt changed asset bytes", { status: 200 });
  } else if (
    target.kind === "archive" &&
    archiveFailureMode !== null &&
    archiveFailuresRemaining > 0
  ) {
    archiveFailuresRemaining -= 1;
    response =
      archiveFailureMode === "not-found"
        ? new Response("Injected E2E archive 404", { status: 404 })
        : new Response("corrupt tar.br bytes", {
            headers: { "content-type": "application/octet-stream" },
            status: 200,
          });
  } else {
    response = await fetch(targetUrl, {
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      headers,
      method: request.method,
    });
  }

  if (artifactResponseDelayMs > 0) await sleep(artifactResponseDelayMs);

  logE2eFixture("proxied remote asset request", {
    method: request.method,
    source: requestUrl.pathname,
    status: response.status,
    target: targetUrl.toString(),
  });

  const headersToApp = new Headers(response.headers);
  headersToApp.delete("content-encoding");
  headersToApp.delete("content-length");

  const observedBody = response.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transfer.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(observedBody, {
    headers: headersToApp,
    status: response.status,
    statusText: response.statusText,
  });
}

function getRemoteAssetProxyTarget(requestUrl: URL) {
  const proxyPathPrefix = "/e2e/proxy-url/";
  if (requestUrl.pathname.startsWith(proxyPathPrefix)) {
    const targetId = decodeURIComponent(
      requestUrl.pathname.slice(proxyPathPrefix.length),
    );
    return remoteAssetProxyTargets.get(targetId) ?? null;
  }

  const legacyTarget = requestUrl.searchParams.get("url");
  return legacyTarget === null
    ? null
    : ({ kind: "file", url: legacyTarget } satisfies RemoteAssetProxyTarget);
}

function buildCatalogUrl(args: {
  catalog: Pick<ReleaseCatalogRow, "fingerprint_hash" | "strategy">;
  channel: string;
}) {
  const base = {
    baseUrl: getControllerReachableAppBaseUrl(),
    channel: args.channel,
    platform: fixtureSession.platform,
  } as const;

  if (args.catalog.strategy === "FINGERPRINT") {
    if (args.catalog.fingerprint_hash === null) {
      throw new Error("Fingerprint Release catalog is missing its hash.");
    }
    return buildReleaseCatalogUrl({
      ...base,
      fingerprintHash: args.catalog.fingerprint_hash,
      strategy: "fingerprint",
    });
  }

  return buildReleaseCatalogUrl({
    ...base,
    appVersion: E2E_APP_VERSION,
    strategy: "appVersion",
  });
}

function shouldWaitForUpdateCheckVisibility(request: DeployBundleRequest) {
  return shouldProbeUpdateCheckVisibility({
    appBaseUrl: fixtureSession.appBaseUrl,
    disabled: request.disabled,
    rollout: request.rollout,
    targetCohorts: request.targetCohorts,
  });
}

async function waitForReleaseCatalogVisibility(args: {
  bundleId: string | null;
  catalog: ReleaseCatalogRow;
  channel: string;
  expectedFileHash: string | null;
  releaseId: string;
  signal?: AbortSignal;
}) {
  const url = buildCatalogUrl({
    catalog: args.catalog,
    channel: args.channel,
  });
  let lastObserved: unknown = null;
  let lastError: string | null = null;

  for (let index = 0; index < UPDATE_CHECK_VISIBILITY_ATTEMPTS; index += 1) {
    throwIfAborted(args.signal);
    try {
      const response = await fetch(url, {
        headers: getHotUpdaterClientRequestHeaders(),
        signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal),
      });
      const body = await response.text();
      lastObserved = body;

      if (response.ok) {
        const payload = JSON.parse(body) as {
          generation?: unknown;
          releases?: readonly { bundleId?: unknown; releaseId?: unknown }[];
        };
        lastObserved = {
          generation: payload.generation,
          releases: payload.releases,
        };

        if (
          payload.releases?.some(
            (release) =>
              release.releaseId === args.releaseId &&
              release.bundleId === args.bundleId,
          )
        ) {
          logE2eFixture("Release catalog visibility ready", {
            bundleId: args.bundleId,
            channel: args.channel,
            releaseId: args.releaseId,
            url,
          });
          if (args.bundleId !== null) {
            if (args.expectedFileHash === null) {
              throw new Error("Bundle manifest hash is required");
            }
            await waitForArtifactResolution({
              bundleId: args.bundleId,
              expectedFileHash: args.expectedFileHash,
              signal: args.signal,
            });
          }
          return;
        }
      } else {
        lastError = `HTTP ${response.status}: ${truncateForLog(body)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const attempt = index + 1;
    if (
      shouldLogUpdateCheckProgress(attempt, UPDATE_CHECK_VISIBILITY_ATTEMPTS)
    ) {
      logE2eFixture("update check visibility pending", {
        attempt,
        attempts: UPDATE_CHECK_VISIBILITY_ATTEMPTS,
        expectedBundleId: args.bundleId,
        expectedReleaseId: args.releaseId,
        lastError,
        lastObserved,
        platform: fixtureSession.platform,
        url,
      });
    }

    await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal);
  }

  logE2eFixture("Release catalog visibility timeout", {
    expectedBundleId: args.bundleId,
    expectedReleaseId: args.releaseId,
    lastError,
    lastObserved,
    platform: fixtureSession.platform,
    url,
  });

  throw createEndpointError(
    [
      "Timed out waiting for Release catalog visibility.",
      `Expected releaseId=${args.releaseId} and bundleId=${args.bundleId}.`,
      `URL: ${url}`,
    ].join("\n"),
    {
      expected: {
        bundleId: args.bundleId,
        releaseId: args.releaseId,
      },
      lastError,
      lastObserved,
      platform: fixtureSession.platform,
      url,
    },
  );
}

async function waitForArtifactResolution(args: {
  bundleId: string;
  expectedFileHash: string;
  signal?: AbortSignal;
}) {
  const url = `${getControllerReachableAppBaseUrl()}/artifacts/v1/${encodeURIComponent(
    args.bundleId,
  )}/from/${NIL_UUID}`;
  const response = await fetch(url, {
    headers: getHotUpdaterClientRequestHeaders(),
    signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal),
  });
  const body = await response.text();
  if (!response.ok) {
    throw createEndpointError(
      `Artifact resolution failed with HTTP ${response.status}`,
      { body: truncateForLog(body), bundleId: args.bundleId, url },
    );
  }
  const payload: unknown = JSON.parse(body);
  const validation = validateArtifactInfoVisibility(
    payload,
    args.expectedFileHash,
  );
  if (!validation.ok) {
    throw createEndpointError(
      validation.reason === "manifest-file-hash-mismatch"
        ? "Artifact resolution returned another manifest hash"
        : "Artifact resolution returned invalid ArtifactInfo",
      {
        bundleId: args.bundleId,
        expectedFileHash: args.expectedFileHash,
        payload,
        validation,
        url,
      },
    );
  }
}

function normalizeE2ECohort(value: string) {
  const cohort = value.trim();
  return cohort.length > 0 ? cohort : null;
}

function readIosE2ECohort() {
  const cohort = captureCommand(
    "xcrun",
    [
      "simctl",
      "spawn",
      deviceId as string,
      "defaults",
      "read",
      fixtureSession.appId,
      E2E_IOS_COHORT_DEFAULTS_KEY,
    ],
    { allowFailure: true },
  );
  return normalizeE2ECohort(cohort);
}

function decodeXmlText(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function readAndroidStringPreference(xml: string, key: string) {
  const pattern = new RegExp(
    `<string\\s+name="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">([^<]*)<\\/string>`,
  );
  const match = pattern.exec(xml);
  return match?.[1] ? decodeXmlText(match[1]) : null;
}

function encodeXmlText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readAndroidE2ECohort() {
  const prefsPath = `/data/data/${fixtureSession.appId}/shared_prefs/${E2E_ANDROID_COHORT_PREFS_FILE}`;
  const prefsXml = captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      fixtureSession.appId,
      "cat",
      prefsPath,
    ],
    { allowFailure: true },
  );
  const cohort = readAndroidStringPreference(
    prefsXml,
    E2E_ANDROID_COHORT_PREFS_KEY,
  );
  return cohort ? normalizeE2ECohort(cohort) : null;
}

function readCurrentE2ECohort() {
  return fixtureSession.platform === "ios"
    ? readIosE2ECohort()
    : readAndroidE2ECohort();
}

function writeIosE2ECohort(cohort: string) {
  captureCommand("xcrun", [
    "simctl",
    "spawn",
    deviceId as string,
    "defaults",
    "write",
    fixtureSession.appId,
    E2E_IOS_COHORT_DEFAULTS_KEY,
    "-string",
    cohort,
  ]);
}

function writeAndroidE2ECohort(cohort: string) {
  const prefsDir = `/data/data/${fixtureSession.appId}/shared_prefs`;
  const prefsPath = `${prefsDir}/${E2E_ANDROID_COHORT_PREFS_FILE}`;
  const prefsXml = [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    "<map>",
    `    <string name="${E2E_ANDROID_COHORT_PREFS_KEY}">${encodeXmlText(cohort)}</string>`,
    "</map>",
    "",
  ].join("\n");

  captureCommand("adb", [
    "-s",
    deviceId as string,
    "shell",
    "run-as",
    fixtureSession.appId,
    "sh",
    "-c",
    shellSingleQuote(
      [
        `mkdir -p ${shellSingleQuote(prefsDir)}`,
        `printf %s ${shellSingleQuote(prefsXml)} > ${shellSingleQuote(prefsPath)}`,
      ].join(" && "),
    ),
  ]);
}

async function seedMissingE2ECohort() {
  const existingCohort = readCurrentE2ECohort();
  if (existingCohort) {
    logE2eFixture("e2e cohort seed preserved", {
      cohort: existingCohort,
      platform: fixtureSession.platform,
    });
    return existingCohort;
  }

  const cohort = normalizeE2ECohort(E2E_DEFAULT_COHORT);
  if (!cohort) {
    throw new Error("HOT_UPDATER_E2E_DEFAULT_COHORT must not be empty");
  }

  if (fixtureSession.platform === "ios") {
    writeIosE2ECohort(cohort);
  } else {
    writeAndroidE2ECohort(cohort);
  }

  const seededCohort = readCurrentE2ECohort();
  if (seededCohort !== cohort) {
    throw new Error(
      `Failed to seed ${fixtureSession.platform} E2E cohort: expected ${cohort}, observed ${seededCohort ?? "missing"}`,
    );
  }

  logE2eFixture("e2e cohort seeded", {
    cohort,
    platform: fixtureSession.platform,
  });
  return cohort;
}

async function waitForReleaseCatalogExcludesRelease(args: {
  catalog: ReleaseCatalogRow;
  channel: string;
  releaseId: string;
  signal?: AbortSignal;
}) {
  const url = buildCatalogUrl({
    catalog: args.catalog,
    channel: args.channel,
  });
  let lastObserved: unknown = null;
  let lastError: string | null = null;

  for (let index = 0; index < UPDATE_CHECK_EXCLUSION_ATTEMPTS; index += 1) {
    throwIfAborted(args.signal);
    try {
      const response = await fetch(url, {
        headers: getHotUpdaterClientRequestHeaders(),
        signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal),
      });
      const body = await response.text();
      lastObserved = body;

      if (response.ok) {
        const payload = JSON.parse(body) as {
          generation?: unknown;
          releases?: readonly { releaseId?: unknown }[];
        };
        lastObserved = payload;

        if (
          !payload.releases?.some(
            (release) => release.releaseId === args.releaseId,
          )
        ) {
          logE2eFixture("Release catalog exclusion ready", {
            channel: args.channel,
            observed: lastObserved,
            releaseId: args.releaseId,
            url,
          });
          return;
        }
      } else {
        lastError = `HTTP ${response.status}: ${truncateForLog(body)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const attempt = index + 1;
    if (
      shouldLogUpdateCheckProgress(attempt, UPDATE_CHECK_EXCLUSION_ATTEMPTS)
    ) {
      logE2eFixture("Release catalog exclusion pending", {
        attempt,
        attempts: UPDATE_CHECK_EXCLUSION_ATTEMPTS,
        excludedReleaseId: args.releaseId,
        lastError,
        lastObserved,
        platform: fixtureSession.platform,
        url,
      });
    }

    await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal);
  }

  logE2eFixture("Release catalog exclusion timeout", {
    excludedReleaseId: args.releaseId,
    lastError,
    lastObserved,
    platform: fixtureSession.platform,
    url,
  });

  throw createEndpointError(
    [
      "Timed out waiting for Release catalog exclusion.",
      `Expected catalog not to return releaseId=${args.releaseId}.`,
      `URL: ${url}`,
    ].join("\n"),
    {
      expected: {
        excludedReleaseId: args.releaseId,
      },
      lastError,
      lastObserved,
      platform: fixtureSession.platform,
      url,
    },
  );
}

function createWaitForRecoveryTimeoutError(args: {
  attempts: number;
  crashedBundleId: string;
  crashHistory: JsonSnapshot;
  crashMarker: JsonSnapshot;
  launchReport: JsonSnapshot;
  metadata: JsonSnapshot;
  stableBundleId: string;
}) {
  const metadataState = getMetadataState(args.metadata.value);
  const launchReportState = getLaunchReportState(args.launchReport.value);
  const message = [
    "Timed out waiting for crash recovery state.",
    `Expected stagingBundleId=${args.stableBundleId}, verificationPending=false, launchReport.status=RECOVERED, fromBundleId=${args.crashedBundleId}, toBundleId=${args.stableBundleId}.`,
    `${formatObservedMetadataState(metadataState)}.`,
    `Observed launchReport.status=${String(launchReportState.status)}, fromBundleId=${String(launchReportState.fromBundleId)}, and toBundleId=${String(launchReportState.toBundleId)}.`,
    `Metadata path: ${args.metadata.path}`,
  ].join("\n");

  return createEndpointError(message, {
    attempts: args.attempts,
    expected: {
      crashedBundleId: args.crashedBundleId,
      stableBundleId: args.stableBundleId,
      status: "RECOVERED",
      verificationPending: false,
    },
    observed: {
      crashHistory: args.crashHistory,
      crashMarker: args.crashMarker,
      launchReport: args.launchReport,
      launchReportState,
      metadata: args.metadata,
      metadataState,
    },
    platform: fixtureSession.platform,
  });
}

function readIosRecoveryDiagnostics() {
  if (isLynxE2eApp()) {
    return {
      crashHistory: readLynxSynthesizedSnapshot("crashed-history.json"),
      crashMarker: {
        exists: false,
        path: "lynx-recovery-crash-marker.json",
        readError: null,
        value: null,
      },
      launchReport: readLynxSynthesizedSnapshot("launch-report.json"),
      metadata: readLynxSynthesizedSnapshot("metadata.json"),
    };
  }
  const storePath = ensureStorePath();
  return {
    crashHistory: readOptionalJsonSnapshot(
      path.join(storePath, "crashed-history.json"),
    ),
    crashMarker: readOptionalJsonSnapshot(
      path.join(storePath, "recovery-crash-marker.json"),
    ),
    launchReport: readOptionalJsonSnapshot(
      path.join(storePath, "launch-report.json"),
    ),
    metadata: readOptionalJsonSnapshot(path.join(storePath, "metadata.json")),
  };
}

function readAndroidRecoveryDiagnostics(
  artifactNames: CrashRecoveryArtifactNames,
) {
  return {
    crashHistory: readAndroidStoreSnapshot(
      "crashed-history.json",
      artifactNames.crashHistory,
    ),
    crashMarker: readAndroidStoreSnapshot(
      "recovery-crash-marker.json",
      artifactNames.crashMarker,
    ),
    launchReport: readAndroidStoreSnapshot(
      "launch-report.json",
      artifactNames.launchReport,
    ),
    metadata: readAndroidStoreSnapshot("metadata.json", artifactNames.metadata),
  };
}

export function createLynxRecoveryLaunchConfiguration() {
  return serializeLynxNativeLaunchConfiguration(
    createLynxNativeLaunchConfiguration({
      appBaseURL: fixtureSession.appBaseUrl,
      channel: "production",
      runtimeConfigURL: getRuntimeConfigUrl(),
    }),
  );
}

function launchAndroidApp({
  explicitActivity = false,
  forceStop = true,
}: {
  explicitActivity?: boolean;
  forceStop?: boolean;
} = {}) {
  logE2eFixture("android recovery relaunch", {
    appId: fixtureSession.appId,
    coldStart: true,
    deviceId,
    explicitActivity,
    forceStop,
  });
  if (forceStop) {
    captureCommand(
      "adb",
      [
        "-s",
        deviceId as string,
        "shell",
        "am",
        "force-stop",
        fixtureSession.appId,
      ],
      {
        allowFailure: true,
        cwd: REPO_DIR,
      },
    );
  }

  const launchArgs = isLynxE2eApp()
    ? [
        "-s",
        deviceId as string,
        "shell",
        "am",
        "start",
        "-S",
        "-n",
        `${fixtureSession.appId}/.OtaActivity`,
        ...createLynxAndroidLaunchConfigurationArguments(
          createLynxRecoveryLaunchConfiguration(),
        ),
      ]
    : explicitActivity
      ? [
          "-s",
          deviceId as string,
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          `${fixtureSession.appId}/.MainActivity`,
        ]
      : [
          "-s",
          deviceId as string,
          "shell",
          "monkey",
          "-p",
          fixtureSession.appId,
          "-c",
          "android.intent.category.LAUNCHER",
          "1",
        ];
  const launchOutput = captureCommand("adb", launchArgs, {
    cwd: REPO_DIR,
  });
  const pid = captureCommand(
    "adb",
    ["-s", deviceId as string, "shell", "pidof", fixtureSession.appId],
    {
      allowFailure: true,
      cwd: REPO_DIR,
    },
  );
  logE2eFixture("android recovery relaunch started", {
    appId: fixtureSession.appId,
    deviceId,
    explicitActivity,
    launchOutput,
    pid: pid || null,
  });
}

function launchIosApp() {
  logE2eFixture("ios metadata wait relaunch", {
    appId: fixtureSession.appId,
    deviceId,
  });
  const args = ["simctl", "launch", deviceId as string, fixtureSession.appId];
  if (isLynxE2eApp()) {
    args.push("--ota-framework=react", "--ota-channel=production");
    args.push(
      `${HOT_UPDATER_LYNX_IOS_LAUNCH_CONFIGURATION_PREFIX}${createLynxRecoveryLaunchConfiguration()}`,
    );
  }
  captureCommand("xcrun", args, {
    allowFailure: true,
  });
}

function parseAndroidFocusedPackage(output: string) {
  const patterns = [
    /mCurrentFocus=.*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9._$]+/,
    /mFocusedApp=.*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9._$]+/,
    /topResumedActivity=.*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9._$]+/,
    /mResumedActivity:.*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9._$]+/,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function getAndroidFocusedPackage() {
  const windowOutput = getAndroidWindowOutput();
  const focusedWindowPackage = parseAndroidFocusedPackage(windowOutput);
  if (focusedWindowPackage) {
    return focusedWindowPackage;
  }

  const activityOutput = captureCommand(
    "adb",
    ["-s", deviceId as string, "shell", "dumpsys", "activity", "activities"],
    { allowFailure: true },
  );
  return parseAndroidFocusedPackage(activityOutput);
}

function getAndroidProcessId() {
  return captureCommand(
    "adb",
    ["-s", deviceId as string, "shell", "pidof", fixtureSession.appId],
    { allowFailure: true },
  );
}

function readAndroidAutomaticRestartLogs() {
  return captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "logcat",
      "-d",
      "-v",
      "brief",
      "HotUpdaterE2E:I",
      "HotUpdaterImpl:I",
      "HotUpdaterRecovery:I",
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 1024 * 1024 },
  );
}

async function waitForAndroidRestart(
  bundleId: string,
  releaseId: string,
  runtimeScenarioMarker: string | undefined,
  signal?: AbortSignal,
) {
  if (fixtureSession.platform !== "android") {
    return {};
  }

  const launchLogMarker = androidLaunchLogMarker;
  if (!launchLogMarker) {
    throw new Error("Missing Android launch log marker");
  }

  let lastFocusedPackage: string | null = null;
  let lastProcessId = "";
  let lastHasNativeRestartEvidence = false;
  let lastMetadata = readAndroidMetadataSnapshot(
    "wait-for-android-restart-metadata.json",
  );
  let lastNativeLogs = "";
  let waitState = { clearedObservations: 0 };

  if (isLynxE2eApp()) {
    if (!runtimeScenarioMarker) {
      throw new Error("Lynx runtime replacement marker is required");
    }
    for (
      let attempt = 1;
      attempt <= E2E_ANDROID_RESTART_WAIT_ATTEMPTS;
      attempt += 1
    ) {
      throwIfAborted(signal);
      const screen = readE2eScreenStateSnapshot();
      const processId = getAndroidProcessId().trim();
      const focusedPackage = getAndroidFocusedPackage();
      if (
        isLynxManagedRuntimeReplacementReady({
          appId: fixtureSession.appId,
          bundleId: screen.currentBundleId,
          expectedBundleId: bundleId,
          expectedReleaseId: releaseId,
          expectedRuntimeScenarioMarker: runtimeScenarioMarker,
          focusedPackage,
          processId,
          releaseId: screen.currentReleaseId,
          runtimeScenarioMarker: screen.runtimeScenarioMarker,
          verificationPending: screen.verificationPending,
        })
      ) {
        logE2eFixture("android managed runtime replacement observed", {
          attempt,
          bundleId,
          focusedPackage,
          processId,
          releaseId,
          runtimeScenarioMarker,
        });
        androidLaunchLogMarker = null;
        return { bundleId, focusedPackage, processId, releaseId };
      }
      await abortableSleep(E2E_ANDROID_FOREGROUND_POLL_MS, signal);
    }
    const screen = readE2eScreenStateSnapshot();
    throw createEndpointError(
      "Timed out waiting for the Android managed Lynx runtime replacement",
      {
        expected: { bundleId, releaseId, runtimeScenarioMarker },
        observed: { screen },
      },
    );
  }

  for (
    let attempt = 1;
    attempt <= E2E_ANDROID_RESTART_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    throwIfAborted(signal);
    lastFocusedPackage = getAndroidFocusedPackage();
    lastProcessId = getAndroidProcessId();
    lastMetadata = readAndroidMetadataSnapshot(
      "wait-for-android-restart-metadata.json",
    );
    const metadataState = getMetadataState(lastMetadata.value);
    const hasTargetStaging =
      metadataState.stagingBundleId === bundleId &&
      metadataState.stagingSelection?.releaseId === releaseId;
    lastNativeLogs = readAndroidAutomaticRestartLogs();
    lastHasNativeRestartEvidence = isLynxE2eApp()
      ? hasLynxNativeRestartEvidence(lastNativeLogs)
      : hasNativeRestartEvidenceAfterMarker(lastNativeLogs, launchLogMarker);
    waitState = advanceAndroidRestartWait(waitState, {
      hasNativeRestartEvidence: lastHasNativeRestartEvidence,
      hasTargetStaging,
      processReady: isAndroidRecoveryProcessReady({
        appId: fixtureSession.appId,
        focusedPackage: lastFocusedPackage,
        hasNativeRestartEvidence: lastHasNativeRestartEvidence,
        processId: lastProcessId,
      }),
    });

    // Require the current launch's restart log, target staging metadata, and
    // a stable foreground process before the driver can interact again.
    if (
      waitState.clearedObservations >= E2E_ANDROID_RESTART_STABLE_OBSERVATIONS
    ) {
      logE2eFixture("android automatic restart observed", {
        attempt,
        bundleId,
        clearedObservations: waitState.clearedObservations,
        focusedPackage: lastFocusedPackage,
        processId: lastProcessId || null,
        releaseId,
      });
      androidLaunchLogMarker = null;
      return {
        bundleId,
        focusedPackage: lastFocusedPackage,
        processId: lastProcessId || null,
        releaseId,
      };
    }

    await abortableSleep(E2E_ANDROID_FOREGROUND_POLL_MS, signal);
  }

  const nativeLogPath = writeResultDiagnosticFile(
    "wait-for-android-restart-native.log",
    lastNativeLogs,
  );
  throw createEndpointError(
    `Timed out waiting for the Android automatic restart; nativeRestart=${String(lastHasNativeRestartEvidence)}, focusedPackage=${String(lastFocusedPackage)}, processId=${lastProcessId || "none"}`,
    {
      expected: { bundleId, releaseId },
      nativeLogPath,
      observed: {
        metadata: lastMetadata,
        metadataState: getMetadataState(lastMetadata.value),
        nativeRestart: lastHasNativeRestartEvidence,
      },
    },
  );
}

function getAndroidWindowOutput() {
  return captureCommand(
    "adb",
    ["-s", deviceId as string, "shell", "dumpsys", "window", "windows"],
    { allowFailure: true },
  );
}

function getAndroidAnrPackage(windowOutput: string) {
  const match = windowOutput.match(
    /Window\{[^\n]*Application Not Responding:\s*([A-Za-z0-9._]+)/i,
  );
  return match?.[1] ?? null;
}

function androidAnrStopPackages(anrPackage: string) {
  if (anrPackage === "system" || anrPackage === "com.android.systemui") {
    return [];
  }
  return [anrPackage];
}

async function dismissAndroidAnrWindow(reason: string) {
  let anrPackage = getAndroidAnrPackage(getAndroidWindowOutput());
  if (!anrPackage) {
    return false;
  }

  logE2eFixture("android dismiss anr window", {
    anrPackage,
    reason,
  });

  for (
    let attempt = 1;
    attempt <= E2E_ANDROID_ANR_DISMISS_ATTEMPTS;
    attempt += 1
  ) {
    for (const stopPackage of androidAnrStopPackages(anrPackage)) {
      captureCommand(
        "adb",
        ["-s", deviceId as string, "shell", "am", "force-stop", stopPackage],
        { allowFailure: true },
      );
    }
    captureCommand(
      "adb",
      ["-s", deviceId as string, "shell", "input", "keyevent", "KEYCODE_ENTER"],
      { allowFailure: true },
    );

    await sleep(E2E_ANDROID_FOREGROUND_POLL_MS);
    anrPackage = getAndroidAnrPackage(getAndroidWindowOutput());
    if (!anrPackage) {
      logE2eFixture("android anr window dismissed", {
        attempt,
        reason,
      });
      return true;
    }
  }

  logE2eFixture("android anr window still visible", {
    anrPackage,
    attempts: E2E_ANDROID_ANR_DISMISS_ATTEMPTS,
    reason,
  });
  return true;
}

type WaitForMetadataOptions = {
  attempts?: number;
  releaseId?: string | null;
  recoveredStableBundleId?: string;
  relaunchLimit?: number;
  signal?: AbortSignal;
};

function resolveMetadataWaitOption(
  value: number | undefined,
  fallback: number,
) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

async function waitForIosMetadataState(
  bundleId: string,
  verificationPending: boolean,
  options: WaitForMetadataOptions = {},
) {
  let totalAttempts = 0;
  const attempts = resolveMetadataWaitOption(
    options.attempts,
    E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH,
  );
  const relaunchLimit = resolveMetadataWaitOption(
    options.relaunchLimit,
    E2E_METADATA_WAIT_RELAUNCH_LIMIT,
  );
  const recoveredStableBundleId = options.recoveredStableBundleId;

  for (
    let relaunchIndex = 0;
    relaunchIndex <= relaunchLimit;
    relaunchIndex += 1
  ) {
    for (let index = 0; index < attempts; index += 1) {
      throwIfAborted(options.signal);
      totalAttempts += 1;

      const metadata = readIosMetadataSnapshot();
      const metadataState = resolveMetadataState(metadata.value);
      if (metadataState.stagingBundleId !== null || metadata.value) {
        if (
          isExpectedMetadataStateReached(
            metadataState,
            bundleId,
            verificationPending,
            options.releaseId,
            isLynxE2eApp(),
          )
        ) {
          return;
        }

        if (verificationPending && recoveredStableBundleId) {
          const launchReport = readOptionalJsonSnapshot(
            path.join(ensureStorePath(), "launch-report.json"),
          );
          if (
            isExpectedCrashRecoveryReached(
              metadataState,
              getLaunchReportState(launchReport.value),
              bundleId,
              recoveredStableBundleId,
            )
          ) {
            return;
          }
        }
      }
      await abortableSleep(E2E_POLL_INTERVAL_MS, options.signal);
    }

    const metadata = readIosMetadataSnapshot();
    const metadataState = resolveMetadataState(metadata.value);
    if (relaunchIndex === relaunchLimit) {
      break;
    }

    logE2eFixture("ios metadata wait retry", {
      expectedBundleId: bundleId,
      expectedVerificationPending: verificationPending,
      observed: metadataState,
      relaunchAttempt: relaunchIndex + 1,
      relaunchLimit,
    });
    await prepareAppLaunch();
    launchIosApp();
    await abortableSleep(E2E_IOS_LAUNCH_SETTLE_MS, options.signal);
  }

  throw createWaitForMetadataTimeoutError({
    attempts: totalAttempts,
    bundleId,
    ...readIosWaitForMetadataDiagnostics(),
    releaseId: options.releaseId,
    verificationPending,
  });
}

async function waitForAndroidMetadataState(
  bundleId: string,
  verificationPending: boolean,
  options: WaitForMetadataOptions = {},
) {
  let totalAttempts = 0;
  const attempts = resolveMetadataWaitOption(
    options.attempts,
    E2E_ANDROID_METADATA_WAIT_ATTEMPTS_PER_LAUNCH,
  );
  const relaunchLimit = resolveMetadataWaitOption(
    options.relaunchLimit,
    E2E_METADATA_WAIT_RELAUNCH_LIMIT,
  );
  const recoveredStableBundleId = options.recoveredStableBundleId;

  for (
    let relaunchIndex = 0;
    relaunchIndex <= relaunchLimit;
    relaunchIndex += 1
  ) {
    for (let index = 0; index < attempts; index += 1) {
      throwIfAborted(options.signal);
      totalAttempts += 1;

      const metadata = readAndroidMetadataSnapshot(
        "wait-for-metadata-metadata.json",
      );
      const metadataState = resolveMetadataState(metadata.value);
      if (metadataState.stagingBundleId !== null || metadata.value) {
        if (
          isExpectedMetadataStateReached(
            metadataState,
            bundleId,
            verificationPending,
            options.releaseId,
            isLynxE2eApp(),
          )
        ) {
          return;
        }

        if (verificationPending && recoveredStableBundleId) {
          const launchReport = readAndroidStoreSnapshot(
            "launch-report.json",
            "wait-for-metadata-launch-report.json",
          );
          if (
            isExpectedCrashRecoveryReached(
              metadataState,
              getLaunchReportState(launchReport.value),
              bundleId,
              recoveredStableBundleId,
            )
          ) {
            return;
          }
        }
      }
      await abortableSleep(E2E_POLL_INTERVAL_MS, options.signal);
    }

    const metadata = readAndroidMetadataSnapshot(
      "wait-for-metadata-metadata.json",
    );
    const metadataState = resolveMetadataState(metadata.value);
    if (relaunchIndex === relaunchLimit) {
      break;
    }

    logE2eFixture("android metadata wait relaunch", {
      expectedBundleId: bundleId,
      expectedVerificationPending: verificationPending,
      observed: metadataState,
      relaunchAttempt: relaunchIndex + 1,
      relaunchLimit,
    });
    await prepareAppLaunch();
    launchAndroidApp();
    await abortableSleep(E2E_ANDROID_LAUNCH_SETTLE_MS, options.signal);
  }

  throw createWaitForMetadataTimeoutError({
    attempts: totalAttempts,
    bundleId,
    ...readAndroidWaitForMetadataDiagnostics(),
    releaseId: options.releaseId,
    verificationPending,
  });
}

async function waitForCrashRecovery(
  stableBundleId: string,
  crashedBundleId: string,
  options: { attempts?: number; signal?: AbortSignal } = {},
) {
  const launchLogMarker = androidLaunchLogMarker;
  if (
    fixtureSession.platform === "android" &&
    !isLynxE2eApp() &&
    !launchLogMarker
  ) {
    throw new Error("Missing Android launch log marker");
  }
  let readyObservations = 0;
  return waitForCrashRecoveryState({
    attempts: options.attempts ?? 360,
    crashedBundleId,
    createTimeoutError: createWaitForRecoveryTimeoutError,
    getLaunchReportState,
    getMetadataState,
    isAndroidRecoveryReady: () => {
      if (isLynxE2eApp()) {
        return getAndroidProcessId().trim().length > 0;
      }
      const ready = isAndroidRecoveryProcessReady({
        appId: fixtureSession.appId,
        focusedPackage: getAndroidFocusedPackage(),
        hasNativeRestartEvidence: hasNativeRestartEvidenceAfterMarker(
          readAndroidAutomaticRestartLogs(),
          launchLogMarker as string,
        ),
        processId: getAndroidProcessId(),
      });
      readyObservations = ready ? readyObservations + 1 : 0;
      return readyObservations >= E2E_ANDROID_RESTART_STABLE_OBSERVATIONS;
    },
    platform: fixtureSession.platform,
    pollIntervalMs: E2E_POLL_INTERVAL_MS,
    readDiagnostics: (artifactNames) =>
      fixtureSession.platform === "ios"
        ? readIosRecoveryDiagnostics()
        : readAndroidRecoveryDiagnostics(artifactNames),
    signal: options.signal,
    sleepMs: abortableSleep,
    stableBundleId,
  });
}

async function prepareAppLaunch() {
  resetE2eScreenState();
  resetPendingE2eAction();
  assertConfiguredBaseUrl();
  await seedMissingE2ECohort();

  if (fixtureSession.platform === "ios") {
    captureCommand(
      "xcrun",
      ["simctl", "terminate", deviceId as string, fixtureSession.appId],
      { allowFailure: true },
    );
    await sleep(E2E_POLL_INTERVAL_MS);
    return prepareE2eStartupCheck();
  }

  if (fixtureSession.platform !== "android") {
    return {};
  }

  const focusedPackage = getAndroidFocusedPackage();
  const alreadyFocused = focusedPackage === fixtureSession.appId;
  logE2eFixture("android prepare app launch", {
    alreadyFocused,
    focusedPackage,
    targetAppId: fixtureSession.appId,
  });

  await dismissAndroidAnrWindow("prepare-app-launch");

  ensureAndroidReverse();
  ensureAndroidControlReverse();
  if (!alreadyFocused) {
    captureCommand(
      "adb",
      [
        "-s",
        deviceId as string,
        "shell",
        "am",
        "force-stop",
        fixtureSession.appId,
      ],
      { allowFailure: true },
    );
    await sleep(E2E_POLL_INTERVAL_MS);
  }

  androidLaunchLogMarker = `HotUpdaterE2ELaunch:${randomUUID()}`;
  captureCommand("adb", [
    "-s",
    deviceId as string,
    "shell",
    "log",
    "-t",
    "HotUpdaterE2E",
    androidLaunchLogMarker,
  ]);

  return { alreadyFocused, ...prepareE2eStartupCheck(alreadyFocused) };
}

async function resetBootstrappedAppSource() {
  fixtureSession.builtInBundleId = null;
  fixtureSession.deployedBundles = [];
  fixtureSession.observedInsightsEvents = [];
  fixtureSession.storePath = null;
  handleConfigureProxy({
    artifactDelayMs: 0,
    catalogDelayMs: 0,
    catalogMode: "live",
    replayGeneration: null,
    reset: true,
  });
  await restoreFile(
    fixtureSession.configBackupPath,
    fixtureSession.configSourceFile,
  );
  await restoreFile(fixtureSession.appBackupPath, fixtureSession.appSourceFile);
  await restoreGeneratedDeployFixtures();
  await applyAppScenario({
    bundleProfile: "default",
    marker: fixtureSession.initialMarker,
    mode: "reset",
    safeBundleIds: [],
  });
}

async function bootstrap() {
  if (fixtureSession.bootstrapResult) {
    await resetBootstrappedAppSource();
    logE2eFixture("bootstrap session reset", {
      platform: fixtureSession.platform,
    });
    return fixtureSession.bootstrapResult;
  }

  if (!fixtureSession.appBackupPath) {
    fixtureSession.appBackupPath = await backupFile(
      fixtureSession.appSourceFile,
    );
  }
  if (!fixtureSession.configBackupPath) {
    fixtureSession.configBackupPath = await backupFile(
      fixtureSession.configSourceFile,
    );
  }
  if (!fixtureSession.envBackupPath) {
    fixtureSession.envBackupPath = await backupFile(
      fixtureSession.envSourceFile,
    );
  }
  if (!fixtureSession.sizeAwareLargeAssetBackupCaptured) {
    fixtureSession.sizeAwareLargeAssetBackupPath = await backupFile(
      fixtureSession.sizeAwareLargeAssetPath,
    );
    fixtureSession.sizeAwareLargeAssetBackupCaptured = true;
  }

  fixtureSession.builtInBundleId = null;
  fixtureSession.deployedBundles = [];
  fixtureSession.observedInsightsEvents = [];
  fixtureSession.storePath = null;
  handleConfigureProxy({
    artifactDelayMs: 0,
    catalogDelayMs: 0,
    catalogMode: "live",
    replayGeneration: null,
    reset: true,
  });

  await waitForLocalProviderReady();
  await clearProviderReleasesAfterReadiness();
  await restoreFile(
    fixtureSession.sizeAwareLargeAssetBackupPath,
    fixtureSession.sizeAwareLargeAssetPath,
  );
  await restoreGeneratedDeployFixtures();
  await restoreFile(
    fixtureSession.configBackupPath,
    fixtureSession.configSourceFile,
  );
  await patchEnvRuntimeConfigUrl();
  await exportNativePublicKeyFromSigningKey();
  await applyAppScenario({
    bundleProfile: "default",
    marker: fixtureSession.initialMarker,
    mode: "reset",
    safeBundleIds: [],
  });

  fixtureSession.bootstrapResult = {
    emptyCrashHistoryText: "No crashed bundles recorded\\.",
    initialMarker: fixtureSession.initialMarker,
  };
  return fixtureSession.bootstrapResult;
}

async function captureBuiltInBundleId() {
  const builtInBundleId = e2eBuiltInBundleId(fixtureSession.appId);

  fixtureSession.builtInBundleId = builtInBundleId;

  return { builtInBundleId };
}

function bareBuildCacheEnv({
  bundleProfile,
  request,
}: {
  bundleProfile: BundleProfile;
  request: DeployBundleRequest;
}) {
  const cacheRoot = bareBuildCacheRoot();
  if (!cacheRoot) {
    return undefined;
  }

  const cacheKey = hashText(
    JSON.stringify({
      bundleProfile,
      cacheVersion: BARE_BUILD_CACHE_VERSION,
      configHash: bareBuildConfigFingerprint(),
      crossProvenance: request.crossProvenance === true,
      inputHash: hashBareBuildInputs(),
      marker: request.marker,
      mode: request.mode,
      platform: fixtureSession.platform,
      safeBundleIds: request.safeBundleIds,
    }),
  );

  return {
    HOT_UPDATER_BARE_BUILD_CACHE_DIR: cacheRoot,
    HOT_UPDATER_BARE_BUILD_CACHE_KEY: cacheKey,
  };
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireBareBuildCacheLock(
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal,
) {
  const cacheDir = env?.HOT_UPDATER_BARE_BUILD_CACHE_DIR;
  const cacheKey = env?.HOT_UPDATER_BARE_BUILD_CACHE_KEY;
  if (!cacheDir || !cacheKey) {
    return null;
  }

  const lockRoot = path.join(cacheDir, ".locks");
  const lockPath = path.join(lockRoot, `${cacheKey}.lock`);
  await fsPromises.mkdir(lockRoot, { recursive: true });
  let loggedWait = false;

  const readOwner = async () => {
    try {
      return JSON.parse(
        await fsPromises.readFile(path.join(lockPath, "owner.json"), "utf8"),
      ) as { pid?: unknown; platform?: unknown; startedAt?: unknown };
    } catch {
      return null;
    }
  };

  const isOwnerAlive = (owner: Awaited<ReturnType<typeof readOwner>>) => {
    if (
      !owner ||
      typeof owner.pid !== "number" ||
      !Number.isInteger(owner.pid)
    ) {
      return true;
    }

    return isProcessRunning(owner.pid);
  };

  while (true) {
    throwIfAborted(signal);
    try {
      await fsPromises.mkdir(lockPath);
      await fsPromises.writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify(
          {
            pid: process.pid,
            platform: fixtureSession.platform,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      logE2eFixture("bare build cache lock acquired", { cacheKey });
      return lockPath;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }

      const stats = await fsPromises.stat(lockPath).catch(() => null);
      const ageMs = stats ? Date.now() - stats.mtimeMs : 0;
      const owner = await readOwner();
      if (!isOwnerAlive(owner)) {
        logE2eFixture("bare build cache lock owner exited; removing", {
          cacheKey,
          owner,
        });
        await fsPromises.rm(lockPath, { force: true, recursive: true });
        loggedWait = false;
        continue;
      }

      if (stats && ageMs > BARE_BUILD_CACHE_LOCK_STALE_MS) {
        logE2eFixture("bare build cache lock stale; removing", {
          ageMs,
          cacheKey,
        });
        await fsPromises.rm(lockPath, { force: true, recursive: true });
        continue;
      }

      if (!loggedWait) {
        logE2eFixture("bare build cache lock waiting", { cacheKey });
        loggedWait = true;
      }
      await abortableSleep(BARE_BUILD_CACHE_LOCK_WAIT_MS, signal);
    }
  }
}

async function deployFixtureBundle(
  request: DeployBundleRequest,
  context?: JobExecutionContext,
) {
  const signal = context?.signal;
  const bundleProfile = resolveBundleProfile(request.bundleProfile);
  const remoteChannel = getFixtureChannel(request.channel);
  const patchEnabled =
    request.diffBaseBundleId !== undefined ||
    request.patchMaxBaseBundles !== undefined;

  if (bundleProfile === "multiAssetReplacement") {
    throwIfAborted(signal);
    await ensureMultiAssetFixtures(request.marker);
  }
  if (bundleProfile === "sizeAwareLargeDiff") {
    throwIfAborted(signal);
    await ensureSizeAwareLargeAsset(request.marker);
  }

  throwIfAborted(signal);
  await applyDeployConfig({
    patchEnabled,
    patchMaxBaseBundles: request.patchMaxBaseBundles,
    strategy: request.strategy ?? "appVersion",
  });
  await applyAppScenario({
    bundleProfile,
    marker: request.marker,
    mode: request.mode,
    safeBundleIds: request.safeBundleIds,
  });

  const deployOutputPath = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "hu-e2e-deploy-"),
  );
  const args = [
    HOT_UPDATER_CLI_PATH,
    "deploy",
    "-p",
    fixtureSession.platform,
    "-t",
    request.targetAppVersion,
    "-c",
    remoteChannel,
    "-o",
    deployOutputPath,
  ];

  if (typeof request.rollout === "number") {
    args.push("-r", String(request.rollout));
  }

  if (request.forceUpdate) {
    args.push("-f");
  }

  if (request.disabled) {
    args.push("--disabled");
  }

  if (request.message) {
    args.push("-m", request.message);
  }

  const deployLogPath = path.join(
    fixtureSession.resultsDir,
    `deploy-${remoteChannel}-${request.marker}.log`,
  );
  logE2eFixture("deploy start", {
    bundleProfile,
    bareBuildCache: Boolean(bareBuildCacheRoot()),
    channel: request.channel,
    channelNamespace,
    command: `node ${args.join(" ")}`,
    logPath: path.relative(REPO_DIR, deployLogPath),
    marker: request.marker,
    mode: request.mode,
    platform: fixtureSession.platform,
    remoteChannel,
    targetAppVersion: request.targetAppVersion,
  });
  const cacheEnv = bareBuildCacheEnv({ bundleProfile, request });
  if (request.crossProvenance && !isLynxE2eApp()) {
    throw new Error("crossProvenance is only supported by the Lynx E2E app");
  }
  const deployEnv = request.crossProvenance
    ? {
        ...cacheEnv,
        HOT_UPDATER_E2E_BUILD_MODE: "cross-provenance",
        HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE: `${lynxE2eRuntimeId(fixtureSession.platform)}-cross-provenance-rejected`,
      }
    : cacheEnv;
  const deployProcessLock = await acquireFairFileLock({
    capacity: DEPLOY_LOCK_CAPACITY,
    lockRoot: deployProcessLockRoot(),
    onAbandoned: ({ ageMs, lockPath, owner, reason }) => {
      logE2eFixture(
        reason === "owner-exited"
          ? "deploy process lock owner exited; removing"
          : "deploy process lock stale; removing",
        { ageMs, lockPath, owner },
      );
    },
    onWait: ({ owner, position }) => {
      logE2eFixture("deploy process lock waiting", {
        lockPath: deployProcessLockRoot(),
        owner,
        platform: fixtureSession.platform,
        position,
      });
    },
    ownerLabel: fixtureSession.platform,
    signal,
    staleMs: BARE_BUILD_CACHE_LOCK_STALE_MS,
    waitIntervalMs: BARE_BUILD_CACHE_LOCK_WAIT_MS,
  });
  logE2eFixture("deploy process lock acquired", {
    lockPath: deployProcessLock.lockPath,
    platform: fixtureSession.platform,
  });
  let bareBuildLockPath: string | null = null;
  let deployDurationMs = 0;
  const deployOutput = await (async () => {
    try {
      bareBuildLockPath = await acquireBareBuildCacheLock(deployEnv, signal);
      const deployStartedAt = Date.now();
      const output = await runLoggedCommand("node", args, {
        cwd: fixtureSession.exampleDir,
        env: getHotUpdaterControlEnv(deployEnv),
        logPath: deployLogPath,
        signal,
        onInterrupted: context?.markQuiescenceUncertain,
      });
      deployDurationMs = Date.now() - deployStartedAt;
      return output;
    } finally {
      if (bareBuildLockPath) {
        await fsPromises.rm(bareBuildLockPath, {
          force: true,
          recursive: true,
        });
      }
      await deployProcessLock.release();
    }
  })();
  const releaseId = extractDeployReleaseId(deployOutput);
  if (!releaseId) {
    throw new Error(
      [
        "Failed to resolve deployed update ID from hot-updater deploy output.",
        `See ${deployLogPath}`,
      ].join("\n"),
    );
  }
  let deployed = await resolveDeployedRelease(releaseId, remoteChannel);
  const bundleId = deployed.release.bundle_id;
  if (bundleId === null) {
    throw new Error(`Deployed update ${releaseId} does not reference a file.`);
  }

  const deployTiming = {
    bundleProfile,
    channel: request.channel,
    durationMs: deployDurationMs,
    marker: request.marker,
    mode: request.mode,
    platform: fixtureSession.platform,
  };
  logE2eFixture("deploy timing", deployTiming);
  logE2eFixture("deploy done", {
    ...deployTiming,
    logPath: path.relative(REPO_DIR, deployLogPath),
  });
  await fsPromises.rm(deployOutputPath, { force: true, recursive: true });

  if (request.targetCohorts && request.targetCohorts.length > 0) {
    const updated = await patchProviderRelease(deployed.release.id, {
      targetCohorts: request.targetCohorts,
    });
    deployed = {
      ...deployed,
      catalog: updated.catalog,
      release: updated.release!,
    };
  }
  let bundle = await fetchProviderBundleById(bundleId);
  if (shouldWaitForUpdateCheckVisibility(request)) {
    await waitForReleaseCatalogVisibility({
      bundleId,
      catalog: deployed.catalog,
      channel: remoteChannel,
      expectedFileHash: bundle.manifestFileHash,
      releaseId: deployed.release.id,
      signal,
    });
  }

  const diff =
    request.diffBaseBundleId !== undefined
      ? await resolveAutoPatchBundleDiff(request.diffBaseBundleId, bundleId)
      : null;
  bundle = await fetchProviderBundleById(bundleId);
  const patchBaseBundleIds = getBundlePatchBaseBundleIds(bundle);
  const deployedRuntimeId = isLynxE2eApp()
    ? request.crossProvenance
      ? `${lynxE2eRuntimeId(fixtureSession.platform)}-cross-provenance-rejected`
      : lynxE2eRuntimeId(fixtureSession.platform)
    : null;

  fixtureSession.deployedBundles.push({
    bundleId,
    bundleProfile,
    channel: remoteChannel,
    crossProvenance: request.crossProvenance === true,
    diffBaseBundleId: diff?.baseBundleId ?? null,
    diffPatchAssetPath: diff?.patchAssetPath ?? null,
    enabled: deployed.release.enabled,
    marker: request.marker,
    mode: request.mode,
    patchBaseBundleIds,
    releaseId: deployed.release.id,
    runtimeId: deployedRuntimeId,
    rolloutCohortCount: deployed.release.rollout_cohort_count,
    scopeKey: deployed.release.scope_key,
    shouldForceUpdate: deployed.release.should_force_update,
    targetCohorts: [...deployed.release.target_cohorts],
  });

  return {
    catalogId: deployed.catalogId,
    bundleId,
    bundleProfile,
    channel: remoteChannel,
    diffBaseBundleId: diff?.baseBundleId,
    diffPatchAssetPath: diff?.patchAssetPath,
    enabled: deployed.release.enabled,
    generation: deployed.catalog.generation,
    marker: request.marker,
    multiAssetPaths:
      bundleProfile === "multiAssetReplacement"
        ? MULTI_ASSET_FIXTURES.map((fixture) =>
            fixtureSession.platform === "ios"
              ? fixture.manifestPath
              : fixture.androidManifestPath,
          )
        : undefined,
    patchBaseBundleIds,
    primaryBundleAssetPath: getPrimaryBundleAssetPath(),
    releaseId: deployed.release.id,
    ...(deployedRuntimeId
      ? {
          runtimeId: deployedRuntimeId,
        }
      : {}),
    rolloutCohortCount: deployed.release.rollout_cohort_count,
    scopeKey: deployed.release.scope_key,
    shouldForceUpdate: deployed.release.should_force_update,
    targetCohorts: deployed.release.target_cohorts,
  };
}

async function updateFixtureRelease(
  request: PatchReleaseRequest,
  context?: JobExecutionContext,
) {
  const signal = context?.signal;
  throwIfAborted(signal);
  const result = await patchProviderRelease(request.releaseId, {
    enabled: request.enabled,
    rolloutCohortCount: request.rolloutCohortCount,
    shouldForceUpdate: request.shouldForceUpdate,
    targetCohorts: request.targetCohorts,
  });
  const release = result.release!;
  const channel = await withConfiguredDatabase(async ({ core }) =>
    (await core.listChannels()).find(
      (candidate) => candidate.id === release.channel_id,
    ),
  );
  if (channel === undefined) {
    throw new Error(`No Channel for Release ${request.releaseId}.`);
  }
  if (request.enabled === false && release.enabled === false) {
    await waitForReleaseCatalogExcludesRelease({
      catalog: result.catalog,
      channel: channel.name,
      releaseId: release.id,
      signal,
    });
  }

  updateTrackedReleaseRecord(request.releaseId, {
    enabled: release.enabled,
    rolloutCohortCount: release.rollout_cohort_count,
    shouldForceUpdate: release.should_force_update,
    targetCohorts:
      release.target_cohorts === null ? null : [...release.target_cohorts],
  });

  return {
    bundleId: release.bundle_id,
    channel: channel.name,
    enabled: release.enabled,
    generation: result.catalog.generation,
    releaseId: release.id,
    revision: release.revision,
    rolloutCohortCount: release.rollout_cohort_count,
    scopeKey: release.scope_key,
    shouldForceUpdate: release.should_force_update,
    targetCohorts:
      release.target_cohorts === null ? null : [...release.target_cohorts],
  };
}

/** A deploy's policy for a new release in the same scope as `release`. */
function deployPolicyOf(
  release: ReleaseRow,
  channel: string,
): DeployReleasePolicy {
  return {
    channel,
    enabled: release.enabled,
    fingerprintHash: release.fingerprint_hash,
    message: release.message,
    rolloutCohortCount: release.rollout_cohort_count,
    shouldForceUpdate: release.should_force_update,
    targetAppVersion: release.target_app_version,
    targetCohorts: [...release.target_cohorts],
  };
}

async function createFixtureRepublishedRelease(input: {
  sourceReleaseId: string;
  bundleId: string;
}) {
  const created = await withConfiguredDatabase(async ({ core }) => {
    const source = await core.getRelease(input.sourceReleaseId);
    if (source === null) {
      throw new Error(`Release ${input.sourceReleaseId} was not found.`);
    }
    const channel = (await core.listChannels()).find(
      (candidate) => candidate.id === source.channel_id,
    );
    if (channel === undefined) {
      throw new Error(`Channel ${source.channel_id} was not found.`);
    }
    const bundle = await core.getBundle(input.bundleId);
    if (bundle === null || bundle.bundle.platform !== source.platform) {
      throw new Error(`Bundle ${input.bundleId} was not found.`);
    }
    // A new release for the stored bundle, in the source's scope.
    const [result] = await core.deploy([
      {
        bundleId: input.bundleId,
        release: { ...deployPolicyOf(source, channel.name), enabled: true },
      },
    ]);
    if (result?.release == null) {
      throw new Error("Republish did not create a Release.");
    }
    return {
      catalogId: result.catalog.catalog_id,
      catalog: result.catalog,
      channel,
      release: result.release,
    };
  });

  await waitForReleaseCatalogVisibility({
    bundleId: created.release.bundle_id,
    catalog: created.catalog,
    channel: created.channel.name,
    expectedFileHash:
      created.release.bundle_id === null
        ? null
        : (await fetchProviderBundleById(created.release.bundle_id))
            .manifestFileHash,
    releaseId: created.release.id,
  });

  return {
    bundleId: created.release.bundle_id,
    generation: created.catalog.generation,
    kind: created.release.kind,
    releaseId: created.release.id,
    scopeKey: created.release.scope_key,
  };
}

async function seedCrashedBundleFrontier(input: {
  count: number;
  sourceReleaseId: string;
}) {
  return withConfiguredDatabase(async ({ core }) => {
    const sourceRelease = await core.getRelease(input.sourceReleaseId);
    if (sourceRelease?.bundle_id === null || sourceRelease === null) {
      throw new Error(
        `Release ${input.sourceReleaseId} must reference a Bundle.`,
      );
    }
    const source = await core.getBundle(sourceRelease.bundle_id);
    if (source === null) {
      throw new Error(`Bundle ${sourceRelease.bundle_id} was not found.`);
    }
    const channel = (await core.listChannels()).find(
      (candidate) => candidate.id === sourceRelease.channel_id,
    );
    if (channel === undefined) {
      throw new Error(`Channel ${sourceRelease.channel_id} was not found.`);
    }
    const sourceBundle = rowToBundle(source.bundle, []);

    const bundleIds: string[] = [];
    const releaseIds: string[] = [];
    let bundleIdFloor = sourceBundle.id;
    let generation: number | null = null;
    const baseTimeMs = Date.now();

    for (let index = 0; index < input.count; index += 1) {
      const bundleId = createUUIDv7After(bundleIdFloor, baseTimeMs + index);
      // A copy of the source bundle under a new id, deployed in its scope.
      const [published] = await core.deploy([
        {
          bundle: { ...sourceBundle, id: bundleId, patches: [] },
          release: deployPolicyOf(sourceRelease, channel.name),
        },
      ]);
      if (published?.release == null) {
        throw new Error("Crash-frontier republish did not create a Release.");
      }
      bundleIds.push(bundleId);
      releaseIds.push(published.release.id);
      generation = published.catalog.generation;
      bundleIdFloor = bundleId;
    }

    return {
      bundleIds,
      generation,
      releaseIds,
      safeBundleId: sourceBundle.id,
      safeReleaseId: sourceRelease.id,
    };
  });
}

async function computeRolloutSample(releaseId: string) {
  const release = await fetchProviderReleaseById(releaseId);
  const rolloutCohorts = getRolledOutNumericCohorts(
    releaseId,
    release.rollout_cohort_count,
  );

  if (rolloutCohorts.length === 0) {
    throw new Error(`Release ${releaseId} has no eligible numeric cohorts`);
  }

  const rolloutSet = new Set(rolloutCohorts);
  const excludedCohort = Array.from({ length: 1000 }, (_, index) => index + 1)
    .find((cohortValue) => !rolloutSet.has(cohortValue))
    ?.toString();

  if (!excludedCohort) {
    throw new Error(
      `Release ${releaseId} is rolled out to all numeric cohorts; no excluded sample exists`,
    );
  }

  return {
    excludedCohort,
    includedCohort: String(rolloutCohorts[0]),
    rolloutCohortCount: release.rollout_cohort_count,
  };
}

async function waitForMetadata(
  bundleId: string,
  verificationPending: boolean,
  options: WaitForMetadataOptions = {},
) {
  const releaseId = resolveMetadataWaitReleaseId(
    bundleId,
    options.releaseId,
    fixtureSession.deployedBundles,
  );
  const releaseAwareOptions = { ...options, releaseId };
  throwIfAborted(options.signal);
  if (fixtureSession.platform === "ios") {
    await waitForIosMetadataState(
      bundleId,
      verificationPending,
      releaseAwareOptions,
    );
  } else {
    await waitForAndroidMetadataState(
      bundleId,
      verificationPending,
      releaseAwareOptions,
    );
  }

  return {};
}

function readBsdiffPatchLogs() {
  if (fixtureSession.platform === "ios") {
    return captureCommand(
      "xcrun",
      [
        "simctl",
        "spawn",
        deviceId as string,
        "log",
        "show",
        "--style",
        "compact",
        "--last",
        "10m",
        "--predicate",
        'eventMessage CONTAINS "HotUpdaterBsdiffPatchApplied" AND process != "log"',
      ],
      { allowFailure: true },
    );
  }

  return captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "logcat",
      "-d",
      "-v",
      "time",
      "BundleStorage:D",
      "HotUpdaterLynx:D",
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\n")
    .filter((line) => line.includes("HotUpdaterBsdiffPatchApplied"))
    .join("\n");
}

function readHotUpdaterNativeLogs() {
  if (fixtureSession.platform === "ios") {
    return captureCommand(
      "xcrun",
      [
        "simctl",
        "spawn",
        deviceId as string,
        "log",
        "show",
        "--style",
        "compact",
        "--last",
        "10m",
        "--predicate",
        [
          'eventMessage CONTAINS "BundleStorage"',
          'eventMessage CONTAINS "SignatureVerifier"',
          'eventMessage CONTAINS "HotUpdater"',
          'eventMessage CONTAINS "DecompressService"',
        ].join(" OR "),
      ],
      { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
    );
  }

  return captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "logcat",
      "-d",
      "-v",
      "time",
      "BundleStorage:D",
      "SignatureVerifier:D",
      "HotUpdaterRecovery:D",
      "HotUpdaterLynx:D",
      "DecompressService:D",
      "ReactNativeJS:E",
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  );
}

function readFirstOtaArchiveInstallLogs() {
  if (fixtureSession.platform === "ios") {
    const event = isLynxE2eApp()
      ? "HotUpdaterArchiveInstalled"
      : "Skipping manifest-driven install";
    return captureCommand(
      "xcrun",
      [
        "simctl",
        "spawn",
        deviceId as string,
        "log",
        "show",
        "--style",
        "compact",
        "--last",
        "10m",
        "--predicate",
        `eventMessage CONTAINS "${event}"`,
      ],
      { allowFailure: true },
    );
  }

  const event = isLynxE2eApp()
    ? "HotUpdaterArchiveInstalled"
    : "Skipping manifest-driven install";
  return captureCommand(
    "adb",
    [
      "-s",
      deviceId as string,
      "logcat",
      "-d",
      "-v",
      "time",
      "BundleStorage:D",
      "HotUpdaterLynx:D",
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\n")
    .filter((line) => line.includes(event))
    .join("\n");
}

async function readManifestDiffInstallLogs(signal?: AbortSignal) {
  return collectManifestDiffLogs({
    platform: fixtureSession.platform,
    readAndroidArchiveLogs: readFirstOtaArchiveInstallLogs,
    readAndroidBsdiffLogs: readBsdiffPatchLogs,
    readAndroidNativeLogs: readHotUpdaterNativeLogs,
    readIosLogs: () =>
      captureCommandWithDeadline(
        "xcrun",
        [
          "simctl",
          "spawn",
          deviceId as string,
          "log",
          "show",
          "--style",
          "compact",
          "--last",
          "10m",
          "--predicate",
          [
            'eventMessage CONTAINS "HotUpdaterArchiveInstalled"',
            'eventMessage CONTAINS "Skipping manifest-driven install"',
            'eventMessage CONTAINS "HotUpdaterArchiveFallbackApplied"',
            'eventMessage CONTAINS "Manifest-driven install failed"',
            'eventMessage CONTAINS "HotUpdaterBsdiffPatchApplied"',
            'eventMessage CONTAINS "HotUpdaterManifestDiffApplied"',
          ].join(" OR "),
        ],
        {
          allowFailure: true,
          maxBuffer: 8 * 1024 * 1024,
          signal,
          timeoutMs: E2E_IOS_LOG_SHOW_TIMEOUT_MS,
        },
      ),
  });
}

function includesAllFragments(logs: string, fragments: string[]) {
  return fragments.every((fragment) => logs.includes(fragment));
}

function readBsdiffPatchStoreEvidence(args: {
  assetPath: string;
  baseBundleId: string;
  bundleId?: string;
}) {
  const record = fixtureSession.deployedBundles.find(
    (entry) =>
      entry.diffBaseBundleId === args.baseBundleId &&
      entry.diffPatchAssetPath === args.assetPath &&
      (args.bundleId === undefined || entry.bundleId === args.bundleId),
  );
  if (!record) {
    return {
      ok: false,
      reason: "tracked diff bundle not found",
    };
  }

  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  const bundleFile = readBundleFileSnapshot(record.bundleId);
  const manifest = readBundleManifestSnapshot(record.bundleId);
  const expectedHash = getManifestAssetFileHash(manifest, args.assetPath);
  const assetFile = readBundleAssetFileHash(record.bundleId, args.assetPath);
  const ok =
    (isLynxE2eApp()
      ? metadataState.stableBundleId === record.bundleId
      : metadataState.stableBundleId === null) &&
    metadataState.stagingBundleId === record.bundleId &&
    metadataState.stagingSelection?.bundleId === record.bundleId &&
    metadataState.verificationPending === false &&
    hasManifestBackedBundleEvidence({
      assetFile,
      bundleFile,
      expectedHash,
      manifest,
    });

  return {
    assetFile,
    bundleFile,
    diagnostics,
    expectedHash,
    manifest,
    metadataState,
    ok,
    record,
    reason: ok ? null : "bundle-store state did not match patch evidence",
  };
}

function getPrimaryBundleAssetPath() {
  if (isLynxE2eApp()) {
    return lynxBundleFileName();
  }
  return fixtureSession.platform === "ios"
    ? "index.ios.bundle"
    : "index.android.bundle";
}

function isRecoverableAndroidAssetReadError(readError: string | null) {
  return (
    fixtureSession.platform === "android" &&
    readError !== null &&
    /ENOBUFS|Permission denied/i.test(readError)
  );
}

function hasManifestBackedBundleEvidence(args: {
  assetFile: ReturnType<typeof readBundleAssetFileHash>;
  bundleFile: ReturnType<typeof readBundleFileSnapshot>;
  expectedHash: string | null;
  manifest: JsonSnapshot;
}) {
  if (
    !args.bundleFile.exists ||
    !args.manifest.exists ||
    args.manifest.readError !== null ||
    args.expectedHash === null
  ) {
    return false;
  }

  if (
    args.assetFile.exists &&
    args.assetFile.readError === null &&
    args.assetFile.fileHash === args.expectedHash
  ) {
    return true;
  }

  return isRecoverableAndroidAssetReadError(args.assetFile.readError);
}

async function readManifestDiffState(args: {
  allowBsdiff?: boolean;
  bundleId: string;
  previousBundleId: string;
  signal?: AbortSignal;
}) {
  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  const bundleFile = readBundleFileSnapshot(args.bundleId);
  const manifest = readBundleManifestSnapshot(args.bundleId);
  const assetPath = getPrimaryBundleAssetPath();
  const expectedHash = getManifestAssetFileHash(manifest, assetPath);
  const assetFile = readBundleAssetFileHash(args.bundleId, assetPath);
  const { archiveLogs, bsdiffLogs, nativeLogs } =
    await readManifestDiffInstallLogs(args.signal);
  const archiveFragments = isLynxE2eApp()
    ? ["HotUpdaterArchiveInstalled", `bundleId=${args.bundleId}`]
    : [
        "Skipping manifest-driven install",
        `for ${args.bundleId}`,
        "no active OTA manifest is available",
        "Using archive",
      ];
  const bsdiffFragments = [
    "HotUpdaterBsdiffPatchApplied",
    `asset=${assetPath}`,
    `baseBundleId=${args.previousBundleId}`,
  ];
  const manifestFallbackFragments = isLynxE2eApp()
    ? [
        "HotUpdaterArchiveFallbackApplied",
        `bundleId=${args.bundleId}`,
        `baseBundleId=${args.previousBundleId}`,
      ]
    : [
        `Manifest-driven install failed for ${args.bundleId}`,
        "Falling back to archive",
      ];
  const record =
    fixtureSession.deployedBundles.find(
      (entry) => entry.bundleId === args.bundleId,
    ) ?? null;
  const archiveInstalled = isLynxE2eApp()
    ? hasNativeInstallEvent(archiveLogs, "HotUpdaterArchiveInstalled", {
        bundleId: args.bundleId,
      })
    : includesAllFragments(archiveLogs, archiveFragments);
  const archiveFallbackApplied = isLynxE2eApp()
    ? hasNativeInstallEvent(nativeLogs, "HotUpdaterArchiveFallbackApplied", {
        baseBundleId: args.previousBundleId,
        bundleId: args.bundleId,
      })
    : includesAllFragments(nativeLogs, manifestFallbackFragments);
  const bsdiffApplied = isLynxE2eApp()
    ? hasNativeInstallEvent(bsdiffLogs, "HotUpdaterBsdiffPatchApplied", {
        asset: assetPath,
        baseBundleId: args.previousBundleId,
        bundleId: args.bundleId,
      })
    : includesAllFragments(bsdiffLogs, bsdiffFragments);
  const ok =
    (isLynxE2eApp()
      ? metadataState.stableBundleId === args.bundleId
      : metadataState.stableBundleId === null) &&
    metadataState.stagingBundleId === args.bundleId &&
    metadataState.stagingSelection?.bundleId === args.bundleId &&
    metadataState.verificationPending === false &&
    hasManifestBackedBundleEvidence({
      assetFile,
      bundleFile,
      expectedHash,
      manifest,
    }) &&
    !archiveInstalled &&
    !archiveFallbackApplied &&
    (!isLynxE2eApp() ||
      hasNativeInstallEvent(nativeLogs, "HotUpdaterManifestDiffApplied", {
        baseBundleId: args.previousBundleId,
        bundleId: args.bundleId,
      })) &&
    (args.allowBsdiff === true || !bsdiffApplied);

  return {
    archiveFallbackApplied,
    archiveFragments,
    archiveInstalled,
    archiveLogs,
    assetFile,
    assetPath,
    bsdiffFragments,
    bsdiffApplied,
    bsdiffLogs,
    bundleFile,
    diagnostics,
    expectedHash,
    manifest,
    manifestFallbackFragments,
    metadataState,
    nativeLogs,
    ok,
    record,
  };
}

async function assertBundleAssetsStored(args: {
  assetPaths: string[];
  bundleId: string;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const evidence = readBundleAssetsStoredEvidence(args);
    if (evidence.ok) {
      logE2eFixture("bundle assets stored", {
        assetPaths: args.assetPaths,
        bundleId: args.bundleId,
        evidence: "manifest-and-bundle-store",
        platform: fixtureSession.platform,
      });
      return {};
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  throw createEndpointError(
    "Timed out waiting for bundle asset storage evidence.",
    readBundleAssetsStoredEvidence(args),
  );
}

async function assertMultipleAssetsReplaced(args: {
  assetPaths: string[];
  bundleId: string;
  previousBundleId: string;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const evidence = readMultipleAssetsReplacementEvidence(args);
    if (evidence.ok) {
      logE2eFixture("multiple assets replaced", {
        assetPaths: args.assetPaths,
        bundleId: args.bundleId,
        evidence: "manifest-hash-change-and-bundle-store",
        platform: fixtureSession.platform,
        previousBundleId: args.previousBundleId,
      });
      return {};
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  throw createEndpointError(
    "Timed out waiting for multiple asset replacement evidence.",
    readMultipleAssetsReplacementEvidence(args),
  );
}

async function assertBsdiffPatchApplied(args: {
  assetPath: string;
  baseBundleId: string;
  bundleId?: string;
}) {
  const expectedFragments = [
    "HotUpdaterBsdiffPatchApplied",
    `asset=${args.assetPath}`,
    `baseBundleId=${args.baseBundleId}`,
  ];

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const evidence = readBsdiffPatchStoreEvidence(args);
    const logs = readBsdiffPatchLogs();
    if (
      evidence.ok &&
      evidence.record !== undefined &&
      (isLynxE2eApp()
        ? hasNativeInstallEvent(logs, "HotUpdaterBsdiffPatchApplied", {
            asset: args.assetPath,
            baseBundleId: args.baseBundleId,
            bundleId: evidence.record.bundleId,
          })
        : includesAllFragments(logs, expectedFragments))
    ) {
      logE2eFixture("bsdiff patch applied", {
        assetPath: args.assetPath,
        baseBundleId: args.baseBundleId,
        bundleId: evidence.record.bundleId,
        evidence: "bundle-store-and-native-log",
        platform: fixtureSession.platform,
      });
      return {};
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const logs = readBsdiffPatchLogs();
  const evidence = readBsdiffPatchStoreEvidence(args);
  throw createEndpointError(
    "Timed out waiting for bsdiff patch application evidence.",
    {
      assetPath: args.assetPath,
      baseBundleId: args.baseBundleId,
      expectedFragments,
      evidence,
      logsTail: logs.split("\n").slice(-20),
      platform: fixtureSession.platform,
    },
  );
}

async function assertManifestDiffApplied(args: {
  allowBsdiff?: boolean;
  bundleId: string;
  previousBundleId: string;
  signal?: AbortSignal;
}) {
  const observed = capturedArtifactSelections.filter(
    (entry) =>
      entry.currentBundleId === args.previousBundleId &&
      entry.targetBundleId === args.bundleId,
  );
  if (observed.length === 0) {
    throw createEndpointError("Bundle artifact request was not observed", {
      expected: {
        currentBundleId: args.previousBundleId,
        targetBundleId: args.bundleId,
      },
      observed: [...capturedArtifactSelections],
    });
  }
  const selection = classifyArtifactSelectionHistory(observed);
  if (selection !== "manifest-v1") {
    throw createEndpointError("Unexpected Bundle artifact selection", {
      expected: "consistent manifest-v1",
      observed,
    });
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    throwIfAborted(args.signal);
    const state = await readManifestDiffState(args);
    if (state.ok) {
      logE2eFixture("manifest diff applied without bsdiff patch", {
        bundleId: args.bundleId,
        evidence: "bundle-store-without-archive-or-bsdiff-log",
        platform: fixtureSession.platform,
        previousBundleId: args.previousBundleId,
      });
      return {};
    }

    await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal);
  }

  const state = await readManifestDiffState(args);
  throw createEndpointError(
    "Timed out waiting for manifest diff install evidence.",
    {
      archiveInstalled: state.archiveInstalled,
      archiveFallbackApplied: state.archiveFallbackApplied,
      assetFile: state.assetFile,
      assetPath: state.assetPath,
      bsdiffLogMatched: state.bsdiffApplied,
      bundleFile: state.bundleFile,
      bundleId: args.bundleId,
      diagnostics: state.diagnostics,
      expectedHash: state.expectedHash,
      manifest: state.manifest,
      metadataState: state.metadataState,
      nativeLogsTail: state.nativeLogs.split("\n").slice(-30),
      platform: fixtureSession.platform,
      previousBundleId: args.previousBundleId,
      trackedBundleRecord: state.record,
    },
  );
}

function readFirstOtaReuseEvidence(bundleId: string) {
  const index = isLynxE2eApp()
    ? null
    : fixtureSession.platform === "ios"
      ? readOptionalJsonSnapshot(
          path.join(ensureStorePath(), "builtin-index-v1.json"),
        )
      : readAndroidStoreSnapshot(
          "builtin-index-v1.json",
          "builtin-index-v1.json",
        );
  const locators = index?.value?.locators as
    | Record<string, unknown>
    | undefined;
  const artifact = capturedArtifactSelections.findLast(
    (entry) => entry.targetBundleId === bundleId,
  );
  const assets = artifact?.assets ?? [];
  const archive = getRemoteTransfer(artifact?.archiveUrl ?? null);
  // App-local paths stay identical when E2E shards share a symlinked node_modules.
  const imageSuffix = isLynxE2eApp() ? "assets/probe.png" : "builtin_reuse.png";
  const fontSuffix = isLynxE2eApp() ? "assets/probe.ttf" : "builtin_reuse.ttf";
  const builtin = isLynxE2eApp()
    ? readBundleAssetsStoredEvidence({
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        assetPaths: assets.map(({ path }) => path),
      })
    : null;
  const wasReused = (asset: (typeof assets)[number]) =>
    builtin
      ? builtin.assets.some(
          (entry) =>
            entry.assetPath === asset.path &&
            entry.ok &&
            entry.assetFile.fileHash === asset.fileHash,
        )
      : typeof locators?.[asset.path] === "string";
  // A font fixture is required too, so an empty resolver cannot satisfy this assertion.
  const required = assets.filter(
    ({ path }) => path.endsWith(imageSuffix) || path.endsWith(fontSuffix),
  );
  const reused = assets.filter(wasReused);
  const evidence = assets.map((asset) => {
    const { fileUrl, path: assetPath } = asset;
    const proxyPath = new URL(fileUrl).pathname;
    const transfer = remoteAssetTransfers.get(proxyPath) ?? {
      requests: 0,
      bytes: 0,
    };
    return {
      assetPath,
      reused: wasReused(asset),
      observed: proxyPath.startsWith("/e2e/proxy-url/"),
      ...transfer,
    };
  });
  const finalFiles = readBundleAssetsStoredEvidence({
    bundleId,
    assetPaths: assets.map(({ path }) => path),
  });
  return {
    archive,
    bundleId,
    platform: fixtureSession.platform,
    required: required.map(({ path }) => path),
    evidence,
    builtin,
    finalFiles,
    ok:
      (builtin
        ? builtin.manifest.exists && builtin.manifest.readError === null
        : index?.exists && index.readError === null) &&
      archive.requests === 0 &&
      archive.bytes === 0 &&
      finalFiles.ok &&
      required.some(({ path }) => path.endsWith(imageSuffix)) &&
      required.some(({ path }) => path.endsWith(fontSuffix)) &&
      required.every(({ path }) =>
        reused.some((asset) => asset.path === path),
      ) &&
      evidence.every(
        (asset) =>
          asset.observed &&
          (asset.reused
            ? asset.requests === 0 && asset.bytes === 0
            : asset.requests > 0 && asset.bytes > 0),
      ),
  };
}

async function assertFirstOtaUsesBuiltInManifest(args: { bundleId: string }) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = readFirstOtaManifestState(args.bundleId);
    if (
      state.metadataState.stagingBundleId === args.bundleId &&
      state.metadataState.stagingSelection?.bundleId === args.bundleId &&
      hasManifestBackedBundleEvidence(state)
    ) {
      const reuse = readFirstOtaReuseEvidence(args.bundleId);
      if (!reuse.ok) {
        throw createEndpointError(
          "First OTA did not reuse byte-identical packaged image/font files without downloads",
          reuse,
        );
      }
      fs.writeFileSync(
        path.join(
          fixtureSession.resultsDir,
          `builtin-reuse-${args.bundleId}.json`,
        ),
        JSON.stringify(reuse, null, 2),
      );
      logE2eFixture("first OTA used built-in manifest", {
        assetPath: state.assetPath,
        bundleId: args.bundleId,
        bundleFilePath: state.bundleFile.path,
        evidence: "manifest-and-bundle-store",
        metadataPath: state.diagnostics.metadata.path,
        platform: fixtureSession.platform,
      });
      return {};
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const state = readFirstOtaManifestState(args.bundleId);
  throw createEndpointError(
    "Timed out waiting for first OTA built-in manifest evidence.",
    {
      assetFile: state.assetFile,
      assetPath: state.assetPath,
      bundleId: args.bundleId,
      expectedHash: state.expectedHash,
      manifest: state.manifest,
      observedState: {
        bundleFile: state.bundleFile,
        metadata: state.diagnostics.metadata,
        metadataState: state.metadataState,
      },
      platform: fixtureSession.platform,
    },
  );
}

function writeLynxSnapshotFile(
  fileName: "metadata.json" | "crashed-history.json" | "launch-report.json",
  destination: string,
) {
  const snapshot = readLynxSynthesizedSnapshot(fileName);
  if (!snapshot.exists || !snapshot.value) {
    return false;
  }
  fs.writeFileSync(destination, `${JSON.stringify(snapshot.value, null, 2)}\n`);
  return true;
}

async function captureState(prefix: string) {
  if (isLynxE2eApp()) {
    writeLynxSnapshotFile(
      "metadata.json",
      path.join(fixtureSession.resultsDir, `${prefix}-metadata.json`),
    );
    if (
      !writeLynxSnapshotFile(
        "launch-report.json",
        path.join(fixtureSession.resultsDir, `${prefix}-launch-report.json`),
      )
    ) {
      // Optional for the first capture before recovery.
    }
    if (
      !writeLynxSnapshotFile(
        "crashed-history.json",
        path.join(fixtureSession.resultsDir, `${prefix}-crashed-history.json`),
      ) &&
      prefix === "stable"
    ) {
      await fsPromises.writeFile(
        path.join(fixtureSession.resultsDir, `${prefix}-crashed-history.json`),
        JSON.stringify(EMPTY_CRASH_HISTORY, null, 2),
      );
    }
    return {};
  }
  const storePath = ensureStorePath();

  if (fixtureSession.platform === "ios") {
    const metadataPath = path.join(storePath, "metadata.json");
    await waitForFile(metadataPath);
    await fsPromises.copyFile(
      metadataPath,
      path.join(fixtureSession.resultsDir, `${prefix}-metadata.json`),
    );

    const launchReportPath = path.join(storePath, "launch-report.json");
    if (fs.existsSync(launchReportPath)) {
      await fsPromises.copyFile(
        launchReportPath,
        path.join(fixtureSession.resultsDir, `${prefix}-launch-report.json`),
      );
    }

    const crashHistoryPath = path.join(storePath, "crashed-history.json");
    if (fs.existsSync(crashHistoryPath)) {
      await fsPromises.copyFile(
        crashHistoryPath,
        path.join(fixtureSession.resultsDir, `${prefix}-crashed-history.json`),
      );
    } else if (prefix === "stable") {
      await fsPromises.writeFile(
        path.join(fixtureSession.resultsDir, `${prefix}-crashed-history.json`),
        JSON.stringify(EMPTY_CRASH_HISTORY, null, 2),
      );
    }

    return {};
  }

  copyAndroidFile(
    `${storePath}/metadata.json`,
    path.join(fixtureSession.resultsDir, `${prefix}-metadata.json`),
  );

  if (
    !copyAndroidFileIfExists(
      `${storePath}/crashed-history.json`,
      path.join(fixtureSession.resultsDir, `${prefix}-crashed-history.json`),
    ) &&
    prefix === "stable"
  ) {
    await fsPromises.writeFile(
      path.join(fixtureSession.resultsDir, `${prefix}-crashed-history.json`),
      JSON.stringify(EMPTY_CRASH_HISTORY, null, 2),
    );
  }

  copyAndroidFileIfExists(
    `${storePath}/launch-report.json`,
    path.join(fixtureSession.resultsDir, `${prefix}-launch-report.json`),
  );

  return {};
}

async function resetRemoteBundles() {
  remoteAssetProxyTargets.clear();
  handleConfigureProxy({
    artifactDelayMs: 0,
    catalogDelayMs: 0,
    catalogMode: "live",
    replayGeneration: null,
    reset: true,
  });
  await clearProviderReleasesAfterReadiness();

  logE2eFixture("remote Releases reset on demand", {
    platform: fixtureSession.platform,
  });

  return {};
}

async function resetLocalAppState() {
  resetE2eScreenState();
  resetPendingE2eAction();
  fixtureSession.observedInsightsEvents = [];
  if (fixtureSession.platform === "ios") {
    await clearIosLocalBundleState();
  } else {
    clearAndroidLocalAppState();
  }
  await seedMissingE2ECohort();

  logE2eFixture("local app state reset on demand", {
    platform: fixtureSession.platform,
  });

  return {};
}

async function assertBundlePatchBases(args: {
  absentBaseBundleIds?: string[];
  bundleId: string;
  expectedBaseBundleIds?: string[];
}) {
  const bundle = await fetchProviderBundleById(args.bundleId);
  const observedBaseBundleIds = getBundlePatchBaseBundleIds(bundle);
  const expectedBaseBundleIds = args.expectedBaseBundleIds ?? [];
  const absentBaseBundleIds = args.absentBaseBundleIds ?? [];

  if (
    expectedBaseBundleIds.length > 0 &&
    observedBaseBundleIds.length !== expectedBaseBundleIds.length
  ) {
    throw createEndpointError(
      "Observed patch base bundle count did not match",
      {
        bundleId: args.bundleId,
        expectedBaseBundleIds,
        observedBaseBundleIds,
        platform: fixtureSession.platform,
      },
    );
  }

  if (
    expectedBaseBundleIds.some(
      (bundleId, index) => observedBaseBundleIds[index] !== bundleId,
    )
  ) {
    throw createEndpointError(
      "Observed patch base bundle order did not match",
      {
        bundleId: args.bundleId,
        expectedBaseBundleIds,
        observedBaseBundleIds,
        platform: fixtureSession.platform,
      },
    );
  }

  const unexpectedBaseBundleIds = absentBaseBundleIds.filter((bundleId) =>
    observedBaseBundleIds.includes(bundleId),
  );

  if (unexpectedBaseBundleIds.length > 0) {
    throw createEndpointError(
      "Observed unexpected patch base bundle ids on target bundle",
      {
        absentBaseBundleIds,
        bundleId: args.bundleId,
        observedBaseBundleIds,
        platform: fixtureSession.platform,
        unexpectedBaseBundleIds,
      },
    );
  }

  logE2eFixture("bundle patch bases verified", {
    bundleId: args.bundleId,
    observedBaseBundleIds,
    platform: fixtureSession.platform,
  });

  return {
    observedBaseBundleIds,
  };
}

async function assertMetadataActive(bundleId: string) {
  const metadata = isLynxE2eApp()
    ? (() => {
        const snapshot = readLynxSynthesizedSnapshot("metadata.json");
        if (!snapshot.value) {
          throw new Error("Lynx journal metadata is missing");
        }
        return snapshot.value;
      })()
    : fixtureSession.platform === "ios"
      ? readJson(path.join(ensureStorePath(), "metadata.json"))
      : (() => {
          const probePath = path.join(
            fixtureSession.resultsDir,
            "metadata-assert.json",
          );
          copyAndroidFile(`${ensureStorePath()}/metadata.json`, probePath);
          return readJson(probePath);
        })();

  const releaseId = fixtureSession.deployedBundles.findLast(
    (record) => record.bundleId === bundleId,
  )?.releaseId;
  assertMetadataState(metadata, bundleId, releaseId);
  return {};
}

async function assertMetadataResetState() {
  const attempts = 120;

  for (let index = 0; index < attempts; index += 1) {
    const diagnostics =
      fixtureSession.platform === "ios"
        ? readIosWaitForMetadataDiagnostics()
        : readAndroidWaitForMetadataDiagnostics();

    if (!diagnostics.metadata.exists) {
      return {};
    }

    if (diagnostics.metadata.value) {
      try {
        assertMetadataReset(diagnostics.metadata.value);
        return {};
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
      }
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const diagnostics =
    fixtureSession.platform === "ios"
      ? readIosWaitForMetadataDiagnostics()
      : readAndroidWaitForMetadataDiagnostics();
  throw createWaitForMetadataResetTimeoutError({
    attempts,
    ...diagnostics,
  });
}

async function assertLaunchReportState({
  fromBundleId,
  fromReleaseId,
  optional,
  status,
  toBundleId,
  toReleaseId,
}: LaunchReportAssertion) {
  if (isLynxE2eApp()) {
    const launchReportPath = path.join(
      fixtureSession.resultsDir,
      "launch-report-assert.json",
    );
    // Native confirmation commits before the app can deliver its reply over
    // HTTP. Await that observation instead of inferring a report from history.
    let observed = writeLynxSnapshotFile(
      "launch-report.json",
      launchReportPath,
    );
    for (
      let attempt = 0;
      !observed && !optional && attempt < 40;
      attempt += 1
    ) {
      await sleep(E2E_POLL_INTERVAL_MS);
      observed = writeLynxSnapshotFile("launch-report.json", launchReportPath);
    }
    if (!observed) {
      if (optional) return {};
      throw new Error("Native notifyAppReady report was not observed");
    }
    assertLaunchReport(launchReportPath, {
      fromBundleId,
      fromReleaseId,
      status,
      toBundleId,
      toReleaseId,
    });
    return {};
  }
  let launchReportPath =
    fixtureSession.platform === "ios"
      ? path.join(ensureStorePath(), "launch-report.json")
      : path.join(fixtureSession.resultsDir, "launch-report-assert.json");

  if (fixtureSession.platform === "android") {
    if (
      !copyAndroidFileIfExists(
        `${ensureStorePath()}/launch-report.json`,
        launchReportPath,
      )
    ) {
      if (optional) {
        return {};
      }
      const recoveryLaunchReportPath = androidRecoveryLaunchReportPath({
        crashedBundleId: fromBundleId,
        stableBundleId: toBundleId,
      });
      if (!fs.existsSync(recoveryLaunchReportPath)) {
        throw new Error("launch-report.json is missing");
      }
      launchReportPath = recoveryLaunchReportPath;
    }
  } else if (!fs.existsSync(launchReportPath)) {
    if (optional) {
      return {};
    }
    throw new Error("launch-report.json is missing");
  }

  assertLaunchReport(launchReportPath, {
    fromBundleId,
    fromReleaseId,
    status,
    toBundleId,
    toReleaseId,
  });
  return {};
}

async function assertCrashHistory(bundleId: string) {
  if (isLynxE2eApp()) {
    const crashHistoryPath = path.join(
      fixtureSession.resultsDir,
      "crash-history-assert.json",
    );
    if (!writeLynxSnapshotFile("crashed-history.json", crashHistoryPath)) {
      throw new Error("Lynx crash history is missing");
    }
    assertCrashHistoryContains(crashHistoryPath, bundleId);
    return {};
  }
  const crashHistoryPath =
    fixtureSession.platform === "ios"
      ? path.join(ensureStorePath(), "crashed-history.json")
      : path.join(fixtureSession.resultsDir, "crash-history-assert.json");

  if (fixtureSession.platform === "android") {
    copyAndroidFile(
      `${ensureStorePath()}/crashed-history.json`,
      crashHistoryPath,
    );
  }

  assertCrashHistoryContains(crashHistoryPath, bundleId);
  return {};
}

async function writeSummary({
  scenario,
  status,
}: {
  scenario: string;
  status: string;
}) {
  await fsPromises.writeFile(
    path.join(fixtureSession.resultsDir, "summary.json"),
    JSON.stringify(
      {
        binaryType: "Release",
        builtInBundleId: fixtureSession.builtInBundleId,
        deployedBundles: fixtureSession.deployedBundles,
        platform: fixtureSession.platform,
        scenario,
        status,
      },
      null,
      2,
    ),
  );

  return {};
}

async function cleanup() {
  remoteAssetProxyTargets.clear();
  if (!fixtureSession.appBackupPath) {
    return {};
  }

  if (fixtureSession.appBackupPath) {
    await restoreFile(
      fixtureSession.appBackupPath,
      fixtureSession.appSourceFile,
    );
  }
  if (fixtureSession.configBackupPath) {
    await restoreFile(
      fixtureSession.configBackupPath,
      fixtureSession.configSourceFile,
    );
  }
  if (fixtureSession.envBackupPath) {
    await restoreFile(
      fixtureSession.envBackupPath,
      fixtureSession.envSourceFile,
    );
  }
  await restoreFile(
    fixtureSession.sizeAwareLargeAssetBackupPath,
    fixtureSession.sizeAwareLargeAssetPath,
  );
  await restoreGeneratedDeployFixtures();

  fixtureSession.appBackupPath = null;
  fixtureSession.configBackupPath = null;
  fixtureSession.envBackupPath = null;
  fixtureSession.multiAssetBackupPaths = {};
  fixtureSession.sizeAwareLargeAssetBackupCaptured = false;
  fixtureSession.sizeAwareLargeAssetBackupPath = null;
  return {};
}

function createJob(task: (context: JobExecutionContext) => Promise<JobResult>) {
  return jobs.start(task);
}

export function startBootstrapJob(input: { deviceId?: string } = {}) {
  if (input.deviceId && input.deviceId !== deviceId) {
    throw new Error("Bootstrap device must match the configured target");
  }
  if (bootstrapJobId) {
    const job = jobs.get(bootstrapJobId);
    if (job?.status === "running") {
      return bootstrapJobId;
    }
  }

  bootstrapJobId = createJob(() => bootstrap());
  return bootstrapJobId;
}

export function startDeployBundleJob(request: DeployBundleRequest) {
  return createJob((context) => deployFixtureBundle(request, context));
}

export function startCreateBundleDiffJob(input: {
  baseBundleId: string;
  bundleId: string;
}) {
  return createJob(() => createFixtureBundleDiff(input));
}

export function startPatchReleaseJob(request: PatchReleaseRequest) {
  return createJob((context) => updateFixtureRelease(request, context));
}

export function startCreateRepublishedReleaseJob(input: {
  sourceReleaseId: string;
  bundleId: string;
}) {
  return createJob(() => createFixtureRepublishedRelease(input));
}

export function startSeedCrashedBundleFrontierJob(input: {
  count: number;
  sourceReleaseId: string;
}) {
  return createJob(() => seedCrashedBundleFrontier(input));
}

export function startResetRemoteBundlesJob() {
  return createJob(() => resetRemoteBundles());
}

export function startWaitForMetadataJob(
  bundleId: string,
  verificationPending: boolean,
  options: WaitForMetadataOptions = {},
) {
  return createJob((context) =>
    waitForMetadata(bundleId, verificationPending, {
      ...options,
      signal: context.signal,
    }),
  );
}

export function startWaitForAndroidRestartJob(
  bundleId: string,
  releaseId: string,
  runtimeScenarioMarker?: string,
) {
  return createJob((context) =>
    waitForAndroidRestart(
      bundleId,
      releaseId,
      runtimeScenarioMarker,
      context.signal,
    ),
  );
}

export function getJob(jobId: string) {
  return jobs.get(jobId) ?? null;
}

export function cancelJob(jobId: string) {
  const job = jobs.cancel(jobId);
  if (job?.status === "running") {
    logE2eFixture("control job cancel requested", { jobId });
  }
  return job;
}

export async function handleCaptureBuiltInBundleId() {
  return captureBuiltInBundleId();
}

export async function handleComputeRolloutSample(releaseId: string) {
  return computeRolloutSample(releaseId);
}

export async function handleWaitForMetadata(
  bundleId: string,
  verificationPending: boolean,
  options: WaitForMetadataOptions = {},
) {
  return waitForMetadata(bundleId, verificationPending, options);
}

export async function handleAssertBsdiffPatchApplied(args: {
  assetPath: string;
  baseBundleId: string;
  bundleId?: string;
}) {
  return assertBsdiffPatchApplied(args);
}

export async function handleAssertFirstOtaUsesBuiltInManifest(
  bundleId: string,
) {
  return assertFirstOtaUsesBuiltInManifest({ bundleId });
}

export async function handleCaptureState(prefix: string) {
  return captureState(prefix);
}

export async function handleResetRemoteBundles() {
  return resetRemoteBundles();
}

export async function handleResetLocalAppState() {
  return resetLocalAppState();
}

export async function handleAssertBundlePatchBases(args: {
  absentBaseBundleIds?: string[];
  bundleId: string;
  expectedBaseBundleIds?: string[];
}) {
  return assertBundlePatchBases(args);
}

export async function handleAssertManifestDiffApplied(args: {
  allowBsdiff?: boolean;
  bundleId: string;
  previousBundleId: string;
  signal?: AbortSignal;
}) {
  return assertManifestDiffApplied(args);
}

export async function handleAssertBundleAssetsStored(args: {
  assetPaths: string[];
  bundleId: string;
}) {
  return assertBundleAssetsStored(args);
}

export async function handleAssertMultipleAssetsReplaced(args: {
  assetPaths: string[];
  bundleId: string;
  previousBundleId: string;
}) {
  return assertMultipleAssetsReplaced(args);
}

export async function handleAssertMetadataActive(bundleId: string) {
  return assertMetadataActive(bundleId);
}

export async function handleAssertMetadataReset() {
  return assertMetadataResetState();
}

export async function handleAssertLaunchReport(
  assertion: LaunchReportAssertion,
) {
  return assertLaunchReportState(assertion);
}

export async function handleAssertCrashHistory(bundleId: string) {
  return assertCrashHistory(bundleId);
}

export async function handleSeedCrashHistory(bundleIds: readonly string[]) {
  return seedDeviceCrashHistory(bundleIds);
}

export function handleSeedLegacyMetadata() {
  return seedLegacyDeviceMetadata();
}

export async function handleWaitForCrashRecovery(
  stableBundleId: string,
  crashedBundleId: string,
  options: { signal?: AbortSignal } = {},
) {
  return waitForCrashRecovery(stableBundleId, crashedBundleId, options);
}

export function handleLynxCrashState() {
  if (!isLynxE2eApp()) throw new Error("Lynx crash state requires a Lynx app");
  const journal = readLynxJournalValue();
  if (!journal) throw new Error("Lynx native state is unavailable");
  return {
    nextBundleId:
      lynxReceipt(journal, fixtureSession.platform, "next")?.bundleId ?? null,
    ...lynxStoredExclusions(journal, fixtureSession.platform),
  };
}

export async function handleAssertStartupInterruption(
  bundleId: string,
  releaseId: string,
) {
  if (!isLynxE2eApp()) return assertCrashHistory(bundleId);
  const journal = readLynxJournalValue();
  if (!journal) throw new Error("Lynx native state is unavailable");
  assertLynxStartupInterruption(
    journal,
    fixtureSession.platform,
    bundleId,
    releaseId,
  );
  return {};
}

export async function handlePrepareAppLaunch(options?: {
  launchGeneration?: unknown;
}) {
  const result = await prepareAppLaunch();
  const launchGeneration =
    typeof options?.launchGeneration === "string" &&
    options.launchGeneration.length > 0
      ? options.launchGeneration
      : null;
  setE2eScreenStateLaunchGeneration(launchGeneration);
  return result;
}

export async function handleTerminateApp() {
  await terminateApp({
    platform: fixtureSession.platform,
    deviceId: deviceId as string,
    appId: fixtureSession.appId,
  });
  return {};
}

// Launch natively without waiting for the deliberately blocked JS thread.
export async function handleLaunchUninstrumentedApp() {
  await prepareAppLaunch();
  if (fixtureSession.platform === "ios") {
    captureCommand("xcrun", [
      "simctl",
      "launch",
      deviceId as string,
      fixtureSession.appId,
    ]);
  } else {
    launchAndroidApp({ explicitActivity: true });
  }
  return {};
}

export async function handleLaunchStartupHang(bundleId: string) {
  if (isLynxE2eApp()) {
    await handleLaunchUninstrumentedApp();
    const deadline = Date.now() + 30_000;
    while (
      readE2eScreenStateSnapshot().startupHangBundleId !== bundleId &&
      Date.now() < deadline
    ) {
      await sleep(E2E_POLL_INTERVAL_MS);
    }
    if (readE2eScreenStateSnapshot().startupHangBundleId !== bundleId) {
      throw new Error(`Startup hang was not reached for ${bundleId}`);
    }
    const journal = readLynxJournalValue();
    if (!journal) throw new Error("Lynx native state is unavailable");
    assertLynxStartupHang(journal, fixtureSession.platform, bundleId);
    await captureState("startup-hang");
    return {};
  }
  const marker = `HotUpdaterE2EStartupHang:${bundleId}`;
  const ios = fixtureSession.platform === "ios";
  const logs = spawn(
    ios ? "xcrun" : "adb",
    ios
      ? [
          "simctl",
          "spawn",
          deviceId as string,
          "log",
          "stream",
          "--level",
          "debug",
          "--style",
          "compact",
          "--predicate",
          'eventMessage CONTAINS "HotUpdaterE2EStartupHang:"',
        ]
      : [
          "-s",
          deviceId as string,
          "logcat",
          "-v",
          "brief",
          "ReactNativeJS:I",
          "*:S",
        ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let logError: Error | undefined;
  logs.on("error", (error) => {
    logError = error;
  });
  logs.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  logs.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    await handleLaunchUninstrumentedApp();
    const deadline = Date.now() + 30_000;
    while (!output.includes(marker) && Date.now() < deadline && !logError) {
      await sleep(E2E_POLL_INTERVAL_MS);
    }
    if (logError) throw logError;
    if (!output.includes(marker)) {
      throw new Error(`Startup hang was not reached for ${bundleId}`);
    }
    const diagnostics = ios
      ? readIosRecoveryDiagnostics()
      : readAndroidRecoveryDiagnostics({
          metadata: "startup-hang-metadata.json",
          launchReport: "startup-hang-launch-report.json",
          crashMarker: "startup-hang-crash-marker.json",
          crashHistory: "startup-hang-crashed-history.json",
        });
    const metadata = getMetadataState(diagnostics.metadata.value);
    if (
      metadata.stagingBundleId !== bundleId ||
      metadata.verificationPending !== true ||
      diagnostics.crashMarker.exists ||
      diagnostics.crashHistory.exists ||
      diagnostics.launchReport.exists
    ) {
      throw createEndpointError(
        "Expected an unverified startup hang without crash recovery",
        diagnostics,
      );
    }
    await captureState("startup-hang");
    return {};
  } finally {
    logs.kill();
    await fsPromises.writeFile(
      path.join(fixtureSession.resultsDir, "startup-hang.log"),
      output,
    );
  }
}

export async function handleWriteSummary(args: {
  scenario: string;
  status: string;
}) {
  return writeSummary(args);
}

export async function handleCleanup() {
  return cleanup();
}

export async function handleVerifyConsoleInsights(args: { sinceMs: number }) {
  return verifyConfiguredConsoleInsights(args);
}
