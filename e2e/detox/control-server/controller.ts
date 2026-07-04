import { spawn, spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";

import {
  getBundlePatch,
  getBundlePatches,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
} from "../../../packages/core/src/bundleArtifacts.ts";
import { getRolledOutNumericCohorts } from "../../../packages/core/src/rollout.ts";
import type { Bundle } from "../../../packages/core/src/types.ts";
import type { DatabasePlugin } from "../../../plugins/plugin-core/src/types/index.ts";
import {
  createCrashRecoveryArtifactNames,
  waitForCrashRecoveryState,
} from "./crash-recovery-wait.ts";
import type { CrashRecoveryArtifactNames } from "./crash-recovery-wait.ts";
import {
  readE2eScreenStateSnapshot,
  resetE2eScreenState,
} from "./screen-state.ts";
import { resolveUpdateCheckRequestBundleId } from "./update-check-request-bundle-id.ts";
import { shouldProbeUpdateCheckVisibility } from "./update-check-visibility.ts";

type Platform = "ios" | "android";
type BundleProfile = "archive300mb" | "default" | "multiAssetReplacement";

type JobResult = Record<string, unknown>;

type JobExecutionContext = {
  signal: AbortSignal;
};

type JobState = {
  error?: string;
  result?: JobResult;
  status: "cancelled" | "failed" | "running" | "succeeded";
};

type DeployMode = "crash" | "reset";

type DeployedBundleRecord = {
  archiveSizeBytes: number | null;
  bundleId: string;
  bundleProfile: BundleProfile;
  channel: string;
  diffBaseBundleId: string | null;
  diffPatchAssetPath: string | null;
  enabled: boolean;
  marker: string;
  mode: DeployMode;
  patchBaseBundleIds: string[];
  rolloutCohortCount: number | null;
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
  largeArchiveAssetBackupPath: string | null;
  largeArchiveAssetPath: string;
  multiAssetBackupPaths: Record<string, string | null>;
  platform: Platform;
  resultsDir: string;
  storePath: string | null;
};

type DeployBundleRequest = {
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
  targetAppVersion: string;
  targetCohorts?: string[];
};

type PatchBundleRequest = {
  bundleId: string;
  enabled?: boolean;
  rolloutCohortCount?: number | null;
  shouldForceUpdate?: boolean;
  targetCohorts?: string[] | null;
};

type BundleListEntry = {
  channel?: string;
  enabled?: boolean;
  id: string;
  platform?: Platform;
  rolloutCohortCount?: number | null;
  shouldForceUpdate?: boolean;
  targetCohorts?: string[] | null;
};

type BundleListPage = {
  data: BundleListEntry[];
  pagination: {
    limit: number | null;
    offset: number | null;
    total: number | null;
  };
};

const REMOTE_RESET_DATABASE_CONCURRENCY = 8;

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  const iterator = items.entries();
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const next = iterator.next();
        if (next.done) {
          break;
        }

        const [index, item] = next.value;
        results[index] = await mapper(item, index);
      }
    }),
  );

  return results;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await mapWithConcurrency(items, concurrency, mapper);
}

type LaunchReportAssertion = {
  crashedBundleId?: string;
  optional: boolean;
  stableBundleId?: string;
  status: string;
};

type JsonSnapshot = {
  exists: boolean;
  path: string;
  readError: string | null;
  value: Record<string, unknown> | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../../..");
const HOT_UPDATER_CLI_PATH = path.join(
  REPO_DIR,
  "packages/hot-updater/dist/index.mjs",
);
const COMMAND_STDIO_DRAIN_GRACE_MS = 500;
const EXAMPLE_DIR = path.join(REPO_DIR, "examples/v0.85.0");
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
  "examples/v0.85.0/src/e2eApp",
  "examples/v0.85.0/src/e2eRuntimeConfig.ts",
  "examples/v0.85.0/src/test",
  "plugins/bare",
  "packages/core",
  "packages/hot-updater/src/utils/bundleManifest.ts",
  "packages/react-native",
];
const E2E_MIN_BUNDLE_ID = "00000000-0000-7000-8000-000000000000";
const BUILT_IN_MIN_BUNDLE_ID_SUFFIX = "7000-8000-000000000000";
const SIGNING_PRIVATE_KEY_RELATIVE_PATH = "keys/private-key.pem";
const EMPTY_CRASH_HISTORY = {
  bundles: [],
  maxHistorySize: 10,
};
const CRASH_GUARD_START = "/* E2E_CRASH_GUARD_START */";
const CRASH_GUARD_END = "/* E2E_CRASH_GUARD_END */";
const CRASH_GUARD_PATTERN =
  /\/\* E2E_CRASH_GUARD_START \*\/[\s\S]*?\/\* E2E_CRASH_GUARD_END \*\//;
const DEPLOY_ASSET_GUARD_START = "/* E2E_DEPLOY_ASSET_GUARD_START */";
const DEPLOY_ASSET_GUARD_END = "/* E2E_DEPLOY_ASSET_GUARD_END */";
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
const E2E_REMOTE_RESET_LOGICAL_CHANNELS = ["production", "beta"] as const;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const LARGE_ARCHIVE_ASSET_RELATIVE_PATH =
  "src/test/_fixture-archive-300mb-random.bmp";
const LARGE_ARCHIVE_ASSET_REQUIRE_PATH =
  "../test/_fixture-archive-300mb-random.bmp";
const LARGE_ARCHIVE_BMP_WIDTH = 4096;
const LARGE_ARCHIVE_BMP_HEIGHT = 25600;
const LARGE_ARCHIVE_BMP_HEADER_SIZE = 54;
const LARGE_ARCHIVE_BMP_ROW_SIZE = LARGE_ARCHIVE_BMP_WIDTH * 3;
const LARGE_ARCHIVE_ASSET_SIZE_BYTES =
  LARGE_ARCHIVE_BMP_HEADER_SIZE +
  LARGE_ARCHIVE_BMP_ROW_SIZE * LARGE_ARCHIVE_BMP_HEIGHT;
const LARGE_ARCHIVE_MIN_EXPECTED_SIZE_BYTES = 280 * 1024 * 1024;
const MULTI_ASSET_FIXTURES = [
  {
    androidManifestPath: "raw/src_test__fixturemultiasseta.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-a.bmp",
    relativePath: "src/test/_fixture-multi-asset-a.bmp",
    requirePath: "../test/_fixture-multi-asset-a.bmp",
  },
  {
    androidManifestPath: "raw/src_test__fixturemultiassetb.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-b.bmp",
    relativePath: "src/test/_fixture-multi-asset-b.bmp",
    requirePath: "../test/_fixture-multi-asset-b.bmp",
  },
  {
    androidManifestPath: "raw/src_test__fixturemultiassetc.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-c.bmp",
    relativePath: "src/test/_fixture-multi-asset-c.bmp",
    requirePath: "../test/_fixture-multi-asset-c.bmp",
  },
] as const;
const MULTI_ASSET_BMP_WIDTH = 64;
const MULTI_ASSET_BMP_HEIGHT = 64;
const MULTI_ASSET_BMP_HEADER_SIZE = 54;
const MULTI_ASSET_BMP_ROW_SIZE = Math.ceil((MULTI_ASSET_BMP_WIDTH * 3) / 4) * 4;
const MULTI_ASSET_BMP_SIZE_BYTES =
  MULTI_ASSET_BMP_HEADER_SIZE +
  MULTI_ASSET_BMP_ROW_SIZE * MULTI_ASSET_BMP_HEIGHT;
const REMOTE_BUNDLE_DELETE_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_REMOTE_BUNDLE_DELETE_ATTEMPTS || 3,
);
const REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS = Number(
  process.env.HOT_UPDATER_E2E_REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS || 5000,
);
const REMOTE_BUNDLE_CLEAR_VERIFY_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_REMOTE_BUNDLE_CLEAR_VERIFY_ATTEMPTS || 20,
);
const REMOTE_BUNDLE_CLEAR_VERIFY_DELAY_MS = Number(
  process.env.HOT_UPDATER_E2E_REMOTE_BUNDLE_CLEAR_VERIFY_DELAY_MS || 500,
);
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
const DELETE_VERIFY_STILL_EXISTS_PATTERN =
  /Verification failed: .+ still exists\./i;
const E2E_POLL_INTERVAL_MS = Number(
  process.env.HOT_UPDATER_E2E_POLL_INTERVAL_MS || 250,
);
const E2E_ANDROID_LAUNCH_SETTLE_MS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_LAUNCH_SETTLE_MS || 1000,
);
const E2E_ANDROID_FOREGROUND_POLL_MS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_FOREGROUND_POLL_MS || 500,
);
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
const LOG_PREFIX = "[detox-e2e]";

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

function logDetoxFixture(event: string, details?: unknown) {
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
  largeArchiveAssetBackupPath: null,
  largeArchiveAssetPath: path.join(
    EXAMPLE_DIR,
    LARGE_ARCHIVE_ASSET_RELATIVE_PATH,
  ),
  multiAssetBackupPaths: {},
  platform,
  resultsDir,
  storePath: null,
};

const channelNamespace =
  process.env.HOT_UPDATER_E2E_CHANNEL_NAMESPACE?.trim() || null;

function getFixtureChannel(channel: string) {
  return channelNamespace ? `${channelNamespace}-${channel}` : channel;
}

function getFixtureResetChannels() {
  return channelNamespace
    ? E2E_REMOTE_RESET_LOGICAL_CHANNELS.map((channel) =>
        getFixtureChannel(channel),
      )
    : null;
}

const jobs = new Map<string, JobState>();
const jobAbortControllers = new Map<string, AbortController>();
const remoteAssetProxyTargets = new Map<string, string>();
let bootstrapJobId: string | null = null;

function getAbortSignalReason(signal: AbortSignal) {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "cancelled";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error(`Control job cancelled: ${getAbortSignalReason(signal)}`);
  }
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
} satisfies NodeJS.ProcessEnv;

