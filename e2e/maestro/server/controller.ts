import { spawn, spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import type { FileHandle } from "fs/promises";
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

type Platform = "ios" | "android";
type BundleProfile = "archive300mb" | "default" | "multiAssetReplacement";

type JobResult = Record<string, unknown>;

type JobState = {
  error?: string;
  result?: JobResult;
  status: "failed" | "running" | "succeeded";
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
  androidApkPath: string;
  appBaseUrl: string;
  appBackupPath: string | null;
  appId: string;
  appSourceFile: string;
  builtArtifactPath: string | null;
  bootstrapResult: JobResult | null;
  builtInBundleId: string | null;
  configBackupPath: string | null;
  configSourceFile: string;
  deployedBundles: DeployedBundleRecord[];
  exampleDir: string;
  initialMarker: string;
  iosDerivedDataPath: string;
  largeArchiveAssetBackupPath: string | null;
  largeArchiveAssetPath: string;
  multiAssetBackupPaths: Record<string, string | null>;
  platform: Platform;
  resultsDir: string;
  reuseApp: boolean;
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

type LaunchReportAssertion = {
  crashedBundleId?: string;
  optional: boolean;
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
const EXAMPLE_DIR = path.join(REPO_DIR, "examples/v0.85.0");
const APP_SOURCE_FILE = path.join(EXAMPLE_DIR, "App.tsx");
const HOT_UPDATER_CONFIG_FILE = path.join(EXAMPLE_DIR, "hot-updater.config.ts");
const DEFAULT_ANDROID_APK_RELATIVE_PATH =
  "android/app/build/outputs/apk/release/app-release.apk";
const BARE_BUILD_CACHE_VERSION = 1;
const BARE_BUILD_CACHE_INPUT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "examples/v0.85.0/App.tsx",
  "examples/v0.85.0/index.js",
  "examples/v0.85.0/package.json",
  "examples/v0.85.0/babel.config.js",
  "examples/v0.85.0/metro.config.js",
  "examples/v0.85.0/src/test",
  "plugins/bare",
  "packages/core",
  "packages/hot-updater/src/utils/bundleManifest.ts",
  "packages/react-native",
];
const NATIVE_ARTIFACT_CACHE_VERSION = 3;
const IOS_DERIVED_DATA_CACHE_KEY_FILE = ".hot-updater-e2e-native-cache-key";
const NATIVE_ARTIFACT_CACHE_INPUT_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "examples/v0.85.0/App.tsx",
  "examples/v0.85.0/index.js",
  "examples/v0.85.0/package.json",
  "examples/v0.85.0/babel.config.js",
  "examples/v0.85.0/metro.config.js",
  "examples/v0.85.0/android",
  "examples/v0.85.0/ios",
  "packages/core",
  "packages/react-native",
];
const SIGNING_PRIVATE_KEY_RELATIVE_PATH = "keys/private-key.pem";
const SIGNING_PUBLIC_KEY_RELATIVE_PATH = "keys/public-key.pem";
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
const NATIVE_ARTIFACT_LOCK_RETRY_MS = 1_000;
const NATIVE_ARTIFACT_LOCK_TIMEOUT_MS = 45 * 60 * 1_000;
const MARKER_PATTERN = /const E2E_SCENARIO_MARKER = ".*?";/;
const E2E_APP_VERSION = "1.0";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const BUILT_IN_MIN_BUNDLE_ID_SUFFIX = "7000-8000-000000000000";
const LARGE_ARCHIVE_ASSET_RELATIVE_PATH =
  "src/test/_fixture-archive-300mb-random.bmp";
const LARGE_ARCHIVE_ASSET_REQUIRE_PATH =
  "./src/test/_fixture-archive-300mb-random.bmp";
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
    requirePath: "./src/test/_fixture-multi-asset-a.bmp",
  },
  {
    androidManifestPath: "raw/src_test__fixturemultiassetb.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-b.bmp",
    relativePath: "src/test/_fixture-multi-asset-b.bmp",
    requirePath: "./src/test/_fixture-multi-asset-b.bmp",
  },
  {
    androidManifestPath: "raw/src_test__fixturemultiassetc.bmp",
    manifestPath: "assets/src/test/_fixture-multi-asset-c.bmp",
    relativePath: "src/test/_fixture-multi-asset-c.bmp",
    requirePath: "./src/test/_fixture-multi-asset-c.bmp",
  },
] as const;
const MULTI_ASSET_BMP_WIDTH = 64;
const MULTI_ASSET_BMP_HEIGHT = 64;
const MULTI_ASSET_BMP_HEADER_SIZE = 54;
const MULTI_ASSET_BMP_ROW_SIZE = Math.ceil((MULTI_ASSET_BMP_WIDTH * 3) / 4) * 4;
const MULTI_ASSET_BMP_SIZE_BYTES =
  MULTI_ASSET_BMP_HEADER_SIZE +
  MULTI_ASSET_BMP_ROW_SIZE * MULTI_ASSET_BMP_HEIGHT;
const ANDROID_E2E_ARCHITECTURES = new Set([
  "armeabi-v7a",
  "arm64-v8a",
  "x86",
  "x86_64",
]);
const REMOTE_BUNDLE_DELETE_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_REMOTE_BUNDLE_DELETE_ATTEMPTS || 3,
);
const REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS = Number(
  process.env.HOT_UPDATER_E2E_REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS || 5000,
);
const PROVIDER_OPERATION_RETRY_ATTEMPTS = Number(
  process.env.HOT_UPDATER_E2E_PROVIDER_OPERATION_RETRY_ATTEMPTS || 3,
);
const PROVIDER_OPERATION_RETRY_DELAY_MS = Number(
  process.env.HOT_UPDATER_E2E_PROVIDER_OPERATION_RETRY_DELAY_MS || 1000,
);
const DELETE_VERIFY_STILL_EXISTS_PATTERN =
  /Verification failed: .+ still exists\./i;
const E2E_POLL_INTERVAL_MS = Number(
  process.env.HOT_UPDATER_E2E_POLL_INTERVAL_MS || 250,
);
const E2E_ANDROID_LAUNCH_SETTLE_MS = Number(
  process.env.HOT_UPDATER_E2E_ANDROID_LAUNCH_SETTLE_MS || 1000,
);
const E2E_IOS_LAUNCH_SETTLE_MS = Number(
  process.env.HOT_UPDATER_E2E_IOS_LAUNCH_SETTLE_MS || 1000,
);
const E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH = Number(
  process.env.HOT_UPDATER_E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH || 120,
);
const E2E_METADATA_WAIT_RELAUNCH_LIMIT = Number(
  process.env.HOT_UPDATER_E2E_METADATA_WAIT_RELAUNCH_LIMIT || 2,
);
const LOG_PREFIX = "[maestro-e2e]";

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

