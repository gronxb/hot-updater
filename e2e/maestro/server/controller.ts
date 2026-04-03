import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath, pathToFileURL } from "url";
import { getRolledOutNumericCohorts } from "../../../packages/core/src/rollout.js";

type Platform = "ios" | "android";

type JobResult = Record<string, unknown>;

type JobState = {
  error?: string;
  result?: JobResult;
  status: "failed" | "running" | "succeeded";
};

type DeployMode = "crash" | "reset";

type DeployedBundleRecord = {
  bundleId: string;
  channel: string;
  enabled: boolean;
  marker: string;
  mode: DeployMode;
  rolloutCohortCount: number | null;
  shouldForceUpdate: boolean;
  targetCohorts: string[] | null;
};

type SessionState = {
  androidApkPath: string;
  appBackupPath: string | null;
  appId: string;
  appSourceFile: string;
  builtArtifactPath: string | null;
  builtInBundleId: string | null;
  consoleApiBaseUrl: string;
  deployedBundles: DeployedBundleRecord[];
  exampleDir: string;
  initialMarker: string;
  iosDerivedDataPath: string;
  platform: Platform;
  resultsDir: string;
  reuseApp: boolean;
  storePath: string | null;
};

type DeployBundleRequest = {
  channel: string;
  disabled?: boolean;
  forceUpdate?: boolean;
  marker: string;
  message?: string;
  mode: DeployMode;
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

type ConsoleServerFnName =
  | "deleteBundle"
  | "getBundle"
  | "getBundles"
  | "updateBundle";

type ServerFnFetcher = (
  url: string,
  args: Array<{
    data?: unknown;
    method: "GET" | "POST";
  }>,
  handler: typeof fetch,
) => Promise<unknown>;

type ServerFnResultEnvelope<T> = {
  error?: unknown;
  result?: T;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../../..");
const PNPM_STORE_DIR = path.join(REPO_DIR, "node_modules/.pnpm");
const CONSOLE_SSR_DIR = path.join(REPO_DIR, "packages/console/.output/server/_ssr");
const EXAMPLE_DIR = path.join(REPO_DIR, "examples/v0.81.0");
const APP_SOURCE_FILE = path.join(EXAMPLE_DIR, "App.tsx");
const EMPTY_CRASH_HISTORY = {
  bundles: [],
  maxHistorySize: 10,
};
const CRASH_GUARD_START = "/* E2E_CRASH_GUARD_START */";
const CRASH_GUARD_END = "/* E2E_CRASH_GUARD_END */";
const CRASH_GUARD_PATTERN =
  /\/\* E2E_CRASH_GUARD_START \*\/[\s\S]*?\/\* E2E_CRASH_GUARD_END \*\//;
const MARKER_PATTERN = /const E2E_SCENARIO_MARKER = ".*?";/;
const BUILT_IN_MIN_BUNDLE_ID_SUFFIX = "7000-8000-000000000000";
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
const consoleBaseUrl = process.env.HOT_UPDATER_E2E_CONSOLE_BASE_URL;
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
if (!consoleBaseUrl) {
  throw new Error("HOT_UPDATER_E2E_CONSOLE_BASE_URL is required");
}

const session: SessionState = {
  androidApkPath: path.isAbsolute(
    process.env.HOT_UPDATER_E2E_ANDROID_APK_PATH ??
      "android/app/build/outputs/apk/release/app-release.apk",
  )
    ? (process.env.HOT_UPDATER_E2E_ANDROID_APK_PATH as string)
    : path.join(
        EXAMPLE_DIR,
        process.env.HOT_UPDATER_E2E_ANDROID_APK_PATH ??
          "android/app/build/outputs/apk/release/app-release.apk",
      ),
  appBackupPath: null,
  appId,
  appSourceFile: APP_SOURCE_FILE,
  builtArtifactPath: null,
  builtInBundleId: null,
  consoleApiBaseUrl: consoleBaseUrl,
  deployedBundles: [],
  exampleDir: EXAMPLE_DIR,
  initialMarker:
    platform === "ios" ? "builtin-ios-maestro" : "builtin-android-maestro",
  iosDerivedDataPath:
    process.env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH ??
    "/tmp/hotupdater-v081-ios-maestro",
  platform,
  resultsDir,
  reuseApp: process.env.HOT_UPDATER_E2E_REUSE_APP === "true",
  storePath: null,
};

const jobs = new Map<string, JobState>();
let consoleServerFnIdsPromise:
  | Promise<Record<ConsoleServerFnName, string>>
  | null = null;
let tanstackServerFnFetcherPromise: Promise<ServerFnFetcher> | null = null;

function runCapture(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
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

async function findConsoleApiRpcChunkPath() {
  const entries = await fsPromises.readdir(CONSOLE_SSR_DIR);
  const chunkName = entries
    .filter((entry) => entry.startsWith("api-rpc-") && entry.endsWith(".mjs"))
    .sort()[0];

  if (!chunkName) {
    throw new Error(
      `Failed to locate console api-rpc chunk in ${CONSOLE_SSR_DIR}`,
    );
  }

  return path.join(CONSOLE_SSR_DIR, chunkName);
}

function extractConsoleServerFnId(
  source: string,
  serverFnName: ConsoleServerFnName,
) {
  const pattern = new RegExp(
    `${serverFnName}_createServerFn_handler = createServerRpc\\(\\{\\s*id: "([a-f0-9]+)"`,
  );
  const match = source.match(pattern);

  if (!match?.[1]) {
    throw new Error(`Failed to resolve TanStack server function id for ${serverFnName}`);
  }

  return match[1];
}

async function loadConsoleServerFnIds() {
  const source = await fsPromises.readFile(await findConsoleApiRpcChunkPath(), "utf8");

  return {
    deleteBundle: extractConsoleServerFnId(source, "deleteBundle"),
    getBundle: extractConsoleServerFnId(source, "getBundle"),
    getBundles: extractConsoleServerFnId(source, "getBundles"),
    updateBundle: extractConsoleServerFnId(source, "updateBundle"),
  };
}

async function getConsoleServerFnIds() {
  if (!consoleServerFnIdsPromise) {
    consoleServerFnIdsPromise = loadConsoleServerFnIds();
  }

  return consoleServerFnIdsPromise;
}

async function loadTanstackServerFnFetcher() {
  const entries = await fsPromises.readdir(PNPM_STORE_DIR);
  const packageDir = entries
    .filter((entry) => entry.startsWith("@tanstack+start-client-core@"))
    .sort()[0];

  if (!packageDir) {
    throw new Error("Failed to locate @tanstack/start-client-core in pnpm store");
  }

  const modulePath = path.join(
    PNPM_STORE_DIR,
    packageDir,
    "node_modules/@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js",
  );
  const module = (await import(pathToFileURL(modulePath).href)) as {
    serverFnFetcher?: ServerFnFetcher;
  };

  if (typeof module.serverFnFetcher !== "function") {
    throw new Error("Failed to load TanStack Start serverFnFetcher");
  }

  return module.serverFnFetcher;
}

async function getTanstackServerFnFetcher() {
  if (!tanstackServerFnFetcherPromise) {
    tanstackServerFnFetcherPromise = loadTanstackServerFnFetcher();
  }

  return tanstackServerFnFetcherPromise;
}

function unwrapConsoleServerFnResult<T>(
  serverFnName: ConsoleServerFnName,
  value: unknown,
) {
  if (value && typeof value === "object") {
    const envelope = value as ServerFnResultEnvelope<T>;

    if (envelope.error !== undefined && envelope.error !== null) {
      if (envelope.error instanceof Error) {
        throw envelope.error;
      }

      throw new Error(
        `Console server function ${serverFnName} failed: ${String(envelope.error)}`,
      );
    }

    if ("result" in envelope) {
      return envelope.result as T;
    }
  }

  return value as T;
}

async function callConsoleServerFn<T>(
  serverFnName: ConsoleServerFnName,
  method: "GET" | "POST",
  data?: unknown,
) {
  const [consoleServerFnIds, serverFnFetcher] = await Promise.all([
    getConsoleServerFnIds(),
    getTanstackServerFnFetcher(),
  ]);
  const url = `${session.consoleApiBaseUrl}/_serverFn/${consoleServerFnIds[serverFnName]}`;
  const result = await serverFnFetcher(
    url,
    [
      {
        data,
        method,
      },
    ],
    fetch,
  );

  return unwrapConsoleServerFnResult<T>(serverFnName, result);
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

async function applyAppScenario({
  marker,
  mode,
  safeBundleIds,
}: {
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

  const nextSource = source
    .replace(
      MARKER_PATTERN,
      `const E2E_SCENARIO_MARKER = ${JSON.stringify(marker)};`,
    )
    .replace(CRASH_GUARD_PATTERN, crashGuardSource);

  await fsPromises.writeFile(session.appSourceFile, nextSource);
  logE2e("app scenario applied", {
    marker,
    mode,
    safeBundleIds,
    sourceFile: path.relative(REPO_DIR, session.appSourceFile),
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
    throw new Error("Unexpected bundle list response from console API");
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

async function fetchBundlesPage(args: {
  channel?: string;
  limit: number;
  offset: number;
}) {
  logE2e("console-api request", {
    channel: args.channel ?? null,
    limit: args.limit,
    method: "GET",
    offset: args.offset,
    platform: session.platform,
  });

  const response = await callConsoleServerFn<BundleListPage>("getBundles", "GET", {
    channel: args.channel,
    limit: String(args.limit),
    offset: String(args.offset),
    platform: session.platform,
  });
  const bundles = normalizeBundleListResponse(response);
  logE2e("console-api response", {
    count: bundles.data.length,
    limit: args.limit,
    method: "GET",
    offset: args.offset,
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
  logE2e("console-api request", {
    bundleId,
    method: "GET",
  });

  const bundle = await callConsoleServerFn<{
    channel: string;
    enabled: boolean;
    id: string;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[] | null;
  } | null>("getBundle", "GET", {
    bundleId,
  });

  if (!bundle) {
    throw new Error(`Failed to fetch bundle ${bundleId}: bundle not found`);
  }

  logE2e("console-api response", {
    bundleId: bundle.id,
    channel: bundle.channel,
    enabled: bundle.enabled,
    method: "GET",
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
  });

  return bundle;
}

async function patchBundle(
  bundleId: string,
  patch: {
    enabled?: boolean;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[] | null;
  },
) {
  logE2e("console-api request", {
    body: { bundle: patch },
    bundleId,
    method: "POST",
  });

  await callConsoleServerFn<{
    bundle: {
      channel: string;
      enabled: boolean;
      id: string;
      rolloutCohortCount?: number | null;
      shouldForceUpdate?: boolean;
      targetCohorts?: string[] | null;
    },
    success: true;
  }>("updateBundle", "POST", {
    bundle: patch,
    bundleId,
  });

  logE2e("console-api response", {
    bundleId,
    method: "POST",
  });
}

async function deleteBundle(bundleId: string) {
  logE2e("console-api request", {
    bundleId,
    method: "POST",
  });

  await callConsoleServerFn<{ success: true }>("deleteBundle", "POST", {
    bundleId,
  });

  logE2e("console-api response", {
    bundleId,
    method: "POST",
  });
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

  session.storePath = `/sdcard/Android/data/${session.appId}/files/bundle-store`;
  return session.storePath;
}

async function installIosArtifact(appPath: string) {
  runCapture(
    "xcrun",
    ["simctl", "uninstall", deviceId as string, session.appId],
    { allowFailure: true },
  );
  await runLogged("xcrun", ["simctl", "install", deviceId as string, appPath], {
    logPath: path.join(session.resultsDir, "simctl-install.log"),
  });
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

  await runLogged(
    "xcodebuild",
    [
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
      "build",
    ],
    {
      logPath: path.join(session.resultsDir, "xcodebuild.log"),
    },
  );

  session.builtArtifactPath = builtAppPath;
  await installIosArtifact(builtAppPath);
}

async function prepareAndroidRelease() {
  if (!session.reuseApp) {
    await runLogged("./gradlew", [":app:assembleRelease", "--rerun-tasks"], {
      cwd: path.join(session.exampleDir, "android"),
      logPath: path.join(session.resultsDir, "gradle-release.log"),
    });
  } else if (!fs.existsSync(session.androidApkPath)) {
    throw new Error(
      `Cannot reuse Android app because ${session.androidApkPath} does not exist`,
    );
  }

  session.builtArtifactPath = session.androidApkPath;

  runCapture("adb", ["-s", deviceId as string, "uninstall", session.appId], {
    allowFailure: true,
  });
  await runLogged(
    "adb",
    ["-s", deviceId as string, "install", "-r", session.builtArtifactPath],
    {
      logPath: path.join(session.resultsDir, "adb-install.log"),
    },
  );
}

function copyAndroidFile(remotePath: string, localPath: string) {
  const result = spawnSync(
    "adb",
    ["-s", deviceId as string, "shell", "cat", remotePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to read ${remotePath} from Android device`);
  }

  fs.writeFileSync(localPath, result.stdout);
}

function copyAndroidFileIfExists(remotePath: string, localPath: string) {
  const exists = spawnSync(
    "adb",
    ["-s", deviceId as string, "shell", "[", "-f", remotePath, "]"],
    {
      stdio: "ignore",
    },
  );

  if (exists.status !== 0) {
    return false;
  }

  copyAndroidFile(remotePath, localPath);
  return true;
}

async function readBundleIdFromUiDump(
  expectedMarker: string,
  outputPath: string,
  attempts = 30,
) {
  for (let index = 0; index < attempts; index += 1) {
    runCapture(
      "adb",
      [
        "-s",
        deviceId as string,
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/window_dump.xml",
      ],
      { allowFailure: true },
    );

    const xml = runCapture(
      "adb",
      ["-s", deviceId as string, "exec-out", "cat", "/sdcard/window_dump.xml"],
      { allowFailure: true },
    );

    fs.writeFileSync(outputPath, xml);

    if (expectedMarker && !xml.includes(expectedMarker)) {
      await sleep(1000);
      continue;
    }

    const match = xml.match(/text="BUNDLE ID"[\s\S]*?text="([0-9a-f-]{36})"/i);
    if (match?.[1]) {
      return match[1];
    }

    await sleep(1000);
  }

  throw new Error("Timed out reading bundle id from Android UI dump");
}

async function readCurrentBundleIdFromMetadata(
  outputPath: string,
  attempts = 90,
) {
  const metadataPath = path.join(ensureStorePath(), "metadata.json");

  for (let index = 0; index < attempts; index += 1) {
    let metadata: Record<string, unknown> | null = null;

    if (session.platform === "ios") {
      if (fs.existsSync(metadataPath)) {
        await fsPromises.copyFile(metadataPath, outputPath);
        metadata = readJson(outputPath);
      }
    } else if (copyAndroidFileIfExists(metadataPath, outputPath)) {
      metadata = readJson(outputPath);
    }

    const bundleId =
      (metadata?.stagingBundleId as string | undefined) ??
      (metadata?.staging_bundle_id as string | undefined) ??
      (metadata?.stableBundleId as string | undefined) ??
      (metadata?.stable_bundle_id as string | undefined);

    if (bundleId) {
      return bundleId;
    }

    await sleep(1000);
  }

  throw new Error(`Timed out reading bundle id from ${metadataPath}`);
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
    launchReport: readOptionalJsonSnapshot(path.join(storePath, "launch-report.json")),
    metadata: readOptionalJsonSnapshot(path.join(storePath, "metadata.json")),
  };
}

function readAndroidStoreSnapshot(remoteFileName: string, localFileName: string) {
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

function getLaunchReportState(report: Record<string, unknown> | null) {
  return {
    crashedBundleId:
      (report?.crashedBundleId as string | undefined) ??
      (report?.crashed_bundle_id as string | undefined) ??
      null,
    status: (report?.status as string | undefined) ?? null,
  };
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
    launchReport: readOptionalJsonSnapshot(path.join(storePath, "launch-report.json")),
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
    metadata: readAndroidStoreSnapshot("metadata.json", "recovery-metadata.json"),
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
    [
      "-s",
      deviceId as string,
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      component,
    ],
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
  for (let index = 0; index < attempts; index += 1) {
    const diagnostics = readAndroidWaitForMetadataDiagnostics();
    if (diagnostics.metadata.value) {
      const metadata = diagnostics.metadata.value;
      if (
        metadata.stagingBundleId === bundleId &&
        metadata.verificationPending === verificationPending
      ) {
        return;
      }
    }
    await sleep(1000);
  }

  throw createWaitForMetadataTimeoutError({
    attempts,
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
    const launchReportState = getLaunchReportState(diagnostics.launchReport.value);

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

async function bootstrap() {
  if (!session.appBackupPath) {
    session.appBackupPath = await backupFile(session.appSourceFile);
  }

  session.builtInBundleId = null;
  session.deployedBundles = [];
  session.storePath = null;

  await clearRemoteBundles();
  await applyAppScenario({
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
  await applyAppScenario({
    marker: request.marker,
    mode: request.mode,
    safeBundleIds: request.safeBundleIds,
  });

  const args = [
    "hot-updater",
    "deploy",
    "-p",
    session.platform,
    "-t",
    request.targetAppVersion,
    "-c",
    request.channel,
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
    channel: request.channel,
    command: `pnpm ${args.join(" ")}`,
    logPath: path.relative(REPO_DIR, deployLogPath),
    marker: request.marker,
    mode: request.mode,
    platform: session.platform,
    targetAppVersion: request.targetAppVersion,
  });
  await runLogged("pnpm", args, {
    cwd: session.exampleDir,
    logPath: deployLogPath,
  });
  logE2e("deploy done", {
    channel: request.channel,
    logPath: path.relative(REPO_DIR, deployLogPath),
    marker: request.marker,
    mode: request.mode,
    platform: session.platform,
  });

  const bundleId = await fetchLatestBundle({
    channel: request.channel,
  });

  if (request.targetCohorts && request.targetCohorts.length > 0) {
    await patchBundle(bundleId, {
      targetCohorts: request.targetCohorts,
    });
  }

  const bundle = await fetchBundleById(bundleId);

  session.deployedBundles.push({
    bundleId,
    channel: bundle.channel,
    enabled: bundle.enabled,
    marker: request.marker,
    mode: request.mode,
    rolloutCohortCount: bundle.rolloutCohortCount ?? null,
    shouldForceUpdate: bundle.shouldForceUpdate ?? false,
    targetCohorts: bundle.targetCohorts ?? null,
  });

  return {
    bundleId,
    channel: bundle.channel,
    enabled: bundle.enabled,
    marker: request.marker,
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

  session.appBackupPath = null;
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

export async function handleCaptureState(prefix: string) {
  return captureState(prefix);
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

export async function handleWriteSummary(args: {
  scenario: string;
  status: string;
}) {
  return writeSummary(args);
}

export async function handleCleanup() {
  return cleanup();
}
