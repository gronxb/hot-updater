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

type Platform = "ios" | "android";
type BundleProfile = "archive300mb" | "default";

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
  builtInBundleId: string | null;
  configBackupPath: string | null;
  configSourceFile: string;
  deployedBundles: DeployedBundleRecord[];
  exampleDir: string;
  initialMarker: string;
  iosDerivedDataPath: string;
  largeArchiveAssetBackupPath: string | null;
  largeArchiveAssetPath: string;
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
  platform,
  resultsDir,
  reuseApp: process.env.HOT_UPDATER_E2E_REUSE_APP === "true",
  storePath: null,
};

const jobs = new Map<string, JobState>();

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
  const deployAssetSource =
    bundleProfile === "archive300mb"
      ? [
          DEPLOY_ASSET_GUARD_START,
          `  void Image.resolveAssetSource(require(${JSON.stringify(LARGE_ARCHIVE_ASSET_REQUIRE_PATH)}));`,
          `  ${DEPLOY_ASSET_GUARD_END}`,
        ].join("\n")
      : `${DEPLOY_ASSET_GUARD_START}\n  ${DEPLOY_ASSET_GUARD_END}`;

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

  await fsPromises.writeFile(
    session.configSourceFile,
    source.replace(AUTO_PATCH_CONFIG_PATTERN, autoPatchSource),
  );
  logE2e("deploy config applied", {
    patchEnabled,
    patchMaxBaseBundles: patchMaxBaseBundles ?? null,
    sourceFile: path.relative(REPO_DIR, session.configSourceFile),
  });
}

async function waitForFile(filePath: string, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(1000);
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
  });

  const output = runCapture("node", [HOT_UPDATER_CLI_PATH, ...args], {
    cwd: session.exampleDir,
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
    logPath: path.relative(REPO_DIR, logPath),
  });

  await runLogged("node", [HOT_UPDATER_CLI_PATH, ...args], {
    cwd: session.exampleDir,
    logPath,
  });

  logE2e("hot-updater cli done", {
    command: args.join(" "),
  });
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