function logE2e(event: string, details?: unknown) {
  const suffix = details === undefined ? "" : ` ${formatLogValue(details)}`;
  console.log(`${LOG_PREFIX} ${event}${suffix}`);
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTransientProviderError(error: unknown) {
  const message = formatErrorMessage(error);
  return /\b(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout)\b/i.test(
    message,
  );
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

const session: SessionState = {
  androidApkPath: path.isAbsolute(
    process.env.HOT_UPDATER_E2E_ANDROID_APK_PATH ??
      DEFAULT_ANDROID_APK_RELATIVE_PATH,
  )
    ? (process.env.HOT_UPDATER_E2E_ANDROID_APK_PATH as string)
    : path.join(
        EXAMPLE_DIR,
        process.env.HOT_UPDATER_E2E_ANDROID_APK_PATH ??
          DEFAULT_ANDROID_APK_RELATIVE_PATH,
      ),
  appBaseUrl:
    process.env.HOT_UPDATER_E2E_APP_BASE_URL ??
    "http://localhost:3007/hot-updater",
  appBackupPath: null,
  appId,
  appSourceFile: APP_SOURCE_FILE,
  builtArtifactPath: null,
  bootstrapResult: null,
  builtInBundleId: null,
  configBackupPath: null,
  configSourceFile: HOT_UPDATER_CONFIG_FILE,
  deployedBundles: [],
  exampleDir: EXAMPLE_DIR,
  initialMarker:
    platform === "ios" ? "builtin-ios-maestro" : "builtin-android-maestro",
  iosDerivedDataPath:
    process.env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH ??
    "/tmp/hotupdater-v085-ios-maestro",
  largeArchiveAssetBackupPath: null,
  largeArchiveAssetPath: path.join(
    EXAMPLE_DIR,
    LARGE_ARCHIVE_ASSET_RELATIVE_PATH,
  ),
  multiAssetBackupPaths: {},
  platform,
  resultsDir,
  reuseApp: process.env.HOT_UPDATER_E2E_REUSE_APP === "true",
  storePath: null,
};

const jobs = new Map<string, JobState>();
let bootstrapJobId: string | null = null;

function runCapture(
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

async function runLogged(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    logPath: string;
  },
) {
  await fsPromises.mkdir(path.dirname(options.logPath), { recursive: true });

  const output: Buffer[] = [];
  const logStream = fs.createWriteStream(options.logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    output.push(chunk);
    logStream.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.push(chunk);
    logStream.write(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  logStream.end();

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${exitCode}. See ${options.logPath}`,
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

function nativeArtifactCacheRoot() {
  const cacheDir = process.env.HOT_UPDATER_E2E_NATIVE_CACHE_DIR;
  if (!cacheDir) {
    return null;
  }

  return path.resolve(REPO_DIR, cacheDir);
}

function bareBuildCacheRoot() {
  const cacheDir = process.env.HOT_UPDATER_E2E_BARE_BUILD_CACHE_DIR;
  if (!cacheDir) {
    return null;
  }

  return path.resolve(REPO_DIR, cacheDir);
}

function readOptionalFileHash(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }

  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readGitTrackedInputFiles(inputPaths: string[]) {
  const output = runCapture("git", ["ls-files", "-z", "--", ...inputPaths], {
    cwd: REPO_DIR,
    maxBuffer: 32 * 1024 * 1024,
  });

  return output.split("\0").filter(Boolean).sort();
}

function hashGitTrackedInputFiles(inputPaths: string[]) {
  const hash = createHash("sha256");
  for (const relativePath of readGitTrackedInputFiles(inputPaths)) {
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

function hashNativeArtifactInputs() {
  return hashGitTrackedInputFiles(NATIVE_ARTIFACT_CACHE_INPUT_PATHS);
}

function hashBareBuildInputs() {
  return hashGitTrackedInputFiles(BARE_BUILD_CACHE_INPUT_PATHS);
}

function bareBuildConfigFingerprint() {
  const source = fs.existsSync(HOT_UPDATER_CONFIG_FILE)
    ? fs.readFileSync(HOT_UPDATER_CONFIG_FILE, "utf8")
    : "";
  const match = source.match(BARE_BUILD_INLINE_PATTERN);

  return hashText(match?.[0] ?? "missing");
}

function readNativeEnvImports() {
  const source = fs.existsSync(APP_SOURCE_FILE)
    ? fs.readFileSync(APP_SOURCE_FILE, "utf8")
    : "";
  const envNames = new Set<string>();
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*["']@env["']/g;

  for (const match of source.matchAll(importPattern)) {
    const names = match[1] ?? "";
    for (const name of names.split(",")) {
      const importedName = name
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (importedName) {
        envNames.add(importedName);
      }
    }
  }

  return [...envNames].sort();
}

function parseDotenvFile(filePath: string) {
  const values = new Map<string, string>();
  if (!fs.existsSync(filePath)) {
    return values;
  }

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue = ""] = match;
    let value = rawValue.trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return values;
}

function nativeDotenvFingerprint() {
  const importedEnvNames = readNativeEnvImports();
  const dotenvValues = parseDotenvFile(
    path.join(session.exampleDir, ".env.hotupdater"),
  );

  return hashText(
    JSON.stringify(
      importedEnvNames.map((name) => [
        name,
        dotenvValues.has(name) ? dotenvValues.get(name) : null,
      ]),
    ),
  );
}

function signingKeyFingerprint() {
  const privateKeyPath = path.join(
    session.exampleDir,
    SIGNING_PRIVATE_KEY_RELATIVE_PATH,
  );
  const publicKeyPath = path.join(
    session.exampleDir,
    SIGNING_PUBLIC_KEY_RELATIVE_PATH,
  );

  return hashText(
    JSON.stringify({
      privateKey: readOptionalFileHash(privateKeyPath),
      publicKey: readOptionalFileHash(publicKeyPath),
    }),
  );
}

function readToolFingerprint() {
  if (session.platform !== "ios") {
    return null;
  }

  return runCapture("xcodebuild", ["-version"], {
    allowFailure: true,
  });
}

function nativeArtifactCacheKey(architecture?: string | null) {
  return hashText(
    JSON.stringify({
      appBaseUrl: session.appBaseUrl,
      appId: session.appId,
      architecture: architecture ?? null,
      cacheVersion: NATIVE_ARTIFACT_CACHE_VERSION,
      initialMarker: session.initialMarker,
      inputHash: hashNativeArtifactInputs(),
      nativeEnv: nativeDotenvFingerprint(),
      platform: session.platform,
      runtime: {
        arch: process.arch,
        platform: process.platform,
      },
      signingKey: signingKeyFingerprint(),
      tool: readToolFingerprint(),
    }),
  );
}

function nativeArtifactCachePaths(key: string) {
  const root = nativeArtifactCacheRoot();
  if (!root) {
    return null;
  }

  const entryDir = path.join(root, session.platform, key);
  return {
    artifactPath: path.join(
      entryDir,
      session.platform === "ios" ? "HotUpdaterExample.app" : "app-release.apk",
    ),
    entryDir,
    manifestPath: path.join(entryDir, "manifest.json"),
    root,
  };
}

function reuseAppInstallMarkerPath(cacheKey: string) {
  return path.join(
    EXAMPLE_DIR,
    "e2e/.reuse-app-installs",
    `${session.platform}-${hashText(deviceId as string).slice(0, 12)}-${cacheKey}`,
  );
}

async function hasReuseAppInstallMarker(cacheKey: string) {
  return fs.existsSync(reuseAppInstallMarkerPath(cacheKey));
}

async function writeReuseAppInstallMarker(cacheKey: string) {
  const markerPath = reuseAppInstallMarkerPath(cacheKey);
  await fsPromises.mkdir(path.dirname(markerPath), { recursive: true });
  await fsPromises.writeFile(markerPath, `${new Date().toISOString()}\n`);
}

async function copyNativeArtifact(sourcePath: string, targetPath: string) {
  await fsPromises.rm(targetPath, { recursive: true, force: true });
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.cp(sourcePath, targetPath, {
    errorOnExist: false,
    force: true,
    recursive: true,
  });
}

async function restoreNativeArtifactFromCache(args: {
  architecture?: string | null;
  key?: string;
  targetPath: string;
}) {
  const key = args.key ?? nativeArtifactCacheKey(args.architecture);
  const paths = nativeArtifactCachePaths(key);
  if (!paths) {
    return false;
  }

  if (
    !fs.existsSync(paths.manifestPath) ||
    !fs.existsSync(paths.artifactPath)
  ) {
    logE2e("native artifact cache miss", {
      key: key.slice(0, 16),
      platform: session.platform,
      root: paths.root,
    });
    return false;
  }

  await copyNativeArtifact(paths.artifactPath, args.targetPath);
  logE2e("native artifact cache hit", {
    key: key.slice(0, 16),
    platform: session.platform,
    source: paths.artifactPath,
  });
  return true;
}

async function saveNativeArtifactToCache(args: {
  architecture?: string | null;
  key?: string;
  sourcePath: string;
}) {
  if (!fs.existsSync(args.sourcePath)) {
    return;
  }

  const key = args.key ?? nativeArtifactCacheKey(args.architecture);
  const paths = nativeArtifactCachePaths(key);
  if (!paths) {
    return;
  }

  const tempArtifactPath = `${paths.artifactPath}.tmp-${process.pid}-${Date.now()}`;
  await fsPromises.mkdir(paths.entryDir, { recursive: true });
  await copyNativeArtifact(args.sourcePath, tempArtifactPath);
  await fsPromises.rm(paths.artifactPath, { recursive: true, force: true });
  await fsPromises.rename(tempArtifactPath, paths.artifactPath);
  await fsPromises.writeFile(
    paths.manifestPath,
    `${JSON.stringify(
      {
        architecture: args.architecture ?? null,
        createdAt: new Date().toISOString(),
        key,
        platform: session.platform,
        sourcePath: args.sourcePath,
        version: NATIVE_ARTIFACT_CACHE_VERSION,
      },
      null,
      2,
    )}\n`,
  );
  logE2e("native artifact cache saved", {
    key: key.slice(0, 16),
    platform: session.platform,
    target: paths.artifactPath,
  });
}

async function buildNativeArtifactWithCacheLock(args: {
  architecture?: string | null;
  build: () => Promise<void>;
  key: string;
  logLabel: string;
  targetPath: string;
}) {
  const paths = nativeArtifactCachePaths(args.key);
  if (!paths) {
    await args.build();
    return;
  }

  await fsPromises.mkdir(paths.root, { recursive: true });
  const lockPath = path.join(
    paths.root,
    `${session.platform}-${args.key}.lock`,
  );
  const deadline = Date.now() + NATIVE_ARTIFACT_LOCK_TIMEOUT_MS;

  while (true) {
    let lockHandle: FileHandle | null = null;
    try {
      lockHandle = await fsPromises.open(lockPath, "wx");
      await lockHandle.writeFile(
        `${process.pid}\n${new Date().toISOString()}\n`,
      );
      logE2e("native artifact cache lock acquired", {
        key: args.key.slice(0, 16),
        label: args.logLabel,
        platform: session.platform,
      });

      const restored = await restoreNativeArtifactFromCache({
        architecture: args.architecture,
        key: args.key,
        targetPath: args.targetPath,
      });
      if (!restored) {
        await args.build();
        await saveNativeArtifactToCache({
          architecture: args.architecture,
          key: args.key,
          sourcePath: args.targetPath,
        });
      }
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }

      const restored = await restoreNativeArtifactFromCache({
        architecture: args.architecture,
        key: args.key,
        targetPath: args.targetPath,
      });
      if (restored) {
        logE2e("native artifact cache filled by concurrent process", {
          key: args.key.slice(0, 16),
          label: args.logLabel,
          platform: session.platform,
        });
        return;
      }

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for native artifact cache lock ${lockPath}`,
        );
      }
      await sleep(NATIVE_ARTIFACT_LOCK_RETRY_MS);
    } finally {
      if (lockHandle) {
        await lockHandle.close();
        await fsPromises.rm(lockPath, { force: true });
      }
    }
  }
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

    if (!(fixture.relativePath in session.multiAssetBackupPaths)) {
      session.multiAssetBackupPaths[fixture.relativePath] =
        await backupFile(assetPath);
    }

    await fsPromises.mkdir(path.dirname(assetPath), { recursive: true });
    await fsPromises.writeFile(
      assetPath,
      createMultiAssetBmpBuffer(`${marker}:${fixture.relativePath}`),
    );
  }

  logE2e("multi asset fixtures ready", {
    marker,
    paths: MULTI_ASSET_FIXTURES.map((fixture) => fixture.relativePath),
    sizeBytes: MULTI_ASSET_BMP_SIZE_BYTES,
  });
}

async function restoreMultiAssetFixtures() {
  for (const fixture of MULTI_ASSET_FIXTURES) {
    await restoreFile(
      session.multiAssetBackupPaths[fixture.relativePath] ?? null,
      path.join(EXAMPLE_DIR, fixture.relativePath),
    );
  }
}