function stripAnsi(value: string) {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

function extractDeployBundleId(output: string) {
  const plainOutput = stripAnsi(output);
  const match = plainOutput.match(
    /Deployment Successful \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i,
  );

  return match?.[1] ?? null;
}

async function readTextIfExists(filePath: string) {
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }

    throw error;
  }
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
    logDetoxFixture("native public key export skipped", {
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

  logDetoxFixture("native public key exported", {
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

function createLargeArchiveBmpHeader() {
  const header = Buffer.alloc(LARGE_ARCHIVE_BMP_HEADER_SIZE);
  const pixelDataSize = LARGE_ARCHIVE_BMP_ROW_SIZE * LARGE_ARCHIVE_BMP_HEIGHT;

  header.write("BM", 0, "ascii");
  header.writeUInt32LE(LARGE_ARCHIVE_ASSET_SIZE_BYTES, 2);
  header.writeUInt32LE(LARGE_ARCHIVE_BMP_HEADER_SIZE, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(LARGE_ARCHIVE_BMP_WIDTH, 18);
  header.writeInt32LE(LARGE_ARCHIVE_BMP_HEIGHT, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(pixelDataSize, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);

  return header;
}

async function writeDeterministicBmpFile(filePath: string) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fsPromises.open(filePath, "w");

  try {
    const header = createLargeArchiveBmpHeader();
    await handle.write(header, 0, header.length);

    let remaining = LARGE_ARCHIVE_BMP_ROW_SIZE * LARGE_ARCHIVE_BMP_HEIGHT;
    let seed = 0x5eed1234;

    while (remaining > 0) {
      const chunkSize = Math.min(1024 * 1024, remaining);
      const chunk = Buffer.allocUnsafe(chunkSize);
      seed = fillDeterministicPseudoRandomChunk(chunk, seed);

      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        offset += bytesWritten;
      }

      remaining -= chunkSize;
    }
  } finally {
    await handle.close();
  }
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

  logDetoxFixture("multi asset fixtures ready", {
    marker,
    paths: MULTI_ASSET_FIXTURES.map((fixture) => fixture.relativePath),
    sizeBytes: MULTI_ASSET_BMP_SIZE_BYTES,
  });
}

async function restoreMultiAssetFixtures() {
  for (const fixture of MULTI_ASSET_FIXTURES) {
    await restoreFile(
      fixtureSession.multiAssetBackupPaths[fixture.relativePath] ?? null,
      path.join(EXAMPLE_DIR, fixture.relativePath),
    );
  }
}

async function ensureLargeArchiveAsset() {
  const existingStats = await fsPromises
    .stat(fixtureSession.largeArchiveAssetPath)
    .catch(() => null);

  if (
    existingStats?.isFile() &&
    existingStats.size === LARGE_ARCHIVE_ASSET_SIZE_BYTES
  ) {
    return;
  }

  if (!fixtureSession.largeArchiveAssetBackupPath) {
    fixtureSession.largeArchiveAssetBackupPath = await backupFile(
      fixtureSession.largeArchiveAssetPath,
    );
  }

  await writeDeterministicBmpFile(fixtureSession.largeArchiveAssetPath);
  logDetoxFixture("large archive asset ready", {
    path: path.relative(REPO_DIR, fixtureSession.largeArchiveAssetPath),
    sizeBytes: LARGE_ARCHIVE_ASSET_SIZE_BYTES,
  });
}

function resolveBundleProfile(value: BundleProfile | undefined): BundleProfile {
  return value ?? "default";
}

async function resolveDeployArchivePath(outputPath: string) {
  const bundleDir = path.join(outputPath, "bundle");
  const entries = await fsPromises.readdir(bundleDir, { withFileTypes: true });
  const archiveEntry = entries.find(
    (entry) => entry.isFile() && entry.name.startsWith("bundle."),
  );

  if (!archiveEntry) {
    throw new Error(`Failed to locate deployed archive in ${bundleDir}`);
  }

  return path.join(bundleDir, archiveEntry.name);
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

  const crashGuardSource =
    mode === "crash"
      ? [
          CRASH_GUARD_START,
          `  const E2E_SAFE_BUNDLE_IDS = new Set(${JSON.stringify(safeBundleIds, null, 2)});`,
          `  const E2E_BUILT_IN_MIN_BUNDLE_ID_SUFFIX = ${JSON.stringify(BUILT_IN_MIN_BUNDLE_ID_SUFFIX)};`,
          "  const E2E_CURRENT_BUNDLE_ID = HotUpdater.getBundleId();",
          "  const E2E_IS_BUILT_IN_BUNDLE =",
          '    typeof E2E_CURRENT_BUNDLE_ID === "string" &&',
          "    E2E_CURRENT_BUNDLE_ID.endsWith(E2E_BUILT_IN_MIN_BUNDLE_ID_SUFFIX);",
          "",
          "  if (!E2E_IS_BUILT_IN_BUNDLE && !E2E_SAFE_BUNDLE_IDS.has(E2E_CURRENT_BUNDLE_ID)) {",
          '    throw new Error("hot-updater e2e crash bundle");',
          "  }",
          `  ${CRASH_GUARD_END}`,
        ].join("\n")
      : `${CRASH_GUARD_START}\n  ${CRASH_GUARD_END}`;
  const deployAssetSource = (() => {
    if (bundleProfile === "archive300mb") {
      return [
        DEPLOY_ASSET_GUARD_START,
        `  void Image.resolveAssetSource(require(${JSON.stringify(LARGE_ARCHIVE_ASSET_REQUIRE_PATH)}));`,
        `  ${DEPLOY_ASSET_GUARD_END}`,
      ].join("\n");
    }

    if (bundleProfile === "multiAssetReplacement") {
      return [
        DEPLOY_ASSET_GUARD_START,
        ...MULTI_ASSET_FIXTURES.map(
          (fixture) =>
            `  void Image.resolveAssetSource(require(${JSON.stringify(fixture.requirePath)}));`,
        ),
        `  ${DEPLOY_ASSET_GUARD_END}`,
      ].join("\n");
    }

    return `${DEPLOY_ASSET_GUARD_START}\n  ${DEPLOY_ASSET_GUARD_END}`;
  })();

  const nextSource = source
    .replace(
      MARKER_PATTERN,
      `export const E2E_SCENARIO_MARKER = ${JSON.stringify(marker)};`,
    )
    .replace(CRASH_GUARD_PATTERN, crashGuardSource)
    .replace(DEPLOY_ASSET_GUARD_PATTERN, deployAssetSource);

  await fsPromises.writeFile(fixtureSession.appSourceFile, nextSource);
  logDetoxFixture("app scenario applied", {
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
}: {
  patchEnabled: boolean;
  patchMaxBaseBundles?: number;
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

  const sourceWithWarmMetroCache = source.replace(
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
    (_match, prefix: string) => `${prefix}${JSON.stringify(deployBaseUrl)}`,
  );

  await fsPromises.writeFile(
    fixtureSession.configSourceFile,
    sourceWithDeployBaseUrl.replace(AUTO_PATCH_CONFIG_PATTERN, autoPatchSource),
  );
  logDetoxFixture("deploy config applied", {
    deployBaseUrl,
    patchEnabled,
    patchMaxBaseBundles: patchMaxBaseBundles ?? null,
    resetMetroCache: false,
    sourceFile: path.relative(REPO_DIR, fixtureSession.configSourceFile),
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

function normalizeBundleListEntries(value: unknown): BundleListEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const bundleId = (entry as { id?: unknown }).id;
    if (typeof bundleId !== "string" || bundleId.length === 0) {
      return [];
    }

    const bundle = entry as Partial<BundleListEntry> & { id: string };

    return [
      {
        channel:
          typeof bundle.channel === "string" ? bundle.channel : undefined,
        enabled:
          typeof bundle.enabled === "boolean" ? bundle.enabled : undefined,
        id: bundle.id,
        platform:
          bundle.platform === "ios" || bundle.platform === "android"
            ? bundle.platform
            : undefined,
        rolloutCohortCount:
          typeof bundle.rolloutCohortCount === "number" ||
          bundle.rolloutCohortCount === null
            ? bundle.rolloutCohortCount
            : undefined,
        shouldForceUpdate:
          typeof bundle.shouldForceUpdate === "boolean"
            ? bundle.shouldForceUpdate
            : undefined,
        targetCohorts: Array.isArray(bundle.targetCohorts)
          ? bundle.targetCohorts.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
      },
    ];
  });
}

function normalizeBundleListResponse(payload: unknown): BundleListPage {
  if (Array.isArray(payload)) {
    return {
      data: normalizeBundleListEntries(payload),
      pagination: {
        limit: null,
        offset: null,
        total: null,
      },
    };
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected bundle list response from hot-updater CLI");
  }

  const response = payload as {
    data?: unknown;
    pagination?: {
      limit?: unknown;
      offset?: unknown;
      total?: unknown;
    };
  };

  return {
    data: normalizeBundleListEntries(response.data),
    pagination: {
      limit:
        typeof response.pagination?.limit === "number"
          ? response.pagination.limit
          : null,
      offset:
        typeof response.pagination?.offset === "number"
          ? response.pagination.offset
          : null,
      total:
        typeof response.pagination?.total === "number"
          ? response.pagination.total
          : null,
    },
  };
}

function parseHotUpdaterCliJson<T>(label: string, output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse hot-updater CLI ${label} JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function runHotUpdaterCliCapture(args: string[]) {
  logDetoxFixture("hot-updater cli request", {
    command: `node ${[HOT_UPDATER_CLI_PATH, ...args].join(" ")}`,
    controlBaseUrl: getControllerReachableAppBaseUrl(),
  });

  const output = captureCommand("node", [HOT_UPDATER_CLI_PATH, ...args], {
    cwd: fixtureSession.exampleDir,
    env: getHotUpdaterControlEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });

  logDetoxFixture("hot-updater cli response", {
    command: args.join(" "),
    stdout: output,
  });

  return output;
}

async function runHotUpdaterCliLogged(args: string[], logName: string) {
  const logPath = path.join(fixtureSession.resultsDir, logName);
  logDetoxFixture("hot-updater cli start", {
    command: `node ${[HOT_UPDATER_CLI_PATH, ...args].join(" ")}`,
    controlBaseUrl: getControllerReachableAppBaseUrl(),
    logPath: path.relative(REPO_DIR, logPath),
  });

  await runLoggedCommand("node", [HOT_UPDATER_CLI_PATH, ...args], {
    cwd: fixtureSession.exampleDir,
    env: getHotUpdaterControlEnv(),
    logPath,
  });

  logDetoxFixture("hot-updater cli done", {
    command: args.join(" "),
  });
}

async function withDatabasePlugin<T>(
  callback: (databasePlugin: DatabasePlugin) => Promise<T>,
): Promise<T> {
  const { loadConfig } =
    (await import("../../../packages/cli-tools/dist/index.mjs")) as {
      loadConfig: (
        options: null,
      ) => Promise<{ database: () => Promise<DatabasePlugin> }>;
    };
  const originalCwd = process.cwd();
  let databasePlugin: DatabasePlugin | null = null;

  try {
    process.chdir(fixtureSession.exampleDir);
    return await withHotUpdaterControlEnv(async () => {
      const config = await loadConfig(null);
      databasePlugin = await config.database();
      return await callback(databasePlugin);
    });
  } finally {
    await databasePlugin?.onUnmount?.();
    process.chdir(originalCwd);
  }
}

async function fetchProviderBundlesPage(args: {
  channel?: string;
  limit: number;
  offset: number;
}) {
  if (args.offset !== 0) {
    throw new Error("hot-updater CLI bundle list does not support offset");
  }

  const cliArgs = [
    "bundle",
    "list",
    "--json",
    "-p",
    fixtureSession.platform,
    "--limit",
    String(args.limit),
  ];
  if (args.channel) {
    cliArgs.push("-c", args.channel);
  }

  const response = parseHotUpdaterCliJson<BundleListPage>(
    "bundle list",
    runHotUpdaterCliCapture(cliArgs),
  );

  const bundles = normalizeBundleListResponse(response);
  logDetoxFixture("hot-updater cli bundle list", {
    channel: args.channel ?? null,
    count: bundles.data.length,
    limit: args.limit,
    platform: fixtureSession.platform,
    total: bundles.pagination.total,
  });

  return bundles;
}

async function isBundleVisible(bundleId: string) {
  const bundles = await fetchProviderBundlesPage({
    limit: 100,
    offset: 0,
  });
  return bundles.data.some((bundle) => bundle.id === bundleId);
}

async function fetchProviderBundleById(bundleId: string) {
  const bundle = parseHotUpdaterCliJson<Bundle>(
    "bundle show",
    runHotUpdaterCliCapture(["bundle", "show", bundleId, "--json"]),
  );

  if (!bundle) {
    throw new Error(`Failed to fetch bundle ${bundleId}: bundle not found`);
  }

  logDetoxFixture("hot-updater cli bundle show", {
    bundleId: bundle.id,
    channel: bundle.channel,
    enabled: bundle.enabled,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
  });

  return bundle;
}

async function fetchEnabledBundlesForRemoteReset(
  limit: number,
  channels: readonly string[] | null = null,
) {
  let bundles: BundleListEntry[];
  try {
    const channelList = channels ?? [undefined];
    const pages: BundleListPage[] = [];
    for (const channel of channelList) {
      pages.push(
        await fetchProviderBundlesPage({
          channel,
          limit,
          offset: 0,
        }),
      );
    }
    bundles = pages.flatMap((page) => page.data);
  } catch (error) {
    throw new Error(
      "Failed to list enabled remote bundles for reset readiness",
      {
        cause: error,
      },
    );
  }

  const enabledBundles = bundles.filter((bundle) => bundle.enabled);
  logDetoxFixture("provider enabled bundle list", {
    channels,
    count: enabledBundles.length,
    limit,
    platform: fixtureSession.platform,
  });

  return enabledBundles;
}

async function patchProviderBundle(bundleId: string, patch: Partial<Bundle>) {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<Bundle>;
  const patchKeys = Object.keys(definedPatch);
  if (patchKeys.length > 0) {
    await withDatabasePlugin(async (databasePlugin) => {
      const bundle = await databasePlugin.bundles.get(undefined, {
        id: bundleId,
      });
      if (!bundle) {
        throw new Error(`No bundle with id ${bundleId}.`);
      }

      await databasePlugin.bundles.update(undefined, {
        id: bundleId,
        data: definedPatch,
      });
      await databasePlugin.commit(undefined, {});

      const refetched = await databasePlugin.bundles.get(undefined, {
        id: bundleId,
      });
      if (!refetched) {
        throw new Error(
          `Verification failed: ${bundleId} is missing after patch.`,
        );
      }
      for (const key of patchKeys) {
        const expected = definedPatch[key as keyof Bundle];
        const observed = refetched[key as keyof Bundle];
        if (
          JSON.stringify(observed ?? null) !== JSON.stringify(expected ?? null)
        ) {
          throw new Error(
            `Verification failed: ${bundleId} ${key} expected ${JSON.stringify(expected)} but observed ${JSON.stringify(observed)}.`,
          );
        }
      }
    });
  }

  logDetoxFixture("hot-updater direct bundle patch", {
    bundleId,
    patch: definedPatch,
  });
}

function readLegacyPatchAssetPath(bundle: Bundle | null | undefined) {
  const patchAssetPath = bundle?.metadata?.hbc_patch_asset_path;
  return typeof patchAssetPath === "string" && patchAssetPath.length > 0
    ? patchAssetPath
    : null;
}

function inferPatchAssetPathFromStorageUri({
  baseBundleId,
  patchStorageUri,
}: {
  baseBundleId: string;
  patchStorageUri: string;
}) {
  let pathname: string;
  try {
    pathname = new URL(patchStorageUri).pathname;
  } catch {
    return null;
  }

  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const patchesIndex = segments.findIndex(
    (segment, index) =>
      segment === "patches" && segments[index + 1] === baseBundleId,
  );
  if (patchesIndex === -1) {
    return null;
  }

  const patchPath = segments.slice(patchesIndex + 2).join("/");
  return patchPath.endsWith(".bsdiff")
    ? patchPath.slice(0, -".bsdiff".length)
    : null;
}

function resolvePatchAssetPath(
  bundle: Bundle | null | undefined,
  baseBundleId: string,
) {
  const patchStorageUri = bundle
    ? (getBundlePatch(bundle, baseBundleId)?.patchStorageUri ??
      getPatchStorageUri(bundle))
    : null;
  if (!patchStorageUri) {
    return readLegacyPatchAssetPath(bundle);
  }

  return (
    readLegacyPatchAssetPath(bundle) ??
    inferPatchAssetPathFromStorageUri({ baseBundleId, patchStorageUri })
  );
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
    const patchBaseBundleId =
      matchingPatch?.baseBundleId ?? getPatchBaseBundleId(bundle);
    const patchBaseFileHash =
      matchingPatch?.baseFileHash ?? getPatchBaseFileHash(bundle);
    const patchFileHash =
      matchingPatch?.patchFileHash ?? getPatchFileHash(bundle);
    const patchStorageUri =
      matchingPatch?.patchStorageUri ?? getPatchStorageUri(bundle);

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
      logDetoxFixture("auto patch metadata resolved", {
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

async function deleteProviderBundle(bundleId: string) {
  let lastError: unknown = null;

  for (
    let attempt = 1;
    attempt <= REMOTE_BUNDLE_DELETE_ATTEMPTS;
    attempt += 1
  ) {
    const logName =
      attempt === 1
        ? `bundle-delete-${bundleId}.log`
        : `bundle-delete-${bundleId}.attempt-${attempt}.log`;

    try {
      await runHotUpdaterCliLogged(
        ["bundle", "delete", bundleId, "-y"],
        logName,
      );
      return;
    } catch (error) {
      lastError = error;
      const logContents = await readTextIfExists(
        path.join(fixtureSession.resultsDir, logName),
      );
      if (!DELETE_VERIFY_STILL_EXISTS_PATTERN.test(logContents)) {
        throw error;
      }

      const stillVisible = await isBundleVisible(bundleId);
      if (!stillVisible) {
        logDetoxFixture("bundle delete verified after CLI retryable failure", {
          attempt,
          bundleId,
          platform: fixtureSession.platform,
        });
        return;
      }

      if (attempt < REMOTE_BUNDLE_DELETE_ATTEMPTS) {
        logDetoxFixture("bundle delete verification still pending", {
          attempt,
          bundleId,
          platform: fixtureSession.platform,
          retryDelayMs: REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS,
        });
        await sleep(REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function fetchRemainingRemoteBundle(
  mode: "delete" | "disable",
  resetChannels: readonly string[] | null,
) {
  if (mode === "delete") {
    return (
      await Promise.all(
        (resetChannels ?? [undefined]).map((channel) =>
          fetchProviderBundlesPage({
            channel,
            limit: 1,
            offset: 0,
          }),
        ),
      )
    ).flatMap((page) => page.data)[0];
  }

  return (await fetchEnabledBundlesForRemoteReset(1, resetChannels))[0];
}

async function clearProviderBundles({
  mode = "delete",
}: { mode?: "delete" | "disable" } = {}) {
  const clearedBundleIds: string[] = [];
  const clearedIds = new Set<string>();
  const resetChannels = getFixtureResetChannels();

  while (true) {
    const nextBatch =
      mode === "disable"
        ? (await fetchEnabledBundlesForRemoteReset(100, resetChannels)).filter(
            (bundle) => !clearedIds.has(bundle.id),
          )
        : (
            await Promise.all(
              (resetChannels ?? [undefined]).map((channel) =>
                fetchProviderBundlesPage({
                  channel,
                  limit: 100,
                  offset: 0,
                }),
              ),
            )
          )
            .flatMap((page) => page.data)
            .filter((bundle) => !clearedIds.has(bundle.id));

    if (nextBatch.length === 0) {
      break;
    }

    if (mode === "disable") {
      await withDatabasePlugin(async (databasePlugin) => {
        await forEachWithConcurrency(
          nextBatch,
          REMOTE_RESET_DATABASE_CONCURRENCY,
          (bundle) =>
            databasePlugin.bundles.update(undefined, {
              id: bundle.id,
              data: { enabled: false },
            }),
        );
        await databasePlugin.commit(undefined, {});

        const refetched = await mapWithConcurrency(
          nextBatch,
          REMOTE_RESET_DATABASE_CONCURRENCY,
          (bundle) =>
            databasePlugin.bundles.get(undefined, {
              id: bundle.id,
            }),
        );
        const stillEnabled = refetched.find(
          (bundle) => bundle?.enabled !== false,
        );
        if (stillEnabled) {
          throw new Error(
            `Failed to disable bundle ${stillEnabled.id} during reset.`,
          );
        }
      });
      for (const bundle of nextBatch) {
        clearedIds.add(bundle.id);
        clearedBundleIds.push(bundle.id);
      }
    } else {
      for (const bundle of nextBatch) {
        await deleteProviderBundle(bundle.id);
        clearedIds.add(bundle.id);
        clearedBundleIds.push(bundle.id);
      }
    }
  }

  let remainingActiveBundle: BundleListEntry | undefined;
  for (
    let attempt = 1;
    attempt <= REMOTE_BUNDLE_CLEAR_VERIFY_ATTEMPTS;
    attempt += 1
  ) {
    remainingActiveBundle = await fetchRemainingRemoteBundle(
      mode,
      resetChannels,
    );
    if (!remainingActiveBundle) {
      break;
    }

    if (attempt >= REMOTE_BUNDLE_CLEAR_VERIFY_ATTEMPTS) {
      break;
    }

    logDetoxFixture("remote-bundles reset verification pending", {
      attempt,
      bundleId: remainingActiveBundle.id,
      channels: resetChannels,
      mode,
      platform: fixtureSession.platform,
      retryDelayMs: REMOTE_BUNDLE_CLEAR_VERIFY_DELAY_MS,
    });

    if (mode === "disable") {
      await patchProviderBundle(remainingActiveBundle.id, { enabled: false });
    } else {
      await deleteProviderBundle(remainingActiveBundle.id);
    }
    await sleep(REMOTE_BUNDLE_CLEAR_VERIFY_DELAY_MS);
  }

  if (remainingActiveBundle) {
    throw new Error(
      `Failed to clear remote bundles for platform ${fixtureSession.platform}; bundle ${remainingActiveBundle.id} is still ${mode === "delete" ? "visible" : "enabled"} after reset`,
    );
  }

  logDetoxFixture("remote-bundles reset", {
    channels: resetChannels,
    clearedBundleIds,
    clearedCount: clearedBundleIds.length,
    mode,
    platform: fixtureSession.platform,
  });
}

function updateTrackedBundleRecord(
  bundleId: string,
  patch: {
    enabled?: boolean;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[] | null;
  },
) {
  const record = fixtureSession.deployedBundles.find(
    (entry) => entry.bundleId === bundleId,
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

function ensureStorePath() {
  if (fixtureSession.storePath) {
    return fixtureSession.storePath;
  }

  if (fixtureSession.platform === "ios") {
    const appDataDir = captureCommand("xcrun", [
      "simctl",
      "get_app_container",
      deviceId as string,
      fixtureSession.appId,
      "data",
    ]);
    fixtureSession.storePath = path.join(appDataDir, "Documents/bundle-store");
    return fixtureSession.storePath;
  }

  fixtureSession.storePath = `/data/data/${fixtureSession.appId}/files/bundle-store`;
  return fixtureSession.storePath;
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

  const appDataDir = captureCommand("xcrun", [
    "simctl",
    "get_app_container",
    deviceId as string,
    fixtureSession.appId,
    "data",
  ]);
  const documentsDir = path.join(appDataDir, "Documents");

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

  const stalePaths = [
    path.join(documentsDir, "bundle-store", "metadata.json"),
    path.join(documentsDir, "bundle-store"),
    path.join(documentsDir, "bundle-temp"),
    path.join(documentsDir, "bundle-manifest-temp"),
  ];
  for (const stalePath of stalePaths) {
    if (fs.existsSync(stalePath)) {
      throw new Error(`Failed to clear iOS local bundle state: ${stalePath}`);
    }
  }

  fixtureSession.storePath = null;
  logDetoxFixture("ios local bundle state reset", {
    documentsDir,
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
        `/data/data/${fixtureSession.appId}/shared_prefs/HotUpdaterPrefs_*.xml`,
      ].join(" "),
    ],
    { allowFailure: true },
  );
  if (androidPathExists(`${ensureAndroidFilesDir()}/bundle-store`)) {
    throw new Error("Failed to clear Android bundle-store state");
  }
  fixtureSession.storePath = undefined;
  logDetoxFixture("android local app state reset", {
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

function assertMetadataState(
  metadata: Record<string, unknown>,
  bundleId: string,
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
}

function assertLaunchReport(
  filePath: string,
  expectedStatus: string,
  expectedCrashBundleId = "",
) {
  const report = readJson(filePath);

  if (report.status !== expectedStatus) {
    throw new Error(
      `Expected launch status ${expectedStatus} but received ${String(report.status)}`,
    );
  }

  if (
    expectedCrashBundleId &&
    report.crashedBundleId !== expectedCrashBundleId
  ) {
    throw new Error(
      `Expected crashedBundleId ${expectedCrashBundleId} but received ${String(report.crashedBundleId)}`,
    );
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

function getMetadataState(metadata: Record<string, unknown> | null) {
  return {
    stableBundleId: normalizeMetadataString(
      firstMetadataValue(metadata?.stableBundleId, metadata?.stable_bundle_id),
    ),
    stagingBundleId: normalizeMetadataString(
      firstMetadataValue(
        metadata?.stagingBundleId,
        metadata?.staging_bundle_id,
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

function isExpectedMetadataStateReached(
  metadataState: {
    stableBundleId: string | null;
    stagingBundleId: string | null;
    verificationPending: boolean | null;
  },
  bundleId: string,
  verificationPending: boolean,
) {
  if (metadataState.stagingBundleId !== bundleId) {
    return false;
  }

  if (metadataState.verificationPending === verificationPending) {
    return true;
  }

  return verificationPending && metadataState.verificationPending === false;
}

function isExpectedCrashRecoveryReached(
  metadataState: {
    stagingBundleId: string | null;
    verificationPending: boolean | null;
  },
  launchReportState: {
    crashedBundleId: string | null;
    status: string | null;
  },
  crashedBundleId: string,
  stableBundleId: string | undefined,
) {
  return (
    stableBundleId !== undefined &&
    metadataState.stagingBundleId === stableBundleId &&
    metadataState.verificationPending === false &&
    launchReportState.status === "RECOVERED" &&
    launchReportState.crashedBundleId === crashedBundleId
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
    ...(signatureFailure ? [`Native failure: ${signatureFailure}`] : []),
    `Metadata path: ${args.metadata.path}`,
    `Native log path: ${nativeLogPath}`,
  ].join("\n");

  return createEndpointError(message, {
    attempts: args.attempts,
    expected: {
      bundleId: args.bundleId,
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
  return readOptionalJsonSnapshot(
    path.join(ensureStorePath(), "metadata.json"),
  );
}

function readAndroidStoreSnapshot(
  remoteFileName: string,
  localFileName: string,
) {
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

function readBundleFileSnapshot(bundleId: string) {
  const bundleFileName =
    fixtureSession.platform === "ios"
      ? "index.ios.bundle"
      : "index.android.bundle";
  const storePath = ensureStorePath();

  if (fixtureSession.platform === "ios") {
    const bundleFilePath = path.join(storePath, bundleId, bundleFileName);
    return {
      exists: fs.existsSync(bundleFilePath),
      path: bundleFilePath,
    };
  }

  const remotePath = `${storePath}/${bundleId}/${bundleFileName}`;

  return {
    exists: androidFileExists(remotePath),
    path: remotePath,
  };
}

function readBundleManifestSnapshot(bundleId: string) {
  if (fixtureSession.platform === "ios") {
    return readOptionalJsonSnapshot(
      path.join(ensureStorePath(), bundleId, "manifest.json"),
    );
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

  return (
    MULTI_ASSET_FIXTURES.find((fixture) => fixture.manifestPath === assetPath)
      ?.androidManifestPath ?? assetPath
  );
}

function readIosBundleAssetFileHash(bundleId: string, assetPath: string) {
  const filePath = path.join(ensureStorePath(), bundleId, assetPath);
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      fileHash: null,
      path: filePath,
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
  const remotePath = `${ensureStorePath()}/${bundleId}/${assetPath}`;
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

function readFirstOtaArchiveState(bundleId: string) {
  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  const bundleFile = readBundleFileSnapshot(bundleId);

  return {
    bundleFile,
    diagnostics,
    metadataState,
  };
}

function getLaunchReportState(report: Record<string, unknown> | null) {
  return {
    crashedBundleId:
      (report?.crashedBundleId as string | undefined) ??
      (report?.crashed_bundle_id as string | undefined) ??
      null,
    status: (report?.status as string | undefined) ?? null,
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

function getControllerReachableProviderReadinessUrl({
  limit,
}: {
  readonly limit: number;
}) {
  const url = new URL(`${getControllerReachableAppBaseUrl()}/api/bundles`);
  if (!isLoopbackHost(url.hostname)) {
    return null;
  }

  url.searchParams.set("platform", fixtureSession.platform);
  url.searchParams.set("enabled", "true");
  url.searchParams.set("limit", String(limit));
  url.hash = "";
  return url.toString();
}

function getLocalProviderReadinessUrls() {
  const urls: string[] = [];

  for (const limit of PROVIDER_READY_BUNDLE_LIMITS) {
    const baseUrl = getControllerReachableProviderReadinessUrl({ limit });
    if (!baseUrl) {
      continue;
    }

    urls.push(baseUrl);
    for (const channel of getFixtureResetChannels() ?? []) {
      const url = new URL(baseUrl);
      url.searchParams.set("channel", channel);
      urls.push(url.toString());
    }
  }

  return urls;
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
  return `http://localhost:${port}`;
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
  logDetoxFixture("runtime config url injected", {
    key: E2E_RUNTIME_CONFIG_URL_ENV_KEY,
    value: getRuntimeConfigUrl(),
  });
}

function getHotUpdaterManagementHeaders() {
  const authToken = readHotUpdaterAuthToken();
  return authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
}

function readHotUpdaterAuthToken() {
  const envToken = process.env.HOT_UPDATER_AUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  if (!fs.existsSync(fixtureSession.envSourceFile)) {
    return null;
  }

  const source = fs.readFileSync(fixtureSession.envSourceFile, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^HOT_UPDATER_AUTH_TOKEN\s*=\s*(.*)$/);
    const token = match ? parseEnvTokenValue(match[1]).trim() : "";
    if (token) {
      return token;
    }
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
          headers: getHotUpdaterManagementHeaders(),
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
      logDetoxFixture("local provider ready", {
        attempt,
        platform: fixtureSession.platform,
        urls,
      });
      return;
    }

    if (attempt === 1 || attempt % 10 === 0) {
      logDetoxFixture("local provider readiness pending", {
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
  logDetoxFixture("android reverse ready", reversePorts);
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
  logDetoxFixture("android control reverse ready", { devicePort, hostPort });
}

function getHotUpdaterControlEnv(
  env: NodeJS.ProcessEnv | undefined = undefined,
) {
  const baseEnv = {
    ...env,
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

  return `${targetBasePath}/${segments.join("/")}`;
}

export function handleRuntimeConfig() {
  return {
    baseURL: `${getAppReachableControlBaseUrl()}/hot-updater`,
    channelNamespace,
    screenState: readE2eScreenStateSnapshot(),
    updateServerBaseURL: fixtureSession.appBaseUrl,
  };
}

function toAppReachableProxyUrl(url: string) {
  const targetId = randomUUID();
  remoteAssetProxyTargets.set(targetId, url);
  return `${getAppReachableControlBaseUrl()}/e2e/proxy-url/${targetId}`;
}

function rewriteRemoteAssetUrl(value: unknown): unknown {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
    return value;
  }

  return toAppReachableProxyUrl(value);
}

function rewriteUpdateInfoAssetUrls(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const updateInfo = payload as {
    changedAssets?: Record<string, unknown>;
    fileUrl?: unknown;
    manifestUrl?: unknown;
  };

  const rewritten: typeof updateInfo = {
    ...updateInfo,
    fileUrl: rewriteRemoteAssetUrl(updateInfo.fileUrl),
    manifestUrl: rewriteRemoteAssetUrl(updateInfo.manifestUrl),
  };

  if (
    updateInfo.changedAssets &&
    typeof updateInfo.changedAssets === "object"
  ) {
    rewritten.changedAssets = Object.fromEntries(
      Object.entries(updateInfo.changedAssets).map(([assetPath, asset]) => {
        if (!asset || typeof asset !== "object") {
          return [assetPath, asset];
        }

        const assetInfo = asset as {
          file?: { url?: unknown };
        };
        const file =
          assetInfo.file && typeof assetInfo.file === "object"
            ? {
                ...assetInfo.file,
                url: rewriteRemoteAssetUrl(assetInfo.file.url),
              }
            : assetInfo.file;

        return [assetPath, { ...assetInfo, file }];
      }),
    );
  }

  return rewritten;
}

function summarizeUpdateInfoPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { kind: typeof payload };
  }

  const updateInfo = payload as {
    changedAssets?: Record<string, unknown> | null;
    fileUrl?: unknown;
    id?: unknown;
    manifestUrl?: unknown;
    status?: unknown;
  };
  const appReachableBaseUrl = getAppReachableControlBaseUrl();
  const changedAssetEntries =
    updateInfo.changedAssets && typeof updateInfo.changedAssets === "object"
      ? Object.values(updateInfo.changedAssets)
      : [];
  const changedAssetUrlCount = changedAssetEntries.filter((asset) => {
    if (!asset || typeof asset !== "object") {
      return false;
    }

    const file = (asset as { file?: { url?: unknown } }).file;
    return typeof file?.url === "string";
  }).length;
  const proxiedChangedAssetUrlCount = changedAssetEntries.filter((asset) => {
    if (!asset || typeof asset !== "object") {
      return false;
    }

    const file = (asset as { file?: { url?: unknown } }).file;
    return (
      typeof file?.url === "string" && file.url.startsWith(appReachableBaseUrl)
    );
  }).length;

  return {
    changedAssetUrlCount,
    fileUrlPresent: typeof updateInfo.fileUrl === "string",
    fileUrlProxied:
      typeof updateInfo.fileUrl === "string" &&
      updateInfo.fileUrl.startsWith(appReachableBaseUrl),
    id: typeof updateInfo.id === "string" ? updateInfo.id : null,
    manifestUrlPresent: typeof updateInfo.manifestUrl === "string",
    manifestUrlProxied:
      typeof updateInfo.manifestUrl === "string" &&
      updateInfo.manifestUrl.startsWith(appReachableBaseUrl),
    proxiedChangedAssetUrlCount,
    status: typeof updateInfo.status === "string" ? updateInfo.status : null,
  };
}

export async function handleProxyUpdateRequest(request: Request) {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(getControllerReachableAppBaseUrl());
  targetUrl.pathname = rewriteProxiedUpdatePath(requestUrl.pathname);
  targetUrl.search = requestUrl.search;
  targetUrl.hash = "";

  const headers = new Headers(request.headers);
  headers.delete("host");

  const response = await fetch(targetUrl, {
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    headers,
    method: request.method,
  });

  logDetoxFixture("proxied update request", {
    method: request.method,
    source: requestUrl.pathname,
    target: targetUrl.toString(),
  });

  const headersToApp = new Headers(response.headers);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.text();
    try {
      const payload = JSON.parse(body);
      const rewrittenPayload = rewriteUpdateInfoAssetUrls(payload);
      logDetoxFixture("proxied update response", {
        original: summarizeUpdateInfoPayload(payload),
        rewritten: summarizeUpdateInfoPayload(rewrittenPayload),
        status: response.status,
      });
      headersToApp.delete("content-encoding");
      headersToApp.delete("content-length");
      return new Response(JSON.stringify(rewrittenPayload), {
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

  const targetUrl = new URL(target);
  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return new Response("Unsupported url protocol", { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.delete("host");

  const response = await fetch(targetUrl, {
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    headers,
    method: request.method,
  });

  logDetoxFixture("proxied remote asset request", {
    method: request.method,
    source: requestUrl.pathname,
    status: response.status,
    target: targetUrl.toString(),
  });

  const headersToApp = new Headers(response.headers);
  headersToApp.delete("content-encoding");
  headersToApp.delete("content-length");

  return new Response(response.body, {
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

  return requestUrl.searchParams.get("url");
}

function buildAppVersionUpdateCheckUrl(args: {
  bundleId: string;
  channel: string;
  cohort?: string;
  minBundleId: string;
}) {
  const encode = (value: string) => encodeURIComponent(value);
  const segments = [
    getControllerReachableAppBaseUrl(),
    "app-version",
    encode(fixtureSession.platform),
    encode(E2E_APP_VERSION),
    encode(args.channel),
    encode(args.minBundleId),
    encode(args.bundleId),
  ];
  if (args.cohort) {
    segments.push(encode(args.cohort));
  }
  return segments.join("/");
}

function getCurrentUpdateCheckBundleId() {
  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  return resolveUpdateCheckRequestBundleId(metadataState);
}

function shouldWaitForUpdateCheckVisibility(request: DeployBundleRequest) {
  return shouldProbeUpdateCheckVisibility({
    appBaseUrl: fixtureSession.appBaseUrl,
    disabled: request.disabled,
    rollout: request.rollout,
    targetCohorts: request.targetCohorts,
  });
}

async function waitForUpdateCheckVisibility(args: {
  bundleId: string;
  channel: string;
  requestBundleId: string;
  signal?: AbortSignal;
}) {
  const minBundleId = E2E_MIN_BUNDLE_ID;
  const url = buildAppVersionUpdateCheckUrl({
    bundleId: args.requestBundleId,
    channel: args.channel,
    minBundleId,
  });
  await waitForUpdateCheckVisibilityUrl({
    bundleId: args.bundleId,
    channel: args.channel,
    minBundleId,
    requestBundleId: args.requestBundleId,
    signal: args.signal,
    url,
  });
  await warmCohortUpdateCheckVisibility({
    bundleId: args.bundleId,
    channel: args.channel,
    minBundleId,
    requestBundleId: args.requestBundleId,
    signal: args.signal,
  });
}

async function waitForUpdateCheckVisibilityUrl(args: {
  bundleId: string;
  channel: string;
  minBundleId: string;
  requestBundleId: string;
  signal?: AbortSignal;
  url: string;
}) {
  let lastObserved: unknown = null;
  let lastError: string | null = null;

  for (let index = 0; index < UPDATE_CHECK_VISIBILITY_ATTEMPTS; index += 1) {
    throwIfAborted(args.signal);
    try {
      const response = await fetch(args.url, {
        headers: {
          "Hot-Updater-SDK-Version": "e2e",
        },
        signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal),
      });
      const body = await response.text();
      lastObserved = body;

      if (response.ok) {
        const payload = JSON.parse(body) as { id?: unknown; status?: unknown };
        lastObserved = {
          id: payload.id,
          status: payload.status,
        };

        if (payload.id === args.bundleId) {
          logDetoxFixture("update check visibility ready", {
            bundleId: args.bundleId,
            channel: args.channel,
            requestBundleId: args.requestBundleId,
            url: args.url,
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
      shouldLogUpdateCheckProgress(attempt, UPDATE_CHECK_VISIBILITY_ATTEMPTS)
    ) {
      logDetoxFixture("update check visibility pending", {
        attempt,
        attempts: UPDATE_CHECK_VISIBILITY_ATTEMPTS,
        expectedBundleId: args.bundleId,
        lastError,
        lastObserved,
        platform: fixtureSession.platform,
        request: {
          bundleId: args.requestBundleId,
          channel: args.channel,
          minBundleId: args.minBundleId,
        },
        url: args.url,
      });
    }

    await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal);
  }

  logDetoxFixture("update check visibility timeout", {
    expectedBundleId: args.bundleId,
    lastError,
    lastObserved,
    platform: fixtureSession.platform,
    request: {
      bundleId: args.requestBundleId,
      channel: args.channel,
      minBundleId: args.minBundleId,
    },
    url: args.url,
  });

  throw createEndpointError(
    [
      "Timed out waiting for update check visibility.",
      `Expected update check to return bundleId=${args.bundleId}.`,
      `URL: ${args.url}`,
    ].join("\n"),
    {
      expected: {
        bundleId: args.bundleId,
      },
      lastError,
      lastObserved,
      platform: fixtureSession.platform,
      request: {
        bundleId: args.requestBundleId,
        channel: args.channel,
        minBundleId: args.minBundleId,
      },
    },
  );
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
    logDetoxFixture("e2e cohort seed preserved", {
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

  logDetoxFixture("e2e cohort seeded", {
    cohort,
    platform: fixtureSession.platform,
  });
  return cohort;
}

async function warmCohortUpdateCheckVisibility(args: {
  bundleId: string;
  channel: string;
  minBundleId: string;
  requestBundleId: string;
  signal?: AbortSignal;
}) {
  const cohortValue = await seedMissingE2ECohort();

  const url = buildAppVersionUpdateCheckUrl({
    bundleId: args.requestBundleId,
    channel: args.channel,
    cohort: cohortValue,
    minBundleId: args.minBundleId,
  });
  await waitForUpdateCheckVisibilityUrl({
    bundleId: args.bundleId,
    channel: args.channel,
    minBundleId: args.minBundleId,
    requestBundleId: args.requestBundleId,
    signal: args.signal,
    url,
  });
}

async function waitForUpdateCheckExcludesBundle(args: {
  bundleId: string;
  channel: string;
  signal?: AbortSignal;
}) {
  const minBundleId = NIL_UUID;
  const url = buildAppVersionUpdateCheckUrl({
    bundleId: args.bundleId,
    channel: args.channel,
    minBundleId,
  });
  let lastObserved: unknown = null;
  let lastError: string | null = null;

  for (let index = 0; index < UPDATE_CHECK_EXCLUSION_ATTEMPTS; index += 1) {
    throwIfAborted(args.signal);
    try {
      const response = await fetch(url, {
        headers: {
          "Hot-Updater-SDK-Version": "e2e",
        },
        signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal),
      });
      const body = await response.text();
      lastObserved = body;

      if (response.ok) {
        const payload = JSON.parse(body) as {
          id?: unknown;
          status?: unknown;
        } | null;
        lastObserved = payload
          ? {
              id: payload.id,
              status: payload.status,
            }
          : null;

        if (!payload || payload.id !== args.bundleId) {
          logDetoxFixture("update check exclusion ready", {
            bundleId: args.bundleId,
            channel: args.channel,
            observed: lastObserved,
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
      logDetoxFixture("update check exclusion pending", {
        attempt,
        attempts: UPDATE_CHECK_EXCLUSION_ATTEMPTS,
        excludedBundleId: args.bundleId,
        lastError,
        lastObserved,
        platform: fixtureSession.platform,
        request: {
          bundleId: args.bundleId,
          channel: args.channel,
          minBundleId,
        },
        url,
      });
    }

    await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal);
  }

  logDetoxFixture("update check exclusion timeout", {
    excludedBundleId: args.bundleId,
    lastError,
    lastObserved,
    platform: fixtureSession.platform,
    request: {
      bundleId: args.bundleId,
      channel: args.channel,
      minBundleId,
    },
    url,
  });

  throw createEndpointError(
    [
      "Timed out waiting for update check exclusion.",
      `Expected update check not to return bundleId=${args.bundleId}.`,
      `URL: ${url}`,
    ].join("\n"),
    {
      expected: {
        excludedBundleId: args.bundleId,
      },
      lastError,
      lastObserved,
      platform: fixtureSession.platform,
      request: {
        bundleId: args.bundleId,
        channel: args.channel,
        minBundleId,
      },
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
    `Expected stagingBundleId=${args.stableBundleId}, verificationPending=false, launchReport.status=RECOVERED, crashedBundleId=${args.crashedBundleId}.`,
    `${formatObservedMetadataState(metadataState)}.`,
    `Observed launchReport.status=${String(launchReportState.status)} and crashedBundleId=${String(launchReportState.crashedBundleId)}.`,
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

function launchAndroidApp({
  explicitActivity = false,
  forceStop = true,
}: {
  explicitActivity?: boolean;
  forceStop?: boolean;
} = {}) {
  logDetoxFixture("android recovery relaunch", {
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

  const launchArgs = explicitActivity
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
    allowFailure: explicitActivity,
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
  logDetoxFixture("android recovery relaunch started", {
    appId: fixtureSession.appId,
    deviceId,
    explicitActivity,
    launchOutput,
    pid: pid || null,
  });
}

function launchIosApp() {
  logDetoxFixture("ios metadata wait relaunch", {
    appId: fixtureSession.appId,
    deviceId,
  });
  captureCommand(
    "xcrun",
    ["simctl", "launch", deviceId as string, fixtureSession.appId],
    {
      allowFailure: true,
    },
  );
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

  logDetoxFixture("android dismiss anr window", {
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
      logDetoxFixture("android anr window dismissed", {
        attempt,
        reason,
      });
      return true;
    }
  }

  logDetoxFixture("android anr window still visible", {
    anrPackage,
    attempts: E2E_ANDROID_ANR_DISMISS_ATTEMPTS,
    reason,
  });
  return true;
}

type WaitForMetadataOptions = {
  attempts?: number;
  recoveredStableBundleId?: string;
  relaunchLimit?: number;
  signal?: AbortSignal;
};

function resolveMetadataWaitOption(
  value: number | undefined,
  fallback: number,
) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
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
      if (metadata.value) {
        const metadataState = getMetadataState(metadata.value);

        if (
          isExpectedMetadataStateReached(
            metadataState,
            bundleId,
            verificationPending,
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
    const metadataState = getMetadataState(metadata.value);
    if (
      relaunchIndex === relaunchLimit ||
      metadataState.verificationPending === true
    ) {
      break;
    }

    logDetoxFixture("ios metadata wait retry", {
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
      if (metadata.value) {
        const metadataState = getMetadataState(metadata.value);
        if (
          isExpectedMetadataStateReached(
            metadataState,
            bundleId,
            verificationPending,
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
    const metadataState = getMetadataState(metadata.value);
    if (
      relaunchIndex === relaunchLimit ||
      metadataState.verificationPending === true
    ) {
      break;
    }

    logDetoxFixture("android metadata wait relaunch", {
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
    verificationPending,
  });
}

async function waitForCrashRecovery(
  stableBundleId: string,
  crashedBundleId: string,
  options: { attempts?: number; signal?: AbortSignal } = {},
) {
  return waitForCrashRecoveryState({
    androidLaunchSettleMs: E2E_ANDROID_LAUNCH_SETTLE_MS,
    attempts: options.attempts ?? 360,
    crashedBundleId,
    createTimeoutError: createWaitForRecoveryTimeoutError,
    getLaunchReportState,
    getMetadataState,
    launchAndroidApp,
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
  assertConfiguredBaseUrl();
  await seedMissingE2ECohort();

  if (fixtureSession.platform === "ios") {
    captureCommand(
      "xcrun",
      ["simctl", "terminate", deviceId as string, fixtureSession.appId],
      { allowFailure: true },
    );
    await sleep(E2E_POLL_INTERVAL_MS);
    return {};
  }

  if (fixtureSession.platform !== "android") {
    return {};
  }

  const focusedPackage = getAndroidFocusedPackage();
  const alreadyFocused = focusedPackage === fixtureSession.appId;
  logDetoxFixture("android prepare app launch", {
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

  return { alreadyFocused };
}

async function bootstrap() {
  if (fixtureSession.bootstrapResult) {
    logDetoxFixture("bootstrap result reused", {
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
  if (
    !fixtureSession.largeArchiveAssetBackupPath &&
    fs.existsSync(fixtureSession.largeArchiveAssetPath)
  ) {
    fixtureSession.largeArchiveAssetBackupPath = await backupFile(
      fixtureSession.largeArchiveAssetPath,
    );
  }

  fixtureSession.builtInBundleId = null;
  fixtureSession.deployedBundles = [];
  fixtureSession.storePath = null;

  await waitForLocalProviderReady();
  await clearProviderBundles({
    mode: "delete",
  });
  await restoreFile(
    fixtureSession.largeArchiveAssetBackupPath,
    fixtureSession.largeArchiveAssetPath,
  );
  await restoreMultiAssetFixtures();
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
  const builtInBundleId = BUILT_IN_MIN_BUNDLE_ID_SUFFIX;

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
      logDetoxFixture("bare build cache lock acquired", { cacheKey });
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
        logDetoxFixture("bare build cache lock owner exited; removing", {
          cacheKey,
          owner,
        });
        await fsPromises.rm(lockPath, { force: true, recursive: true });
        loggedWait = false;
        continue;
      }

      if (stats && ageMs > BARE_BUILD_CACHE_LOCK_STALE_MS) {
        logDetoxFixture("bare build cache lock stale; removing", {
          ageMs,
          cacheKey,
        });
        await fsPromises.rm(lockPath, { force: true, recursive: true });
        continue;
      }

      if (!loggedWait) {
        logDetoxFixture("bare build cache lock waiting", { cacheKey });
        loggedWait = true;
      }
      await abortableSleep(BARE_BUILD_CACHE_LOCK_WAIT_MS, signal);
    }
  }
}

async function readDeployProcessLockOwner(lockPath: string) {
  try {
    return JSON.parse(
      await fsPromises.readFile(path.join(lockPath, "owner.json"), "utf8"),
    ) as { pid?: unknown; platform?: unknown; startedAt?: unknown };
  } catch {
    return null;
  }
}

function isDeployProcessLockOwnerAlive(
  owner: Awaited<ReturnType<typeof readDeployProcessLockOwner>>,
) {
  if (!owner || typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) {
    return true;
  }

  return isProcessRunning(owner.pid);
}

async function acquireDeployProcessLock(signal?: AbortSignal) {
  const lockRoot = deployProcessLockRoot();
  const lockPath = path.join(lockRoot, "deploy.lock");
  await fsPromises.mkdir(lockRoot, { recursive: true });
  let loggedWait = false;

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
      logDetoxFixture("deploy process lock acquired", {
        lockPath,
        platform: fixtureSession.platform,
      });
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
      const owner = await readDeployProcessLockOwner(lockPath);
      if (!isDeployProcessLockOwnerAlive(owner)) {
        logDetoxFixture("deploy process lock owner exited; removing", {
          lockPath,
          owner,
        });
        await fsPromises.rm(lockPath, { force: true, recursive: true });
        loggedWait = false;
        continue;
      }

      if (stats && ageMs > BARE_BUILD_CACHE_LOCK_STALE_MS) {
        logDetoxFixture("deploy process lock stale; removing", {
          ageMs,
          lockPath,
          owner,
        });
        await fsPromises.rm(lockPath, { force: true, recursive: true });
        continue;
      }

      if (!loggedWait) {
        logDetoxFixture("deploy process lock waiting", {
          lockPath,
          owner,
          platform: fixtureSession.platform,
        });
        loggedWait = true;
      }
      await abortableSleep(BARE_BUILD_CACHE_LOCK_WAIT_MS, signal);
    }
  }
}

async function releaseDeployProcessLock(lockPath: string) {
  await fsPromises.rm(lockPath, { force: true, recursive: true });
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
  const updateCheckRequestBundleId = getCurrentUpdateCheckBundleId();

  if (bundleProfile === "archive300mb") {
    throwIfAborted(signal);
    await ensureLargeArchiveAsset();
  }
  if (bundleProfile === "multiAssetReplacement") {
    throwIfAborted(signal);
    await ensureMultiAssetFixtures(request.marker);
  }

  throwIfAborted(signal);
  await applyDeployConfig({
    patchEnabled,
    patchMaxBaseBundles: request.patchMaxBaseBundles,
  });
  await applyAppScenario({
    bundleProfile,
    marker: request.marker,
    mode: request.mode,
    safeBundleIds: request.safeBundleIds,
  });

  const deployOutputPath = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "hu-detox-deploy-"),
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
  logDetoxFixture("deploy start", {
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
  const deployProcessLockPath = await acquireDeployProcessLock(signal);
  let bareBuildLockPath: string | null = null;
  let deployDurationMs = 0;
  const deployOutput = await (async () => {
    try {
      bareBuildLockPath = await acquireBareBuildCacheLock(cacheEnv, signal);
      const deployStartedAt = Date.now();
      const output = await runLoggedCommand("node", args, {
        cwd: fixtureSession.exampleDir,
        env: getHotUpdaterControlEnv(cacheEnv),
        logPath: deployLogPath,
        signal,
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
      await releaseDeployProcessLock(deployProcessLockPath);
    }
  })();
  const bundleId = extractDeployBundleId(deployOutput);
  if (!bundleId) {
    throw new Error(
      [
        "Failed to resolve deployed bundle id from hot-updater deploy output.",
        `See ${deployLogPath}`,
      ].join("\n"),
    );
  }

  const archiveDetails = await (async () => {
    try {
      const archivePath = await resolveDeployArchivePath(deployOutputPath);
      const archiveStats = await fsPromises.stat(archivePath);

      if (
        bundleProfile === "archive300mb" &&
        archiveStats.size < LARGE_ARCHIVE_MIN_EXPECTED_SIZE_BYTES
      ) {
        throw new Error(
          [
            `Expected archive300mb deploy output to be at least ${LARGE_ARCHIVE_MIN_EXPECTED_SIZE_BYTES} bytes.`,
            `Observed ${archiveStats.size} bytes at ${archivePath}.`,
          ].join("\n"),
        );
      }

      const deployTiming = {
        bundleProfile,
        channel: request.channel,
        durationMs: deployDurationMs,
        marker: request.marker,
        mode: request.mode,
        platform: fixtureSession.platform,
      };
      logDetoxFixture("deploy timing", deployTiming);
      logDetoxFixture("deploy done", {
        archivePath: path.relative(REPO_DIR, archivePath),
        archiveSizeBytes: archiveStats.size,
        ...deployTiming,
        logPath: path.relative(REPO_DIR, deployLogPath),
      });

      return {
        path: archivePath,
        sizeBytes: archiveStats.size,
      };
    } finally {
      await fsPromises.rm(deployOutputPath, { force: true, recursive: true });
    }
  })();

  if (request.targetCohorts && request.targetCohorts.length > 0) {
    await patchProviderBundle(bundleId, {
      targetCohorts: request.targetCohorts,
    });
  }

  let bundle = await fetchProviderBundleById(bundleId);
  if (shouldWaitForUpdateCheckVisibility(request)) {
    await waitForUpdateCheckVisibility({
      bundleId,
      channel: bundle.channel,
      requestBundleId: updateCheckRequestBundleId,
      signal,
    });
  }

  const diff =
    request.diffBaseBundleId !== undefined
      ? await resolveAutoPatchBundleDiff(request.diffBaseBundleId, bundleId)
      : null;
  bundle = await fetchProviderBundleById(bundleId);
  const patchBaseBundleIds = getBundlePatchBaseBundleIds(bundle);

  fixtureSession.deployedBundles.push({
    archiveSizeBytes: archiveDetails.sizeBytes,
    bundleId,
    bundleProfile,
    channel: bundle.channel,
    diffBaseBundleId: diff?.baseBundleId ?? null,
    diffPatchAssetPath: diff?.patchAssetPath ?? null,
    enabled: bundle.enabled,
    marker: request.marker,
    mode: request.mode,
    patchBaseBundleIds,
    rolloutCohortCount: bundle.rolloutCohortCount ?? null,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
    targetCohorts: bundle.targetCohorts ?? null,
  });

  return {
    archiveSizeBytes: archiveDetails.sizeBytes,
    bundleId,
    bundleProfile,
    channel: bundle.channel,
    diffBaseBundleId: diff?.baseBundleId,
    diffPatchAssetPath: diff?.patchAssetPath,
    enabled: bundle.enabled,
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
    rolloutCohortCount: bundle.rolloutCohortCount ?? null,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
    targetCohorts: bundle.targetCohorts ?? null,
  };
}

async function updateFixtureBundle(
  request: PatchBundleRequest,
  context?: JobExecutionContext,
) {
  const signal = context?.signal;
  throwIfAborted(signal);
  await patchProviderBundle(request.bundleId, {
    enabled: request.enabled,
    rolloutCohortCount: request.rolloutCohortCount,
    shouldForceUpdate: request.shouldForceUpdate,
    targetCohorts: request.targetCohorts,
  });

  const bundle = await fetchProviderBundleById(request.bundleId);
  if (request.enabled === false && bundle.enabled === false) {
    await waitForUpdateCheckExcludesBundle({
      bundleId: bundle.id,
      channel: bundle.channel,
      signal,
    });
  }

  updateTrackedBundleRecord(request.bundleId, {
    enabled: bundle.enabled,
    rolloutCohortCount: bundle.rolloutCohortCount ?? null,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
    targetCohorts: bundle.targetCohorts ?? null,
  });

  return {
    bundleId: bundle.id,
    channel: bundle.channel,
    enabled: bundle.enabled,
    rolloutCohortCount: bundle.rolloutCohortCount ?? null,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
    targetCohorts: bundle.targetCohorts ?? null,
  };
}

async function computeRolloutSample(bundleId: string) {
  const bundle = await fetchProviderBundleById(bundleId);
  const rolloutCohorts = getRolledOutNumericCohorts(
    bundleId,
    bundle.rolloutCohortCount ?? null,
  );

  if (rolloutCohorts.length === 0) {
    throw new Error(`Bundle ${bundleId} has no eligible numeric cohorts`);
  }

  const rolloutSet = new Set(rolloutCohorts);
  const excludedCohort = Array.from({ length: 1000 }, (_, index) => index + 1)
    .find((cohortValue) => !rolloutSet.has(cohortValue))
    ?.toString();

  if (!excludedCohort) {
    throw new Error(
      `Bundle ${bundleId} is rolled out to all numeric cohorts; no excluded sample exists`,
    );
  }

  return {
    excludedCohort,
    includedCohort: String(rolloutCohorts[0]),
    rolloutCohortCount: bundle.rolloutCohortCount ?? null,
  };
}

async function waitForMetadata(
  bundleId: string,
  verificationPending: boolean,
  options: WaitForMetadataOptions = {},
) {
  throwIfAborted(options.signal);
  if (fixtureSession.platform === "ios") {
    await waitForIosMetadataState(bundleId, verificationPending, options);
  } else {
    await waitForAndroidMetadataState(bundleId, verificationPending, options);
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
        'eventMessage CONTAINS "HotUpdaterBsdiffPatchApplied"',
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
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\n")
    .filter((line) => line.includes("HotUpdaterBsdiffPatchApplied"))
    .join("\n");
}

function readFirstOtaArchiveInstallLogs() {
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
        'eventMessage CONTAINS "Skipping manifest-driven install"',
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
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\n")
    .filter((line) => line.includes("Skipping manifest-driven install"))
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
      "DecompressService:D",
      "ReactNativeJS:E",
      "*:S",
    ],
    { allowFailure: true, maxBuffer: 8 * 1024 * 1024 },
  );
}

function includesAllFragments(logs: string, fragments: string[]) {
  return fragments.every((fragment) => logs.includes(fragment));
}

function readBsdiffPatchStoreEvidence(args: {
  assetPath: string;
  baseBundleId: string;
}) {
  const record = fixtureSession.deployedBundles.find(
    (entry) =>
      entry.diffBaseBundleId === args.baseBundleId &&
      entry.diffPatchAssetPath === args.assetPath,
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
    metadataState.stableBundleId === args.baseBundleId &&
    metadataState.stagingBundleId === record.bundleId &&
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
  bundleId: string;
  previousBundleId: string;
}) {
  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  const bundleFile = readBundleFileSnapshot(args.bundleId);
  const manifest = readBundleManifestSnapshot(args.bundleId);
  const assetPath = getPrimaryBundleAssetPath();
  const expectedHash = getManifestAssetFileHash(manifest, assetPath);
  const assetFile = readBundleAssetFileHash(args.bundleId, assetPath);
  const archiveLogs = readFirstOtaArchiveInstallLogs();
  const bsdiffLogs = readBsdiffPatchLogs();
  const archiveFragments = [
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
  const record =
    fixtureSession.deployedBundles.find(
      (entry) => entry.bundleId === args.bundleId,
    ) ?? null;
  const ok =
    metadataState.stableBundleId === args.previousBundleId &&
    metadataState.stagingBundleId === args.bundleId &&
    metadataState.verificationPending === false &&
    hasManifestBackedBundleEvidence({
      assetFile,
      bundleFile,
      expectedHash,
      manifest,
    }) &&
    !includesAllFragments(archiveLogs, archiveFragments) &&
    !includesAllFragments(bsdiffLogs, bsdiffFragments);

  return {
    archiveFragments,
    archiveLogs,
    assetFile,
    assetPath,
    bsdiffFragments,
    bsdiffLogs,
    bundleFile,
    diagnostics,
    expectedHash,
    manifest,
    metadataState,
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
      logDetoxFixture("bundle assets stored", {
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
      logDetoxFixture("multiple assets replaced", {
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
}) {
  const expectedFragments = [
    "HotUpdaterBsdiffPatchApplied",
    `asset=${args.assetPath}`,
    `baseBundleId=${args.baseBundleId}`,
  ];

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const evidence = readBsdiffPatchStoreEvidence(args);
    if (evidence.ok && "record" in evidence) {
      const logs = readBsdiffPatchLogs();
      logDetoxFixture("bsdiff patch applied", {
        assetPath: args.assetPath,
        baseBundleId: args.baseBundleId,
        bundleId: evidence.record.bundleId,
        evidence: includesAllFragments(logs, expectedFragments)
          ? "bundle-store-and-native-log"
          : "bundle-store",
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
  bundleId: string;
  previousBundleId: string;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await readManifestDiffState(args);
    if (state.ok) {
      logDetoxFixture("manifest diff applied without bsdiff patch", {
        bundleId: args.bundleId,
        evidence: "bundle-store-without-archive-or-bsdiff-log",
        platform: fixtureSession.platform,
        previousBundleId: args.previousBundleId,
      });
      return {};
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const state = await readManifestDiffState(args);
  throw createEndpointError(
    "Timed out waiting for manifest diff install evidence.",
    {
      archiveLogMatched: includesAllFragments(
        state.archiveLogs,
        state.archiveFragments,
      ),
      assetFile: state.assetFile,
      assetPath: state.assetPath,
      bsdiffLogMatched: includesAllFragments(
        state.bsdiffLogs,
        state.bsdiffFragments,
      ),
      bundleFile: state.bundleFile,
      bundleId: args.bundleId,
      diagnostics: state.diagnostics,
      expectedHash: state.expectedHash,
      manifest: state.manifest,
      metadataState: state.metadataState,
      platform: fixtureSession.platform,
      previousBundleId: args.previousBundleId,
      trackedBundleRecord: state.record,
    },
  );
}

async function assertFirstOtaUsesArchive(args: { bundleId: string }) {
  const expectedFragments = [
    "Skipping manifest-driven install",
    `for ${args.bundleId}`,
    "no active OTA manifest is available",
    "Using archive",
  ];

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = readFirstOtaArchiveState(args.bundleId);
    if (
      state.metadataState.stagingBundleId === args.bundleId &&
      state.metadataState.verificationPending === true &&
      state.metadataState.stableBundleId === null &&
      state.bundleFile.exists
    ) {
      logDetoxFixture("first OTA used archive install path", {
        bundleId: args.bundleId,
        bundleFilePath: state.bundleFile.path,
        evidence: "bundle-store",
        metadataPath: state.diagnostics.metadata.path,
        platform: fixtureSession.platform,
      });
      return {};
    }

    if (
      state.metadataState.stagingBundleId === args.bundleId &&
      state.metadataState.verificationPending === false &&
      state.bundleFile.exists
    ) {
      logDetoxFixture("first OTA used archive install path", {
        bundleId: args.bundleId,
        bundleFilePath: state.bundleFile.path,
        evidence: "bundle-store-active",
        metadataPath: state.diagnostics.metadata.path,
        platform: fixtureSession.platform,
      });
      return {};
    }

    const logs = readFirstOtaArchiveInstallLogs();
    if (includesAllFragments(logs, expectedFragments)) {
      logDetoxFixture("first OTA used archive install path", {
        bundleId: args.bundleId,
        evidence: "native-log",
        platform: fixtureSession.platform,
      });
      return {};
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const logs = readFirstOtaArchiveInstallLogs();
  const state = readFirstOtaArchiveState(args.bundleId);
  throw createEndpointError(
    "Timed out waiting for first OTA archive install evidence.",
    {
      bundleId: args.bundleId,
      expectedFragments,
      expectedState: {
        bundleFileExists: true,
        states: [
          {
            stableBundleId: null,
            stagingBundleId: args.bundleId,
            verificationPending: true,
          },
          {
            stagingBundleId: args.bundleId,
            verificationPending: false,
          },
        ],
      },
      logsTail: logs.split("\n").slice(-20),
      observedState: {
        bundleFile: state.bundleFile,
        metadata: state.diagnostics.metadata,
        metadataState: state.metadataState,
      },
      platform: fixtureSession.platform,
    },
  );
}

async function captureState(prefix: string) {
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
  await clearProviderBundles({
    mode: "delete",
  });

  logDetoxFixture("remote bundles reset on demand", {
    platform: fixtureSession.platform,
  });

  return {};
}

async function resetLocalAppState() {
  resetE2eScreenState();
  if (fixtureSession.platform === "ios") {
    await clearIosLocalBundleState();
  } else {
    clearAndroidLocalAppState();
  }
  await seedMissingE2ECohort();

  logDetoxFixture("local app state reset on demand", {
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

  logDetoxFixture("bundle patch bases verified", {
    bundleId: args.bundleId,
    observedBaseBundleIds,
    platform: fixtureSession.platform,
  });

  return {
    observedBaseBundleIds,
  };
}

async function assertMetadataActive(bundleId: string) {
  const metadata =
    fixtureSession.platform === "ios"
      ? readJson(path.join(ensureStorePath(), "metadata.json"))
      : (() => {
          const probePath = path.join(
            fixtureSession.resultsDir,
            "metadata-assert.json",
          );
          copyAndroidFile(`${ensureStorePath()}/metadata.json`, probePath);
          return readJson(probePath);
        })();

  assertMetadataState(metadata, bundleId);
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
  crashedBundleId,
  optional,
  stableBundleId,
  status,
}: LaunchReportAssertion) {
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
        crashedBundleId,
        stableBundleId,
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

  assertLaunchReport(launchReportPath, status, crashedBundleId ?? "");
  return {};
}

async function assertCrashHistory(bundleId: string) {
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
    fixtureSession.largeArchiveAssetBackupPath,
    fixtureSession.largeArchiveAssetPath,
  );
  await restoreMultiAssetFixtures();

  fixtureSession.appBackupPath = null;
  fixtureSession.configBackupPath = null;
  fixtureSession.envBackupPath = null;
  fixtureSession.largeArchiveAssetBackupPath = null;
  fixtureSession.multiAssetBackupPaths = {};
  return {};
}

function createJob(task: (context: JobExecutionContext) => Promise<JobResult>) {
  const jobId = randomUUID();
  const abortController = new AbortController();
  jobAbortControllers.set(jobId, abortController);
  jobs.set(jobId, { status: "running" });

  void task({ signal: abortController.signal })
    .then((result) => {
      if (abortController.signal.aborted) {
        return;
      }
      jobs.set(jobId, { result, status: "succeeded" });
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Unknown E2E job failure";
      if (abortController.signal.aborted) {
        logDetoxFixture("control job cancelled", {
          error: message,
          jobId,
        });
        const current = jobs.get(jobId);
        if (current?.status === "running") {
          jobs.set(jobId, { error: message, status: "cancelled" });
        }
        return;
      }
      logDetoxFixture("control job failed", {
        cause: formatErrorCause(error),
        error: message,
        jobId,
        stack: error instanceof Error ? error.stack : undefined,
      });
      jobs.set(jobId, { error: message, status: "failed" });
    })
    .finally(() => {
      jobAbortControllers.delete(jobId);
    });

  return jobId;
}

export function startBootstrapJob() {
  if (bootstrapJobId) {
    const job = jobs.get(bootstrapJobId);
    if (job?.status === "running" || job?.status === "succeeded") {
      return bootstrapJobId;
    }
  }

  bootstrapJobId = createJob(() => bootstrap());
  return bootstrapJobId;
}

export function startDeployBundleJob(request: DeployBundleRequest) {
  return createJob((context) => deployFixtureBundle(request, context));
}

export function startPatchBundleJob(request: PatchBundleRequest) {
  return createJob((context) => updateFixtureBundle(request, context));
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

export function startWaitForCrashRecoveryJob(
  stableBundleId: string,
  crashedBundleId: string,
) {
  return createJob((context) =>
    waitForCrashRecovery(stableBundleId, crashedBundleId, {
      signal: context.signal,
    }),
  );
}

export function getJob(jobId: string) {
  return jobs.get(jobId) ?? null;
}

export function cancelJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) {
    return null;
  }
  if (job.status !== "running") {
    return job;
  }

  const error = "cancelled by control client timeout";
  jobs.set(jobId, { error, status: "cancelled" });
  jobAbortControllers.get(jobId)?.abort(new Error(error));
  logDetoxFixture("control job cancel requested", { jobId });
  return jobs.get(jobId) ?? null;
}

export async function handleCaptureBuiltInBundleId() {
  return captureBuiltInBundleId();
}

export async function handleComputeRolloutSample(bundleId: string) {
  return computeRolloutSample(bundleId);
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
}) {
  return assertBsdiffPatchApplied(args);
}

export async function handleAssertFirstOtaUsesArchive(bundleId: string) {
  return assertFirstOtaUsesArchive({ bundleId });
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
  bundleId: string;
  previousBundleId: string;
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

export async function handleWaitForCrashRecovery(
  stableBundleId: string,
  crashedBundleId: string,
  options: { signal?: AbortSignal } = {},
) {
  return waitForCrashRecovery(stableBundleId, crashedBundleId, options);
}

export async function handlePrepareAppLaunch() {
  return prepareAppLaunch();
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