async function fetchLatestBundle(args: { channel?: string }) {
  const bundles = await fetchBundlesPage({
    channel: args.channel,
    limit: 1,
    offset: 0,
  });
  const latestBundle = bundles.data[0];

  if (!latestBundle?.id) {
    throw new Error(`No bundles found for platform ${session.platform}`);
  }

  return latestBundle.id;
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

async function patchBundle(bundleId: string, patch: Partial<Bundle>) {
  if (patch.enabled !== undefined) {
    await runHotUpdaterCliLogged(
      ["bundle", patch.enabled ? "enable" : "disable", bundleId, "-y"],
      `bundle-${patch.enabled ? "enable" : "disable"}-${bundleId}.log`,
    );
  }

  const updateArgs = ["bundle", "update", bundleId, "-y", "--json"];
  if (patch.rolloutCohortCount !== undefined) {
    if (patch.rolloutCohortCount === null) {
      throw new Error("Cannot clear rolloutCohortCount through E2E CLI patch");
    }
    updateArgs.push("--rollout-cohort-count", String(patch.rolloutCohortCount));
  }
  if (patch.shouldForceUpdate !== undefined) {
    updateArgs.push("--force-update", String(patch.shouldForceUpdate));
  }
  if (patch.targetCohorts !== undefined) {
    if (patch.targetCohorts === null) {
      updateArgs.push("--clear-target-cohorts");
    } else {
      updateArgs.push("--target-cohorts", patch.targetCohorts.join(","));
    }
  }

  if (updateArgs.length > 5) {
    parseHotUpdaterCliJson<Bundle>(
      "bundle update",
      runHotUpdaterCliCapture(updateArgs),
    );
  }

  logE2e("hot-updater cli bundle patch", {
    bundleId,
    patch,
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
  await runHotUpdaterCliLogged(
    ["bundle", "delete", bundleId, "-y"],
    `bundle-delete-${bundleId}.log`,
  );
}

async function clearRemoteBundles() {
  const deletedBundleIds: string[] = [];
  const deletedIds = new Set<string>();

  while (true) {
    const bundles = await fetchBundlesPage({
      limit: 100,
      offset: 0,
    });
    const nextBatch = bundles.data.filter(
      (bundle) => !deletedIds.has(bundle.id),
    );

    if (nextBatch.length === 0) {
      break;
    }

    for (const bundle of nextBatch) {
      await deleteBundle(bundle.id);
      deletedIds.add(bundle.id);
      deletedBundleIds.push(bundle.id);
    }
  }

  const remainingBundles = await fetchBundlesPage({
    limit: 1,
    offset: 0,
  });

  if (remainingBundles.data.length > 0) {
    throw new Error(
      `Failed to clear remote bundles for platform ${session.platform}; bundle ${remainingBundles.data[0].id} is still visible after reset`,
    );
  }

  logE2e("remote-bundles reset", {
    deletedBundleIds,
    deletedCount: deletedBundleIds.length,
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

  logE2e("ios local bundle state reset", {
    documentsDir,
  });
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

  if (session.reuseApp) {
    if (!fs.existsSync(builtAppPath)) {
      throw new Error(
        `Cannot reuse iOS app because ${builtAppPath} does not exist`,
      );
    }
    session.builtArtifactPath = builtAppPath;
    await installIosArtifact(builtAppPath);
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
    ];

    if (serialized) {
      args.push("-jobs", "1");
    }

    args.push("build");
    return args;
  };

  try {
    await runLogged("xcodebuild", getXcodebuildArgs(false), {
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
      logPath: xcodebuildLogPath,
    });
  }

  session.builtArtifactPath = builtAppPath;
  await installIosArtifact(builtAppPath);
}

async function prepareAndroidRelease() {
  const defaultAndroidApkPath = path.join(
    session.exampleDir,
    DEFAULT_ANDROID_APK_RELATIVE_PATH,
  );

  if (!session.reuseApp) {
    await buildDebuggableAndroidRelease("gradle-release.log");
  } else if (!fs.existsSync(session.androidApkPath)) {
    throw new Error(
      `Cannot reuse Android app because ${session.androidApkPath} does not exist`,
    );
  }

  session.builtArtifactPath = session.androidApkPath;
  session.storePath = undefined;

  runCapture("adb", ["-s", deviceId as string, "uninstall", session.appId], {
    allowFailure: true,
  });
  await installAndroidArtifact("adb-install.log");

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
    await buildDebuggableAndroidRelease("gradle-release-reuse.log");
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

async function buildDebuggableAndroidRelease(logFileName: string) {
  await runLogged(
    "./gradlew",
    [
      ":app:assembleRelease",
      "--rerun-tasks",
      "-PHOT_UPDATER_E2E_DEBUGGABLE=true",
    ],
    {
      cwd: path.join(session.exampleDir, "android"),
      logPath: path.join(session.resultsDir, logFileName),
    },
  );
}

function ensureAndroidFilesDir() {
  return `/data/data/${session.appId}/files`;
}
async function installAndroidArtifact(logFileName: string) {
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
      "rm",
      "-rf",
      `${ensureAndroidFilesDir()}/bundle-store`,
      `${ensureAndroidFilesDir()}/bundle-temp`,
      `${ensureAndroidFilesDir()}/bundle-manifest-temp`,
    ],
    { allowFailure: true },
  );
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
  let exists = spawnSync(
    "adb",
    [
      "-s",
      deviceId as string,
      "shell",
      "run-as",
      session.appId,
      "test",
      "-f",
      remotePath,
    ],
    { stdio: "ignore" },
  );

  if (exists.status !== 0) {
    exists = spawnSync(
      "adb",
      ["-s", deviceId as string, "shell", "[", "-f", remotePath, "]"],
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
  if (
    url.hostname === "localhost" ||
    url.hostname === "10.0.2.2" ||
    url.hostname === "10.0.3.2"
  ) {
    url.hostname = "127.0.0.1";
  }
  return url.toString().replace(/\/+$/, "");
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

  for (let index = 0; index < 90; index += 1) {
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

    await sleep(1000);
  }

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
  attempts = 90,
) {
  for (let index = 0; index < attempts; index += 1) {
    const diagnostics = readIosWaitForMetadataDiagnostics();
    if (diagnostics.metadata.value) {
      const metadataState = getMetadataState(diagnostics.metadata.value);

      if (
        metadataState.stagingBundleId === bundleId &&
        metadataState.verificationPending === verificationPending
      ) {
        return;
      }
    }
    await sleep(1000);
  }

  throw createWaitForMetadataTimeoutError({
    attempts,
    bundleId,
    ...readIosWaitForMetadataDiagnostics(),
    verificationPending,
  });
}

async function waitForAndroidMetadataState(
  bundleId: string,
  verificationPending: boolean,
  attempts = 90,
) {
  const relaunchLimit = 2;
  let totalAttempts = 0;

  for (
    let relaunchIndex = 0;
    relaunchIndex <= relaunchLimit;
    relaunchIndex += 1
  ) {
    for (let index = 0; index < attempts; index += 1) {
      totalAttempts += 1;

      const diagnostics = readAndroidWaitForMetadataDiagnostics();
      if (diagnostics.metadata.value) {
        const metadataState = getMetadataState(diagnostics.metadata.value);
        if (
          metadataState.stagingBundleId === bundleId &&
          metadataState.verificationPending === verificationPending
        ) {
          return;
        }
      }
      await sleep(1000);
    }

    const diagnostics = readAndroidWaitForMetadataDiagnostics();
    const metadataState = getMetadataState(diagnostics.metadata.value);
    if (
      relaunchIndex === relaunchLimit ||
      metadataState.verificationPending === true
    ) {
      break;
    }

    logE2e("android metadata wait relaunch", {
      expectedBundleId: bundleId,
      expectedVerificationPending: verificationPending,
      observed: metadataState,
      relaunchAttempt: relaunchIndex + 1,
      relaunchLimit,
    });
    await prepareAppLaunch();
    launchAndroidApp();
    await sleep(3000);
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
  attempts = 90,
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
      await sleep(2000);
      continue;
    }

    await sleep(1000);
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
        await sleep(500);
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
  if (session.platform !== "android") {
    return {};
  }

  const focusedPackage = getAndroidFocusedPackage();
  logE2e("android prepare app launch", {
    focusedPackage,
    targetAppId: session.appId,
  });

  runCapture(
    "adb",
    ["-s", deviceId as string, "shell", "am", "force-stop", session.appId],
    { allowFailure: true },
  );
  await sleep(500);

  return {};
}

async function bootstrap() {
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

  await clearRemoteBundles();
  await restoreFile(
    session.largeArchiveAssetBackupPath,
    session.largeArchiveAssetPath,
  );
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

  return {
    emptyCrashHistoryText: "No crashed bundles recorded\\.",
    initialMarker: session.initialMarker,
  };
}

async function captureBuiltInBundleId() {
  const builtInBundleId = BUILT_IN_MIN_BUNDLE_ID_SUFFIX;

  session.builtInBundleId = builtInBundleId;

  return { builtInBundleId };
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
    channel: request.channel,
    command: `node ${args.join(" ")}`,
    logPath: path.relative(REPO_DIR, deployLogPath),
    marker: request.marker,
    mode: request.mode,
    platform: session.platform,
    targetAppVersion: request.targetAppVersion,
  });
  await runLogged("node", args, {
    cwd: session.exampleDir,
    logPath: deployLogPath,
  });

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

  const bundleId = await fetchLatestBundle({
    channel: request.channel,
  });

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

async function assertBsdiffPatchApplied(args: {
  assetPath: string;
  baseBundleId: string;
}) {
  const expectedFragments = [
    "HotUpdaterBsdiffPatchApplied",
    `asset=${args.assetPath}`,
    `baseBundleId=${args.baseBundleId}`,
  ];

  for (let attempt = 0; attempt < 10; attempt += 1) {
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

    await sleep(1000);
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
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

    await sleep(1000);
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

  for (let attempt = 0; attempt < 10; attempt += 1) {
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

    await sleep(1000);
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
    await installIosArtifact(session.builtArtifactPath);
  } else {
    runCapture("adb", ["-s", deviceId as string, "uninstall", session.appId], {
      allowFailure: true,
    });
    await installAndroidArtifact("adb-install-reset.log");
  }

  logE2e("built-in app reinstalled", {
    appId: session.appId,
    artifactPath: path.relative(REPO_DIR, session.builtArtifactPath),
    platform: session.platform,
  });

  return {};
}

async function resetRemoteBundles() {
  await clearRemoteBundles();

  logE2e("remote bundles reset on demand", {
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
  const attempts = 30;

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

    await sleep(1000);
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

  session.appBackupPath = null;
  session.configBackupPath = null;
  session.largeArchiveAssetBackupPath = null;
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
      jobs.set(jobId, { error: message, status: "failed" });
    });

  return jobId;
}

export function startBootstrapJob() {
  return createJob(() => bootstrap());
}

export function startDeployBundleJob(request: DeployBundleRequest) {
  return createJob(() => deployBundle(request));
}

export function startPatchBundleJob(request: PatchBundleRequest) {
  return createJob(() => updateBundle(request));
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