async function ensureLargeArchiveAsset() {
  const existingStats = await fsPromises
    .stat(session.largeArchiveAssetPath)
    .catch(() => null);

  if (
    existingStats?.isFile() &&
    existingStats.size === LARGE_ARCHIVE_ASSET_SIZE_BYTES
  ) {
    return;
  }

  if (!session.largeArchiveAssetBackupPath) {
    session.largeArchiveAssetBackupPath = await backupFile(
      session.largeArchiveAssetPath,
    );
  }

  await writeDeterministicBmpFile(session.largeArchiveAssetPath);
  logE2e("large archive asset ready", {
    path: path.relative(REPO_DIR, session.largeArchiveAssetPath),
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
  const source = await fsPromises.readFile(session.appSourceFile, "utf8");

  if (!MARKER_PATTERN.test(source)) {
    throw new Error("Failed to locate E2E scenario marker in App.tsx");
  }
  if (!CRASH_GUARD_PATTERN.test(source)) {
    throw new Error("Failed to locate E2E crash guard markers in App.tsx");
  }
  if (!DEPLOY_ASSET_GUARD_PATTERN.test(source)) {
    throw new Error(
      "Failed to locate E2E deploy asset guard markers in App.tsx",
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
      `const E2E_SCENARIO_MARKER = ${JSON.stringify(marker)};`,
    )
    .replace(CRASH_GUARD_PATTERN, crashGuardSource)
    .replace(DEPLOY_ASSET_GUARD_PATTERN, deployAssetSource);

  await fsPromises.writeFile(session.appSourceFile, nextSource);
  logE2e("app scenario applied", {
    bundleProfile,
    marker,
    mode,
    safeBundleIds,
    sourceFile: path.relative(REPO_DIR, session.appSourceFile),
  });
}

async function applyDeployConfig({
  patchEnabled,
  patchMaxBaseBundles,
}: {
  patchEnabled: boolean;
  patchMaxBaseBundles?: number;
}) {
  const source = await fsPromises.readFile(session.configSourceFile, "utf8");

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
    session.configSourceFile,
    sourceWithDeployBaseUrl.replace(AUTO_PATCH_CONFIG_PATTERN, autoPatchSource),
  );
  logE2e("deploy config applied", {
    deployBaseUrl,
    patchEnabled,
    patchMaxBaseBundles: patchMaxBaseBundles ?? null,
    resetMetroCache: false,
    sourceFile: path.relative(REPO_DIR, session.configSourceFile),
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
  logE2e("hot-updater cli request", {
    command: `node ${[HOT_UPDATER_CLI_PATH, ...args].join(" ")}`,
    controlBaseUrl: getControllerReachableAppBaseUrl(),
  });

  const output = runCapture("node", [HOT_UPDATER_CLI_PATH, ...args], {
    cwd: session.exampleDir,
    env: getHotUpdaterControlEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });

  logE2e("hot-updater cli response", {
    command: args.join(" "),
    stdout: output,
  });

  return output;
}

async function runHotUpdaterCliLogged(args: string[], logName: string) {
  const logPath = path.join(session.resultsDir, logName);
  logE2e("hot-updater cli start", {
    command: `node ${[HOT_UPDATER_CLI_PATH, ...args].join(" ")}`,
    controlBaseUrl: getControllerReachableAppBaseUrl(),
    logPath: path.relative(REPO_DIR, logPath),
  });

  await runLogged("node", [HOT_UPDATER_CLI_PATH, ...args], {
    cwd: session.exampleDir,
    env: getHotUpdaterControlEnv(),
    logPath,
  });

  logE2e("hot-updater cli done", {
    command: args.join(" "),
  });
}

async function withDatabasePlugin<T>(
  callback: (databasePlugin: DatabasePlugin) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;

  for (
    let attempt = 1;
    attempt <= PROVIDER_OPERATION_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    const { loadConfig } =
      (await import("../../../packages/cli-tools/dist/index.mjs")) as {
        loadConfig: (
          options: null,
        ) => Promise<{ database: () => Promise<DatabasePlugin> }>;
      };
    const originalCwd = process.cwd();
    let databasePlugin: DatabasePlugin | null = null;

    try {
      process.chdir(session.exampleDir);
      return await withHotUpdaterControlEnv(async () => {
        const config = await loadConfig(null);
        databasePlugin = await config.database();
        return await callback(databasePlugin);
      });
    } catch (error) {
      lastError = error;
      if (
        attempt >= PROVIDER_OPERATION_RETRY_ATTEMPTS ||
        !isTransientProviderError(error)
      ) {
        throw error;
      }

      logE2e("provider database operation retry", {
        attempt,
        error: formatErrorMessage(error),
        platform: session.platform,
        retryDelayMs: PROVIDER_OPERATION_RETRY_DELAY_MS,
      });
      await sleep(PROVIDER_OPERATION_RETRY_DELAY_MS);
    } finally {
      await databasePlugin?.onUnmount?.();
      process.chdir(originalCwd);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchBundlesPage(args: {
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
    session.platform,
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
  logE2e("hot-updater cli bundle list", {
    channel: args.channel ?? null,
    count: bundles.data.length,
    limit: args.limit,
    platform: session.platform,
    total: bundles.pagination.total,
  });

  return bundles;
}

async function isBundleVisible(bundleId: string) {
  const bundles = await fetchBundlesPage({
    limit: 100,
    offset: 0,
  });
  return bundles.data.some((bundle) => bundle.id === bundleId);
}

async function fetchBundleById(bundleId: string) {
  const bundle = parseHotUpdaterCliJson<Bundle>(
    "bundle show",
    runHotUpdaterCliCapture(["bundle", "show", bundleId, "--json"]),
  );

  if (!bundle) {
    throw new Error(`Failed to fetch bundle ${bundleId}: bundle not found`);
  }

  logE2e("hot-updater cli bundle show", {
    bundleId: bundle.id,
    channel: bundle.channel,
    enabled: bundle.enabled,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
  });

  return bundle;
}

async function fetchEnabledBundlesFromDatabase(limit: number) {
  const bundles = await withDatabasePlugin(async (databasePlugin) => {
    const { data } = await databasePlugin.getBundles({
      limit,
      orderBy: {
        direction: "desc",
        field: "id",
      },
      where: {
        enabled: true,
        platform: session.platform,
      },
    });

    return data;
  });

  const normalized = normalizeBundleListEntries(bundles);
  logE2e("database enabled bundle list", {
    count: normalized.length,
    limit,
    platform: session.platform,
  });

  return normalized;
}

async function patchBundle(bundleId: string, patch: Partial<Bundle>) {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<Bundle>;
  const patchKeys = Object.keys(definedPatch);
  if (patchKeys.length > 0) {
    await withDatabasePlugin(async (databasePlugin) => {
      const bundle = await databasePlugin.getBundleById(bundleId);
      if (!bundle) {
        throw new Error(`No bundle with id ${bundleId}.`);
      }

      await databasePlugin.updateBundle(bundleId, definedPatch);
      await databasePlugin.commitBundle();

      const refetched = await databasePlugin.getBundleById(bundleId);
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

  logE2e("hot-updater direct bundle patch", {
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
  const bundle = await fetchBundleById(bundleId);
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

  if (
    bundle.id !== bundleId ||
    patchBaseBundleId !== baseBundleId ||
    !patchAssetPath ||
    !patchBaseFileHash ||
    !patchFileHash ||
    !patchStorageUri
  ) {
    throw createEndpointError(
      `Failed to resolve automatic bsdiff patch metadata for bundle ${bundleId}`,
      {
        autoPatch: true,
        baseBundleId,
        bundleId,
        observed: {
          bundleId: bundle.id,
          patchAssetPath,
          patchBaseBundleId,
          patchBaseFileHash,
          patchFileHash,
          patchStorageUri,
        },
      },
    );
  }

  logE2e("auto patch metadata resolved", {
    baseBundleId,
    bundleId,
    patchAssetPath,
    patchStorageUri,
    platform: session.platform,
  });

  return {
    baseBundleId,
    patchAssetPath,
  };
}

async function deleteBundle(bundleId: string) {
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
        path.join(session.resultsDir, logName),
      );
      if (!DELETE_VERIFY_STILL_EXISTS_PATTERN.test(logContents)) {
        throw error;
      }

      const stillVisible = await isBundleVisible(bundleId);
      if (!stillVisible) {
        logE2e("bundle delete verified after CLI retryable failure", {
          attempt,
          bundleId,
          platform: session.platform,
        });
        return;
      }

      if (attempt < REMOTE_BUNDLE_DELETE_ATTEMPTS) {
        logE2e("bundle delete verification still pending", {
          attempt,
          bundleId,
          platform: session.platform,
          retryDelayMs: REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS,
        });
        await sleep(REMOTE_BUNDLE_DELETE_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function clearRemoteBundles({
  mode = "delete",
}: { mode?: "delete" | "disable" } = {}) {
  const clearedBundleIds: string[] = [];
  const clearedIds = new Set<string>();

  while (true) {
    const nextBatch =
      mode === "disable"
        ? (await fetchEnabledBundlesFromDatabase(100)).filter(
            (bundle) => !clearedIds.has(bundle.id),
          )
        : (
            await fetchBundlesPage({
              limit: 100,
              offset: 0,
            })
          ).data.filter((bundle) => !clearedIds.has(bundle.id));

    if (nextBatch.length === 0) {
      break;
    }

    if (mode === "disable") {
      await withDatabasePlugin(async (databasePlugin) => {
        await Promise.all(
          nextBatch.map((bundle) =>
            databasePlugin.updateBundle(bundle.id, { enabled: false }),
          ),
        );
        await databasePlugin.commitBundle();

        const refetched = await Promise.all(
          nextBatch.map((bundle) => databasePlugin.getBundleById(bundle.id)),
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
        await deleteBundle(bundle.id);
        clearedIds.add(bundle.id);
        clearedBundleIds.push(bundle.id);
      }
    }
  }

  let remainingActiveBundle =
    mode === "delete"
      ? (
          await fetchBundlesPage({
            limit: 1,
            offset: 0,
          })
        ).data[0]
      : (await fetchEnabledBundlesFromDatabase(1))[0];

  if (remainingActiveBundle) {
    throw new Error(
      `Failed to clear remote bundles for platform ${session.platform}; bundle ${remainingActiveBundle.id} is still ${mode === "delete" ? "visible" : "enabled"} after reset`,
    );
  }

  logE2e("remote-bundles reset", {
    clearedBundleIds,
    clearedCount: clearedBundleIds.length,
    mode,
    platform: session.platform,
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
  const record = session.deployedBundles.find(
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
  if (session.storePath) {
    return session.storePath;
  }

  if (session.platform === "ios") {
    const appDataDir = runCapture("xcrun", [
      "simctl",
      "get_app_container",
      deviceId as string,
      session.appId,
      "data",
    ]);
    session.storePath = path.join(appDataDir, "Documents/bundle-store");
    return session.storePath;
  }

  session.storePath = `/data/data/${session.appId}/files/bundle-store`;
  return session.storePath;
}

async function clearIosLocalBundleState() {
  runCapture(
    "xcrun",
    ["simctl", "terminate", deviceId as string, session.appId],
    { allowFailure: true },
  );
  runCapture(
    "xcrun",
    [
      "simctl",
      "spawn",
      deviceId as string,
      "defaults",
      "delete",
      session.appId,
    ],
    { allowFailure: true },
  );

  const appDataDir = runCapture("xcrun", [
    "simctl",
    "get_app_container",
    deviceId as string,
    session.appId,
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

  logE2e("ios local bundle state reset", {
    documentsDir,
  });
}

function isIosAppInstalled() {
  const result = spawnSync(
    "xcrun",
    ["simctl", "get_app_container", deviceId as string, session.appId, "data"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return result.status === 0;
}

async function installIosArtifact(appPath: string) {
  session.storePath = undefined;
  runCapture(
    "xcrun",
    ["simctl", "uninstall", deviceId as string, session.appId],
    { allowFailure: true },
  );
  await runLogged("xcrun", ["simctl", "install", deviceId as string, appPath], {
    logPath: path.join(session.resultsDir, "simctl-install.log"),
  });
  await clearIosLocalBundleState();
}

async function prepareReusableIosArtifact(appPath: string, cacheKey: string) {
  session.storePath = undefined;
  if (!(await hasReuseAppInstallMarker(cacheKey)) || !isIosAppInstalled()) {
    await installIosArtifact(appPath);
    await writeReuseAppInstallMarker(cacheKey);
    return;
  }

  await clearIosLocalBundleState();
  logE2e("ios reusable app reset without reinstall", {
    appId: session.appId,
    artifactPath: path.relative(REPO_DIR, appPath),
  });
}

function iosDerivedDataCacheKeyPath() {
  return path.join(session.iosDerivedDataPath, IOS_DERIVED_DATA_CACHE_KEY_FILE);
}

async function readIosDerivedDataCacheKey() {
  try {
    return (
      await fsPromises.readFile(iosDerivedDataCacheKeyPath(), "utf8")
    ).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return null;
  }
}

async function writeIosDerivedDataCacheKey(cacheKey: string) {
  await fsPromises.mkdir(session.iosDerivedDataPath, { recursive: true });
  await fsPromises.writeFile(iosDerivedDataCacheKeyPath(), `${cacheKey}\n`);
}

const IOS_RETRYABLE_BUILD_PATTERNS = [
  /fatal error: 'glog\/logging\.h' file not found/,
  /fatal error: 'react\/renderer\/components\/view\/HostPlatformTouch\.h' file not found/,
];

async function shouldRetryIosReleaseBuild(logPath: string) {
  if (!fs.existsSync(logPath)) {
    return false;
  }

  const contents = await fsPromises.readFile(logPath, "utf8");
  return IOS_RETRYABLE_BUILD_PATTERNS.some((pattern) => pattern.test(contents));
}

async function prepareIosRelease() {
  const builtAppPath = path.join(
    session.iosDerivedDataPath,
    "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
  );
  const nativeCacheKey = nativeArtifactCacheKey();

  if (session.reuseApp && fs.existsSync(builtAppPath)) {
    const existingCacheKey = await readIosDerivedDataCacheKey();
    if (existingCacheKey === nativeCacheKey) {
      session.builtArtifactPath = builtAppPath;
      await prepareReusableIosArtifact(builtAppPath, nativeCacheKey);
      return;
    }

    logE2e("ios derived data cache key mismatch", {
      expected: nativeCacheKey.slice(0, 16),
      observed: existingCacheKey?.slice(0, 16) ?? null,
      path: session.iosDerivedDataPath,
    });
    await fsPromises.rm(session.iosDerivedDataPath, {
      force: true,
      recursive: true,
    });
  }

  if (!session.reuseApp) {
    await fsPromises.rm(session.iosDerivedDataPath, {
      force: true,
      recursive: true,
    });
  }

  if (
    await restoreNativeArtifactFromCache({
      key: nativeCacheKey,
      targetPath: builtAppPath,
    })
  ) {
    session.builtArtifactPath = builtAppPath;
    await writeIosDerivedDataCacheKey(nativeCacheKey);
    if (session.reuseApp) {
      await prepareReusableIosArtifact(builtAppPath, nativeCacheKey);
    } else {
      await installIosArtifact(builtAppPath);
    }
    return;
  }

  await fsPromises.rm(session.iosDerivedDataPath, {
    force: true,
    recursive: true,
  });

  await runLogged("bundle", ["install"], {
    cwd: path.join(session.exampleDir, "ios"),
    logPath: path.join(session.resultsDir, "bundle-install.log"),
  });

  await fsPromises.rm(
    path.join(session.exampleDir, "ios/Pods/ReactNativeDependencies-artifacts"),
    { force: true, recursive: true },
  );
  await fsPromises.rm(
    path.join(session.exampleDir, "ios/Pods/React-Core-prebuilt"),
    { force: true, recursive: true },
  );

  await runLogged("bundle", ["exec", "pod", "install", "--clean-install"], {
    cwd: path.join(session.exampleDir, "ios"),
    logPath: path.join(session.resultsDir, "pod-install.log"),
  });

  const xcodebuildLogPath = path.join(session.resultsDir, "xcodebuild.log");
  const getXcodebuildArgs = (serialized: boolean) => {
    const args = [
      "-workspace",
      path.join(session.exampleDir, "ios/HotUpdaterExample.xcworkspace"),
      "-scheme",
      "HotUpdaterExample",
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `id=${deviceId}`,
      "-derivedDataPath",
      session.iosDerivedDataPath,
      "ONLY_ACTIVE_ARCH=YES",
    ];

    if (serialized) {
      args.push("-jobs", "1");
    }

    args.push("build");
    return args;
  };

  try {
    await runLogged("xcodebuild", getXcodebuildArgs(false), {
      env: RELEASE_BUNDLE_ENV,
      logPath: xcodebuildLogPath,
    });
  } catch (error) {
    const shouldRetry = await shouldRetryIosReleaseBuild(xcodebuildLogPath);
    if (!shouldRetry) {
      throw error;
    }

    console.warn(
      "[maestro-e2e] retrying iOS release build after transient header resolution failure",
    );

    await fsPromises
      .rename(
        xcodebuildLogPath,
        path.join(session.resultsDir, "xcodebuild.attempt-1.log"),
      )
      .catch(() => {});
    await fsPromises.rm(session.iosDerivedDataPath, {
      force: true,
      recursive: true,
    });

    await runLogged("xcodebuild", getXcodebuildArgs(true), {
      env: RELEASE_BUNDLE_ENV,
      logPath: xcodebuildLogPath,
    });
  }

  session.builtArtifactPath = builtAppPath;
  await saveNativeArtifactToCache({
    key: nativeCacheKey,
    sourcePath: builtAppPath,
  });
  await writeIosDerivedDataCacheKey(nativeCacheKey);
  if (session.reuseApp) {
    await prepareReusableIosArtifact(builtAppPath, nativeCacheKey);
  } else {
    await installIosArtifact(builtAppPath);
  }
}

async function prepareAndroidRelease() {
  const defaultAndroidApkPath = path.join(
    session.exampleDir,
    DEFAULT_ANDROID_APK_RELATIVE_PATH,
  );
  const architecture = resolveAndroidE2eArchitecture();
  const nativeCacheKey = nativeArtifactCacheKey(architecture);

  if (!session.reuseApp || !fs.existsSync(session.androidApkPath)) {
    const restored = await restoreNativeArtifactFromCache({
      architecture,
      key: nativeCacheKey,
      targetPath: session.androidApkPath,
    });
    if (!restored) {
      await buildNativeArtifactWithCacheLock({
        architecture,
        build: () =>
          buildDebuggableAndroidRelease("gradle-release.log", architecture),
        key: nativeCacheKey,
        logLabel: "android-release",
        targetPath: session.androidApkPath,
      });
    }
  }

  session.builtArtifactPath = session.androidApkPath;
  session.storePath = undefined;

  if (session.reuseApp) {
    await prepareReusableAndroidArtifact("adb-install.log", nativeCacheKey);
  } else {
    runCapture("adb", ["-s", deviceId as string, "uninstall", session.appId], {
      allowFailure: true,
    });
    await installAndroidArtifact("adb-install.log");
  }

  if (session.reuseApp && !canRunAsAndroidApp()) {
    if (
      path.resolve(session.androidApkPath) !==
      path.resolve(defaultAndroidApkPath)
    ) {
      throw new Error(
        `Cannot reuse Android app because ${session.androidApkPath} is not debuggable. Rebuild it with HOT_UPDATER_E2E_DEBUGGABLE=true or run without --reuse-app.`,
      );
    }

    logE2e("android reused apk is not debuggable; rebuilding release apk");
    await buildNativeArtifactWithCacheLock({
      architecture,
      build: () =>
        buildDebuggableAndroidRelease("gradle-release-reuse.log", architecture),
      key: nativeCacheKey,
      logLabel: "android-release-reuse",
      targetPath: defaultAndroidApkPath,
    });
    session.builtArtifactPath = defaultAndroidApkPath;
    runCapture("adb", ["-s", deviceId as string, "uninstall", session.appId], {
      allowFailure: true,
    });
    await installAndroidArtifact("adb-install-reuse.log");
  }

  if (!canRunAsAndroidApp()) {
    throw new Error(
      "Android app must be debuggable so Maestro can inspect internal app files with run-as.",
    );
  }
}

async function buildDebuggableAndroidRelease(
  logFileName: string,
  architecture: string | null = resolveAndroidE2eArchitecture(),
) {
  const args = [
    ":app:assembleRelease",
    "--build-cache",
    "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
    ...(architecture ? [`-PreactNativeArchitectures=${architecture}`] : []),
  ];

  if (architecture) {
    logE2e("android e2e release build architecture", { architecture });
  }

  await runLogged("./gradlew", args, {
    cwd: path.join(session.exampleDir, "android"),
    env: RELEASE_BUNDLE_ENV,
    logPath: path.join(session.resultsDir, logFileName),
  });
}

function resolveAndroidE2eArchitecture() {
  try {
    const architecture = runCapture(
      "adb",
      ["-s", deviceId as string, "shell", "getprop", "ro.product.cpu.abi"],
      { allowFailure: true },
    )
      .replaceAll("\r", "")
      .trim();

    if (ANDROID_E2E_ARCHITECTURES.has(architecture)) {
      return architecture;
    }

    if (architecture) {
      logE2e("android e2e release build architecture ignored", {
        architecture,
      });
    }
  } catch (error) {
    logE2e("android e2e release build architecture detection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}

function ensureAndroidFilesDir() {
  return `/data/data/${session.appId}/files`;
}

function isAndroidAppInstalled() {
  const result = spawnSync(
    "adb",
    ["-s", deviceId as string, "shell", "pm", "path", session.appId],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return result.status === 0 && result.stdout.includes("package:");
}

function clearAndroidLocalAppState() {
  resetAndroidPackageData();
  runCapture(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      session.appId,
      "sh",
      "-c",
      [
        `rm -rf ${ensureAndroidFilesDir()}/bundle-store`,
        `${ensureAndroidFilesDir()}/bundle-temp`,
        `${ensureAndroidFilesDir()}/bundle-manifest-temp`,
        `/data/data/${session.appId}/shared_prefs/HotUpdaterPrefs_*.xml`,
      ].join(" "),
    ],
    { allowFailure: true },
  );
  if (androidPathExists(`${ensureAndroidFilesDir()}/bundle-store`)) {
    throw new Error("Failed to clear Android bundle-store state");
  }
  session.storePath = undefined;
  logE2e("android local app state reset", {
    appId: session.appId,
  });
}

function resetAndroidPackageData() {
  runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "am", "force-stop", session.appId],
    { allowFailure: true },
  );
  runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "pm", "clear", session.appId],
    { allowFailure: true },
  );
}

async function installAndroidArtifact(logFileName: string) {
  resetAndroidPackageData();
  await runLogged(
    "adb",
    [
      "-s",
      deviceId as string,
      "install",
      "-r",
      session.builtArtifactPath as string,
    ],
    {
      logPath: path.join(session.resultsDir, logFileName),
    },
  );
  runCapture(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      session.appId,
      "sh",
      "-c",
      [
        `rm -rf ${ensureAndroidFilesDir()}/bundle-store`,
        `${ensureAndroidFilesDir()}/bundle-temp`,
        `${ensureAndroidFilesDir()}/bundle-manifest-temp`,
        `/data/data/${session.appId}/shared_prefs/HotUpdaterPrefs_*.xml`,
      ].join(" "),
    ],
    { allowFailure: true },
  );
}

async function prepareReusableAndroidArtifact(
  logFileName: string,
  cacheKey: string,
) {
  if (!(await hasReuseAppInstallMarker(cacheKey)) || !isAndroidAppInstalled()) {
    await installAndroidArtifact(logFileName);
    await writeReuseAppInstallMarker(cacheKey);
    return;
  }

  clearAndroidLocalAppState();
}

function canRunAsAndroidApp() {
  const result = spawnSync(
    "adb",
    ["-s", deviceId as string, "shell", "run-as", session.appId, "true"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return result.status === 0;
}

function copyAndroidFile(remotePath: string, localPath: string) {
  let result = spawnSync(
    "adb",
    [
      "-s",
      deviceId as string,
      "exec-out",
      "run-as",
      session.appId,
      "cat",
      remotePath,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    result = spawnSync(
      "adb",
      [
        "-s",
        deviceId as string,
        "shell",
        "run-as",
        session.appId,
        "cat",
        remotePath,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  if (result.status !== 0) {
    result = spawnSync(
      "adb",
      ["-s", deviceId as string, "shell", "cat", remotePath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  if (result.status !== 0) {
    throw new Error(`Failed to read ${remotePath} from Android device`);
  }

  fs.writeFileSync(localPath, result.stdout);
}

function androidFileExists(remotePath: string) {
  return androidPathExists(remotePath, "-f");
}

function androidPathExists(remotePath: string, testFlag = "-e") {
  let exists = spawnSync(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      session.appId,
      "test",
      testFlag,
      remotePath,
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
  const stagingBundleId =
    (metadata.stagingBundleId as string | undefined) ??
    (metadata.staging_bundle_id as string | undefined) ??
    null;
  const verificationPending =
    (metadata.verificationPending as boolean | undefined) ??
    (metadata.verification_pending as boolean | undefined) ??
    null;

  if (stagingBundleId !== bundleId) {
    throw new Error(
      `Expected stagingBundleId ${bundleId} but received ${stagingBundleId}`,
    );
  }

  if (verificationPending !== false) {
    throw new Error(
      `Expected verificationPending false but received ${String(verificationPending)}`,
    );
  }
}

function assertMetadataReset(metadata: Record<string, unknown>) {
  const stableBundleId =
    (metadata.stableBundleId as string | undefined) ??
    (metadata.stable_bundle_id as string | undefined) ??
    null;
  const stagingBundleId =
    (metadata.stagingBundleId as string | undefined) ??
    (metadata.staging_bundle_id as string | undefined) ??
    null;
  const verificationPending =
    (metadata.verificationPending as boolean | undefined) ??
    (metadata.verification_pending as boolean | undefined) ??
    null;

  if (stableBundleId !== null) {
    throw new Error(
      `Expected stableBundleId null but received ${String(stableBundleId)}`,
    );
  }

  if (stagingBundleId !== null) {
    throw new Error(
      `Expected stagingBundleId null but received ${String(stagingBundleId)}`,
    );
  }

  if (verificationPending !== false) {
    throw new Error(
      `Expected verificationPending false but received ${String(verificationPending)}`,
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

function getMetadataState(metadata: Record<string, unknown> | null) {
  return {
    stableBundleId:
      (metadata?.stableBundleId as string | undefined) ??
      (metadata?.stable_bundle_id as string | undefined) ??
      null,
    stagingBundleId:
      (metadata?.stagingBundleId as string | undefined) ??
      (metadata?.staging_bundle_id as string | undefined) ??
      null,
    verificationPending:
      (metadata?.verificationPending as boolean | undefined) ??
      (metadata?.verification_pending as boolean | undefined) ??
      null,
  };
}

function isExpectedMetadataStateReached(
  metadataState: {
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
  const message = [
    "Timed out waiting for metadata state.",
    `Expected stagingBundleId=${args.bundleId} and verificationPending=${String(args.verificationPending)}.`,
    `${formatObservedMetadataState(observedState)}.`,
    `Metadata path: ${args.metadata.path}`,
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
    },
    platform: session.platform,
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
    "Expected stableBundleId=null, stagingBundleId=null, and verificationPending=false.",
    `Observed stableBundleId=${String(observedState.stableBundleId)} and ${formatObservedMetadataState(observedState)}.`,
    `Metadata path: ${args.metadata.path}`,
  ].join("\n");

  return createEndpointError(message, {
    attempts: args.attempts,
    expected: {
      stableBundleId: null,
      stagingBundleId: null,
      verificationPending: false,
    },
    observed: {
      crashHistory: args.crashHistory,
      launchReport: args.launchReport,
      metadata: args.metadata,
      metadataState: observedState,
    },
    platform: session.platform,
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

function readAndroidStoreSnapshot(
  remoteFileName: string,
  localFileName: string,
) {
  const storePath = ensureStorePath();
  const remotePath = `${storePath}/${remoteFileName}`;
  const localPath = path.join(session.resultsDir, localFileName);

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
    metadata: readAndroidStoreSnapshot(
      "metadata.json",
      "wait-for-metadata-metadata.json",
    ),
  };
}

function readWaitForMetadataDiagnostics() {
  return session.platform === "ios"
    ? readIosWaitForMetadataDiagnostics()
    : readAndroidWaitForMetadataDiagnostics();
}

function readBundleFileSnapshot(bundleId: string) {
  const bundleFileName =
    session.platform === "ios" ? "index.ios.bundle" : "index.android.bundle";
  const storePath = ensureStorePath();

  if (session.platform === "ios") {
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
  if (session.platform === "ios") {
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
  if (session.platform === "ios") {
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
  let result = spawnSync(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      session.appId,
      "sha256sum",
      remotePath,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    result = spawnSync(
      "adb",
      ["-s", deviceId as string, "shell", "sha256sum", remotePath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  if (result.status !== 0) {
    return {
      exists: false,
      fileHash: null,
      path: remotePath,
      readError: result.stderr.trim() || `sha256sum exited ${result.status}`,
    };
  }

  const fileHash = result.stdout.trim().split(/\s+/)[0] ?? null;
  return {
    exists: typeof fileHash === "string" && fileHash.length > 0,
    fileHash,
    path: remotePath,
    readError: null,
  };
}

function readBundleAssetFileHash(bundleId: string, assetPath: string) {
  return session.platform === "ios"
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
  const url = new URL(session.appBaseUrl);
  const androidReverseHostPort =
    session.platform === "android"
      ? process.env.HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT
      : undefined;
  if (androidReverseHostPort && /^\d+$/.test(androidReverseHostPort)) {
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

function getUrlPort(url: URL) {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function getAndroidReversePorts() {
  const appBaseUrl = new URL(session.appBaseUrl);
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
  if (session.platform !== "android") {
    return;
  }

  const reversePorts = getAndroidReversePorts();
  if (reversePorts === null) {
    return;
  }

  runCapture("adb", [
    "-s",
    deviceId as string,
    "reverse",
    `tcp:${reversePorts.devicePort}`,
    `tcp:${reversePorts.hostPort}`,
  ]);
  logE2e("android reverse ready", reversePorts);
}

function getHotUpdaterControlEnv(
  env: NodeJS.ProcessEnv | undefined = undefined,
) {
  return {
    ...env,
    HOT_UPDATER_APP_BASE_URL: getControllerReachableAppBaseUrl(),
  } satisfies NodeJS.ProcessEnv;
}

async function withHotUpdaterControlEnv<T>(callback: () => Promise<T>) {
  const hadAppBaseUrl = Object.prototype.hasOwnProperty.call(
    process.env,
    "HOT_UPDATER_APP_BASE_URL",
  );
  const previousAppBaseUrl = process.env.HOT_UPDATER_APP_BASE_URL;

  process.env.HOT_UPDATER_APP_BASE_URL = getControllerReachableAppBaseUrl();

  try {
    return await callback();
  } finally {
    if (hadAppBaseUrl) {
      process.env.HOT_UPDATER_APP_BASE_URL = previousAppBaseUrl;
    } else {
      delete process.env.HOT_UPDATER_APP_BASE_URL;
    }
  }
}

function buildAppVersionUpdateCheckUrl(args: {
  bundleId: string;
  channel: string;
  minBundleId: string;
}) {
  const encode = (value: string) => encodeURIComponent(value);
  return [
    getControllerReachableAppBaseUrl(),
    "app-version",
    encode(session.platform),
    encode(E2E_APP_VERSION),
    encode(args.channel),
    encode(args.minBundleId),
    encode(args.bundleId),
  ].join("/");
}

function getCurrentUpdateCheckBundleId() {
  const diagnostics = readWaitForMetadataDiagnostics();
  const metadataState = getMetadataState(diagnostics.metadata.value);
  return metadataState.stagingBundleId ?? NIL_UUID;
}

function shouldWaitForUpdateCheckVisibility(request: DeployBundleRequest) {
  return (
    request.disabled !== true &&
    typeof request.rollout !== "number" &&
    (!request.targetCohorts || request.targetCohorts.length === 0)
  );
}

async function waitForUpdateCheckVisibility(args: {
  bundleId: string;
  channel: string;
  requestBundleId: string;
}) {
  const minBundleId = NIL_UUID;
  const url = buildAppVersionUpdateCheckUrl({
    bundleId: args.requestBundleId,
    channel: args.channel,
    minBundleId,
  });
  let lastObserved: unknown = null;
  let lastError: string | null = null;

  for (let index = 0; index < 360; index += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "Hot-Updater-SDK-Version": "e2e",
        },
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
          logE2e("update check visibility ready", {
            bundleId: args.bundleId,
            channel: args.channel,
            requestBundleId: args.requestBundleId,
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

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  logE2e("update check visibility timeout", {
    expectedBundleId: args.bundleId,
    lastError,
    lastObserved,
    platform: session.platform,
    request: {
      bundleId: args.requestBundleId,
      channel: args.channel,
      minBundleId,
    },
    url,
  });

  throw createEndpointError(
    [
      "Timed out waiting for update check visibility.",
      `Expected update check to return bundleId=${args.bundleId}.`,
      `URL: ${url}`,
    ].join("\n"),
    {
      expected: {
        bundleId: args.bundleId,
      },
      lastError,
      lastObserved,
      platform: session.platform,
      request: {
        bundleId: args.requestBundleId,
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
    platform: session.platform,
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

function readAndroidRecoveryDiagnostics() {
  return {
    crashHistory: readAndroidStoreSnapshot(
      "crashed-history.json",
      "recovery-crash-history.json",
    ),
    crashMarker: readAndroidStoreSnapshot(
      "recovery-crash-marker.json",
      "recovery-crash-marker.json",
    ),
    launchReport: readAndroidStoreSnapshot(
      "launch-report.json",
      "recovery-launch-report.json",
    ),
    metadata: readAndroidStoreSnapshot(
      "metadata.json",
      "recovery-metadata.json",
    ),
  };
}

function launchAndroidApp() {
  const component = runCapture("adb", [
    "-s",
    deviceId as string,
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "--components",
    session.appId,
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!component) {
    throw new Error(`Failed to resolve launch activity for ${session.appId}`);
  }

  logE2e("android recovery relaunch", {
    appId: session.appId,
    component,
    deviceId,
  });
  runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "am", "start", "-W", "-n", component],
    {
      cwd: REPO_DIR,
    },
  );
}

function launchIosApp() {
  logE2e("ios metadata wait relaunch", {
    appId: session.appId,
    deviceId,
  });
  runCapture("xcrun", ["simctl", "launch", deviceId as string, session.appId], {
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
  const windowOutput = runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "dumpsys", "window", "windows"],
    { allowFailure: true },
  );
  const focusedWindowPackage = parseAndroidFocusedPackage(windowOutput);
  if (focusedWindowPackage) {
    return focusedWindowPackage;
  }

  const activityOutput = runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "dumpsys", "activity", "activities"],
    { allowFailure: true },
  );
  return parseAndroidFocusedPackage(activityOutput);
}

function getAndroidHomePackage() {
  const resolvedActivity = runCapture(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.HOME",
    ],
    { allowFailure: true },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  return resolvedActivity?.split("/")[0] ?? null;
}

async function waitForIosMetadataState(
  bundleId: string,
  verificationPending: boolean,
  attempts = E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH,
) {
  let totalAttempts = 0;

  for (
    let relaunchIndex = 0;
    relaunchIndex <= E2E_METADATA_WAIT_RELAUNCH_LIMIT;
    relaunchIndex += 1
  ) {
    for (let index = 0; index < attempts; index += 1) {
      totalAttempts += 1;

      const diagnostics = readIosWaitForMetadataDiagnostics();
      if (diagnostics.metadata.value) {
        const metadataState = getMetadataState(diagnostics.metadata.value);

        if (
          isExpectedMetadataStateReached(
            metadataState,
            bundleId,
            verificationPending,
          )
        ) {
          return;
        }
      }
      await sleep(E2E_POLL_INTERVAL_MS);
    }

    const diagnostics = readIosWaitForMetadataDiagnostics();
    const metadataState = getMetadataState(diagnostics.metadata.value);
    if (
      relaunchIndex === E2E_METADATA_WAIT_RELAUNCH_LIMIT ||
      metadataState.verificationPending === true
    ) {
      break;
    }

    logE2e("ios metadata wait retry", {
      expectedBundleId: bundleId,
      expectedVerificationPending: verificationPending,
      observed: metadataState,
      relaunchAttempt: relaunchIndex + 1,
      relaunchLimit: E2E_METADATA_WAIT_RELAUNCH_LIMIT,
    });
    await prepareAppLaunch();
    launchIosApp();
    await sleep(E2E_IOS_LAUNCH_SETTLE_MS);
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
  attempts = E2E_METADATA_WAIT_ATTEMPTS_PER_LAUNCH,
) {
  let totalAttempts = 0;

  for (
    let relaunchIndex = 0;
    relaunchIndex <= E2E_METADATA_WAIT_RELAUNCH_LIMIT;
    relaunchIndex += 1
  ) {
    for (let index = 0; index < attempts; index += 1) {
      totalAttempts += 1;

      const diagnostics = readAndroidWaitForMetadataDiagnostics();
      if (diagnostics.metadata.value) {
        const metadataState = getMetadataState(diagnostics.metadata.value);
        if (
          isExpectedMetadataStateReached(
            metadataState,
            bundleId,
            verificationPending,
          )
        ) {
          return;
        }
      }
      await sleep(E2E_POLL_INTERVAL_MS);
    }

    const diagnostics = readAndroidWaitForMetadataDiagnostics();
    const metadataState = getMetadataState(diagnostics.metadata.value);
    if (
      relaunchIndex === E2E_METADATA_WAIT_RELAUNCH_LIMIT ||
      metadataState.verificationPending === true
    ) {
      break;
    }

    logE2e("android metadata wait relaunch", {
      expectedBundleId: bundleId,
      expectedVerificationPending: verificationPending,
      observed: metadataState,
      relaunchAttempt: relaunchIndex + 1,
      relaunchLimit: E2E_METADATA_WAIT_RELAUNCH_LIMIT,
    });
    await prepareAppLaunch();
    launchAndroidApp();
    await sleep(E2E_ANDROID_LAUNCH_SETTLE_MS);
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
  attempts = 360,
) {
  let androidRelaunchAttempts = 0;

  for (let index = 0; index < attempts; index += 1) {
    const diagnostics =
      session.platform === "ios"
        ? readIosRecoveryDiagnostics()
        : readAndroidRecoveryDiagnostics();
    const metadataState = getMetadataState(diagnostics.metadata.value);
    const launchReportState = getLaunchReportState(
      diagnostics.launchReport.value,
    );

    if (
      metadataState.stagingBundleId === stableBundleId &&
      metadataState.verificationPending === false &&
      launchReportState.status === "RECOVERED" &&
      launchReportState.crashedBundleId === crashedBundleId
    ) {
      return {};
    }

    if (
      session.platform === "android" &&
      diagnostics.crashMarker.exists &&
      androidRelaunchAttempts < 3
    ) {
      launchAndroidApp();
      androidRelaunchAttempts += 1;
      await sleep(E2E_ANDROID_LAUNCH_SETTLE_MS);
      continue;
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const diagnostics =
    session.platform === "ios"
      ? readIosRecoveryDiagnostics()
      : readAndroidRecoveryDiagnostics();
  throw createWaitForRecoveryTimeoutError({
    attempts,
    crashedBundleId,
    ...diagnostics,
    stableBundleId,
  });
}

async function ensureAppForeground() {
  if (session.platform !== "android") {
    return {};
  }

  let focusedPackage = getAndroidFocusedPackage();
  const homePackage = getAndroidHomePackage();
  if (focusedPackage === session.appId) {
    return {};
  }

  logE2e("android ensure foreground", {
    focusedPackage,
    targetAppId: session.appId,
  });

  const recoverySteps: Array<{
    delayMs: number;
    label: string;
    run: () => Promise<void>;
  }> = [];

  if (focusedPackage && focusedPackage !== homePackage) {
    recoverySteps.push({
      delayMs: 750,
      label: "dismiss-dialog",
      run: async () => {
        runCapture(
          "adb",
          [
            "-s",
            deviceId as string,
            "shell",
            "input",
            "keyevent",
            "KEYCODE_BACK",
          ],
          { allowFailure: true },
        );
      },
    });
  }

  recoverySteps.push(
    {
      delayMs: 1500,
      label: "relaunch-app",
      run: async () => {
        launchAndroidApp();
      },
    },
    {
      delayMs: 2000,
      label: "home-and-relaunch",
      run: async () => {
        runCapture(
          "adb",
          [
            "-s",
            deviceId as string,
            "shell",
            "input",
            "keyevent",
            "KEYCODE_HOME",
          ],
          { allowFailure: true },
        );
        await sleep(E2E_POLL_INTERVAL_MS);
        launchAndroidApp();
      },
    },
  );

  for (const step of recoverySteps) {
    await step.run();
    await sleep(step.delayMs);
    focusedPackage = getAndroidFocusedPackage();

    if (focusedPackage === session.appId) {
      logE2e("android ensure foreground recovered", {
        recoveryStep: step.label,
        targetAppId: session.appId,
      });
      return {};
    }

    logE2e("android ensure foreground retry", {
      focusedPackage,
      recoveryStep: step.label,
      targetAppId: session.appId,
    });
  }

  throw new Error(
    `Failed to bring ${session.appId} to foreground (focused package: ${focusedPackage ?? "unknown"})`,
  );
}

async function prepareAppLaunch() {
  if (session.platform === "ios") {
    runCapture(
      "xcrun",
      ["simctl", "terminate", deviceId as string, session.appId],
      { allowFailure: true },
    );
    await sleep(E2E_POLL_INTERVAL_MS);
    return {};
  }

  if (session.platform !== "android") {
    return {};
  }

  const focusedPackage = getAndroidFocusedPackage();
  logE2e("android prepare app launch", {
    focusedPackage,
    targetAppId: session.appId,
  });

  ensureAndroidReverse();
  runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "am", "force-stop", session.appId],
    { allowFailure: true },
  );
  await sleep(E2E_POLL_INTERVAL_MS);

  return {};
}

async function bootstrap() {
  if (session.bootstrapResult) {
    logE2e("bootstrap result reused", {
      platform: session.platform,
    });
    return session.bootstrapResult;
  }

  if (!session.appBackupPath) {
    session.appBackupPath = await backupFile(session.appSourceFile);
  }
  if (!session.configBackupPath) {
    session.configBackupPath = await backupFile(session.configSourceFile);
  }
  if (
    !session.largeArchiveAssetBackupPath &&
    fs.existsSync(session.largeArchiveAssetPath)
  ) {
    session.largeArchiveAssetBackupPath = await backupFile(
      session.largeArchiveAssetPath,
    );
  }

  session.builtInBundleId = null;
  session.deployedBundles = [];
  session.storePath = null;

  await clearRemoteBundles({
    mode: session.reuseApp ? "disable" : "delete",
  });
  await restoreFile(
    session.largeArchiveAssetBackupPath,
    session.largeArchiveAssetPath,
  );
  await restoreMultiAssetFixtures();
  await restoreFile(session.configBackupPath, session.configSourceFile);
  await applyAppScenario({
    bundleProfile: "default",
    marker: session.initialMarker,
    mode: "reset",
    safeBundleIds: [],
  });

  if (session.platform === "ios") {
    await prepareIosRelease();
  } else {
    await prepareAndroidRelease();
  }

  session.bootstrapResult = {
    emptyCrashHistoryText: "No crashed bundles recorded\\.",
    initialMarker: session.initialMarker,
  };
  return session.bootstrapResult;
}

async function captureBuiltInBundleId() {
  const builtInBundleId = BUILT_IN_MIN_BUNDLE_ID_SUFFIX;

  session.builtInBundleId = builtInBundleId;

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
      platform: session.platform,
      safeBundleIds: request.safeBundleIds,
    }),
  );

  return {
    HOT_UPDATER_BARE_BUILD_CACHE_DIR: cacheRoot,
    HOT_UPDATER_BARE_BUILD_CACHE_KEY: cacheKey,
  };
}

async function deployBundle(request: DeployBundleRequest) {
  const bundleProfile = resolveBundleProfile(request.bundleProfile);
  const patchEnabled =
    request.diffBaseBundleId !== undefined ||
    request.patchMaxBaseBundles !== undefined;
  const updateCheckRequestBundleId = getCurrentUpdateCheckBundleId();

  if (bundleProfile === "archive300mb") {
    await ensureLargeArchiveAsset();
  }
  if (bundleProfile === "multiAssetReplacement") {
    await ensureMultiAssetFixtures(request.marker);
  }

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
    path.join(os.tmpdir(), "hu-maestro-deploy-"),
  );
  const args = [
    HOT_UPDATER_CLI_PATH,
    "deploy",
    "-p",
    session.platform,
    "-t",
    request.targetAppVersion,
    "-c",
    request.channel,
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
    session.resultsDir,
    `deploy-${request.channel}-${request.marker}.log`,
  );
  logE2e("deploy start", {
    bundleProfile,
    bareBuildCache: Boolean(bareBuildCacheRoot()),
    channel: request.channel,
    command: `node ${args.join(" ")}`,
    logPath: path.relative(REPO_DIR, deployLogPath),
    marker: request.marker,
    mode: request.mode,
    platform: session.platform,
    targetAppVersion: request.targetAppVersion,
  });
  const deployOutput = await runLogged("node", args, {
    cwd: session.exampleDir,
    env: getHotUpdaterControlEnv(bareBuildCacheEnv({ bundleProfile, request })),
    logPath: deployLogPath,
  });
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

      logE2e("deploy done", {
        archivePath: path.relative(REPO_DIR, archivePath),
        archiveSizeBytes: archiveStats.size,
        bundleProfile,
        channel: request.channel,
        logPath: path.relative(REPO_DIR, deployLogPath),
        marker: request.marker,
        mode: request.mode,
        platform: session.platform,
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
    await patchBundle(bundleId, {
      targetCohorts: request.targetCohorts,
    });
  }

  const diff =
    request.diffBaseBundleId !== undefined
      ? await resolveAutoPatchBundleDiff(request.diffBaseBundleId, bundleId)
      : null;
  const bundle = await fetchBundleById(bundleId);
  const patchBaseBundleIds = getBundlePatchBaseBundleIds(bundle);

  if (shouldWaitForUpdateCheckVisibility(request)) {
    await waitForUpdateCheckVisibility({
      bundleId,
      channel: bundle.channel,
      requestBundleId: updateCheckRequestBundleId,
    });
  }

  session.deployedBundles.push({
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
            session.platform === "ios"
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

async function updateBundle(request: PatchBundleRequest) {
  await patchBundle(request.bundleId, {
    enabled: request.enabled,
    rolloutCohortCount: request.rolloutCohortCount,
    shouldForceUpdate: request.shouldForceUpdate,
    targetCohorts: request.targetCohorts,
  });

  const bundle = await fetchBundleById(request.bundleId);
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
  const bundle = await fetchBundleById(bundleId);
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

async function waitForMetadata(bundleId: string, verificationPending: boolean) {
  if (session.platform === "ios") {
    await waitForIosMetadataState(bundleId, verificationPending);
  } else {
    await waitForAndroidMetadataState(bundleId, verificationPending);
  }

  return {};
}

function readBsdiffPatchLogs() {
  if (session.platform === "ios") {
    return runCapture(
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

  return runCapture(
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
  if (session.platform === "ios") {
    return runCapture(
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

  return runCapture(
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

function includesAllFragments(logs: string, fragments: string[]) {
  return fragments.every((fragment) => logs.includes(fragment));
}

function readBsdiffPatchStoreEvidence(args: {
  assetPath: string;
  baseBundleId: string;
}) {
  const record = session.deployedBundles.find(
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
  const manifest = readBundleManifestSnapshot(record.bundleId);
  const expectedHash = getManifestAssetFileHash(manifest, args.assetPath);
  const assetFile = readBundleAssetFileHash(record.bundleId, args.assetPath);
  const ok =
    metadataState.stableBundleId === args.baseBundleId &&
    metadataState.stagingBundleId === record.bundleId &&
    metadataState.verificationPending === false &&
    manifest.exists &&
    manifest.readError === null &&
    expectedHash !== null &&
    assetFile.exists &&
    assetFile.readError === null &&
    assetFile.fileHash === expectedHash;

  return {
    assetFile,
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
  return session.platform === "ios"
    ? "index.ios.bundle"
    : "index.android.bundle";
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
    session.deployedBundles.find((entry) => entry.bundleId === args.bundleId) ??
    null;
  const ok =
    metadataState.stableBundleId === args.previousBundleId &&
    metadataState.stagingBundleId === args.bundleId &&
    metadataState.verificationPending === false &&
    bundleFile.exists &&
    manifest.exists &&
    manifest.readError === null &&
    expectedHash !== null &&
    assetFile.exists &&
    assetFile.readError === null &&
    assetFile.fileHash === expectedHash &&
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
      logE2e("bundle assets stored", {
        assetPaths: args.assetPaths,
        bundleId: args.bundleId,
        evidence: "manifest-and-bundle-store",
        platform: session.platform,
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
      logE2e("multiple assets replaced", {
        assetPaths: args.assetPaths,
        bundleId: args.bundleId,
        evidence: "manifest-hash-change-and-bundle-store",
        platform: session.platform,
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
      logE2e("bsdiff patch applied", {
        assetPath: args.assetPath,
        baseBundleId: args.baseBundleId,
        bundleId: evidence.record.bundleId,
        evidence: includesAllFragments(logs, expectedFragments)
          ? "bundle-store-and-native-log"
          : "bundle-store",
        platform: session.platform,
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
      platform: session.platform,
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
      logE2e("manifest diff applied without bsdiff patch", {
        bundleId: args.bundleId,
        evidence: "bundle-store-without-archive-or-bsdiff-log",
        platform: session.platform,
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
      platform: session.platform,
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
      logE2e("first OTA used archive install path", {
        bundleId: args.bundleId,
        bundleFilePath: state.bundleFile.path,
        evidence: "bundle-store",
        metadataPath: state.diagnostics.metadata.path,
        platform: session.platform,
      });
      return {};
    }

    const logs = readFirstOtaArchiveInstallLogs();
    if (includesAllFragments(logs, expectedFragments)) {
      logE2e("first OTA used archive install path", {
        bundleId: args.bundleId,
        evidence: "native-log",
        platform: session.platform,
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
        stableBundleId: null,
        stagingBundleId: args.bundleId,
        verificationPending: true,
      },
      logsTail: logs.split("\n").slice(-20),
      observedState: {
        bundleFile: state.bundleFile,
        metadata: state.diagnostics.metadata,
        metadataState: state.metadataState,
      },
      platform: session.platform,
    },
  );
}

async function captureState(prefix: string) {
  const storePath = ensureStorePath();

  if (session.platform === "ios") {
    const metadataPath = path.join(storePath, "metadata.json");
    await waitForFile(metadataPath);
    await fsPromises.copyFile(
      metadataPath,
      path.join(session.resultsDir, `${prefix}-metadata.json`),
    );

    const launchReportPath = path.join(storePath, "launch-report.json");
    if (fs.existsSync(launchReportPath)) {
      await fsPromises.copyFile(
        launchReportPath,
        path.join(session.resultsDir, `${prefix}-launch-report.json`),
      );
    }

    const crashHistoryPath = path.join(storePath, "crashed-history.json");
    if (fs.existsSync(crashHistoryPath)) {
      await fsPromises.copyFile(
        crashHistoryPath,
        path.join(session.resultsDir, `${prefix}-crashed-history.json`),
      );
    } else if (prefix === "stable") {
      await fsPromises.writeFile(
        path.join(session.resultsDir, `${prefix}-crashed-history.json`),
        JSON.stringify(EMPTY_CRASH_HISTORY, null, 2),
      );
    }

    return {};
  }

  copyAndroidFile(
    `${storePath}/metadata.json`,
    path.join(session.resultsDir, `${prefix}-metadata.json`),
  );

  if (
    !copyAndroidFileIfExists(
      `${storePath}/crashed-history.json`,
      path.join(session.resultsDir, `${prefix}-crashed-history.json`),
    ) &&
    prefix === "stable"
  ) {
    await fsPromises.writeFile(
      path.join(session.resultsDir, `${prefix}-crashed-history.json`),
      JSON.stringify(EMPTY_CRASH_HISTORY, null, 2),
    );
  }

  copyAndroidFileIfExists(
    `${storePath}/launch-report.json`,
    path.join(session.resultsDir, `${prefix}-launch-report.json`),
  );

  return {};
}

async function reinstallBuiltInApp() {
  if (!session.builtArtifactPath) {
    throw new Error("builtArtifactPath is not available");
  }

  session.storePath = null;

  if (session.platform === "ios") {
    if (session.reuseApp) {
      await prepareReusableIosArtifact(
        session.builtArtifactPath,
        nativeArtifactCacheKey(),
      );
    } else {
      await installIosArtifact(session.builtArtifactPath);
    }
  } else {
    if (session.reuseApp) {
      await prepareReusableAndroidArtifact(
        "adb-install-reset.log",
        nativeArtifactCacheKey(resolveAndroidE2eArchitecture()),
      );
    } else {
      runCapture(
        "adb",
        ["-s", deviceId as string, "uninstall", session.appId],
        {
          allowFailure: true,
        },
      );
      await installAndroidArtifact("adb-install-reset.log");
    }
  }

  logE2e("built-in app reinstalled", {
    appId: session.appId,
    artifactPath: path.relative(REPO_DIR, session.builtArtifactPath),
    platform: session.platform,
  });

  return {};
}

async function resetRemoteBundles() {
  await clearRemoteBundles({
    mode: session.reuseApp ? "disable" : "delete",
  });

  logE2e("remote bundles reset on demand", {
    platform: session.platform,
  });

  return {};
}

async function resetLocalAppState() {
  if (session.platform === "ios") {
    await clearIosLocalBundleState();
  } else {
    clearAndroidLocalAppState();
  }

  logE2e("local app state reset on demand", {
    platform: session.platform,
  });

  return {};
}

async function assertBundlePatchBases(args: {
  absentBaseBundleIds?: string[];
  bundleId: string;
  expectedBaseBundleIds?: string[];
}) {
  const bundle = await fetchBundleById(args.bundleId);
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
        platform: session.platform,
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
        platform: session.platform,
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
        platform: session.platform,
        unexpectedBaseBundleIds,
      },
    );
  }

  logE2e("bundle patch bases verified", {
    bundleId: args.bundleId,
    observedBaseBundleIds,
    platform: session.platform,
  });

  return {
    observedBaseBundleIds,
  };
}

async function assertMetadataActive(bundleId: string) {
  const metadata =
    session.platform === "ios"
      ? readJson(path.join(ensureStorePath(), "metadata.json"))
      : (() => {
          const probePath = path.join(
            session.resultsDir,
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
      session.platform === "ios"
        ? readIosWaitForMetadataDiagnostics()
        : readAndroidWaitForMetadataDiagnostics();

    if (diagnostics.metadata.value) {
      try {
        assertMetadataReset(diagnostics.metadata.value);
        return {};
      } catch {}
    }

    await sleep(E2E_POLL_INTERVAL_MS);
  }

  const diagnostics =
    session.platform === "ios"
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
  status,
}: LaunchReportAssertion) {
  const launchReportPath =
    session.platform === "ios"
      ? path.join(ensureStorePath(), "launch-report.json")
      : path.join(session.resultsDir, "launch-report-assert.json");

  if (session.platform === "android") {
    if (
      !copyAndroidFileIfExists(
        `${ensureStorePath()}/launch-report.json`,
        launchReportPath,
      )
    ) {
      if (optional) {
        return {};
      }
      throw new Error("launch-report.json is missing");
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
    session.platform === "ios"
      ? path.join(ensureStorePath(), "crashed-history.json")
      : path.join(session.resultsDir, "crash-history-assert.json");

  if (session.platform === "android") {
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
    path.join(session.resultsDir, "summary.json"),
    JSON.stringify(
      {
        binaryType: "Release",
        builtInBundleId: session.builtInBundleId,
        deployedBundles: session.deployedBundles,
        platform: session.platform,
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
  if (!session.appBackupPath) {
    return {};
  }

  if (session.appBackupPath) {
    await restoreFile(session.appBackupPath, session.appSourceFile);
  }
  if (session.configBackupPath) {
    await restoreFile(session.configBackupPath, session.configSourceFile);
  }
  await restoreFile(
    session.largeArchiveAssetBackupPath,
    session.largeArchiveAssetPath,
  );
  await restoreMultiAssetFixtures();

  session.appBackupPath = null;
  session.configBackupPath = null;
  session.largeArchiveAssetBackupPath = null;
  session.multiAssetBackupPaths = {};
  return {};
}

function createJob(task: () => Promise<JobResult>) {
  const jobId = randomUUID();
  jobs.set(jobId, { status: "running" });

  void task()
    .then((result) => {
      jobs.set(jobId, { result, status: "succeeded" });
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Unknown E2E job failure";
      logE2e("control job failed", {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      jobs.set(jobId, { error: message, status: "failed" });
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
  return createJob(() => deployBundle(request));
}

export function startPatchBundleJob(request: PatchBundleRequest) {
  return createJob(() => updateBundle(request));
}

export function startWaitForMetadataJob(
  bundleId: string,
  verificationPending: boolean,
) {
  return createJob(() => waitForMetadata(bundleId, verificationPending));
}

export function getJob(jobId: string) {
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
) {
  return waitForMetadata(bundleId, verificationPending);
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

export async function handleReinstallBuiltInApp() {
  return reinstallBuiltInApp();
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
) {
  return waitForCrashRecovery(stableBundleId, crashedBundleId);
}

export async function handleEnsureAppForeground() {
  return ensureAppForeground();
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
