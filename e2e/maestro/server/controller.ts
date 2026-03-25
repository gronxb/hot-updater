import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
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
  envBackupPath: string | null;
  envFile: string;
  exampleDir: string;
  initialMarker: string;
  iosDerivedDataPath: string;
  platform: Platform;
  resultsDir: string;
  reuseApp: boolean;
  storePath: string | null;
  writeExampleEnv: () => Promise<void>;
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

type LaunchReportAssertion = {
  crashedBundleId?: string;
  optional: boolean;
  status: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../../..");
const EXAMPLE_DIR = path.join(REPO_DIR, "examples/v0.81.0");
const APP_SOURCE_FILE = path.join(EXAMPLE_DIR, "App.tsx");
const ENV_FILE = path.join(EXAMPLE_DIR, ".env.hotupdater");
const EMPTY_CRASH_HISTORY = {
  bundles: [],
  maxHistorySize: 10,
};
const CRASH_GUARD_START = "/* E2E_CRASH_GUARD_START */";
const CRASH_GUARD_END = "/* E2E_CRASH_GUARD_END */";
const CRASH_GUARD_PATTERN =
  /\/\* E2E_CRASH_GUARD_START \*\/[\s\S]*?\/\* E2E_CRASH_GUARD_END \*\//;
const MARKER_PATTERN = /const E2E_SCENARIO_MARKER = ".*?";/;

function mergeEnvSource(
  source: string,
  overrides: Record<string, string>,
): string {
  const remaining = new Map(Object.entries(overrides));
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      return line;
    }

    const key = line.slice(0, separatorIndex).trim();
    const override = remaining.get(key);
    if (override === undefined) {
      return line;
    }

    remaining.delete(key);
    return `${key}=${override}`;
  });

  for (const [key, value] of remaining) {
    nextLines.push(`${key}=${value}`);
  }

  return `${nextLines.join("\n").replace(/\n*$/, "")}\n`;
}

const platform = process.env.HOT_UPDATER_E2E_PLATFORM as Platform | undefined;
const appId = process.env.HOT_UPDATER_E2E_APP_ID;
const consoleBaseUrl = process.env.HOT_UPDATER_E2E_CONSOLE_BASE_URL;
const deviceId = process.env.HOT_UPDATER_E2E_DEVICE_ID;
const e2eStorageMode = process.env.HOT_UPDATER_E2E_STORAGE_MODE;
const resultsDir = process.env.HOT_UPDATER_E2E_RESULTS_DIR;
const serverBaseUrl = process.env.HOT_UPDATER_E2E_SERVER_BASE_URL;
const appBaseUrl = process.env.HOT_UPDATER_E2E_APP_BASE_URL;

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
  envBackupPath: null,
  envFile: ENV_FILE,
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
  writeExampleEnv: async () => {
    const overrides = Object.fromEntries(
      Object.entries({
        HOT_UPDATER_APP_BASE_URL: appBaseUrl,
        HOT_UPDATER_SERVER_BASE_URL: serverBaseUrl,
        HOT_UPDATER_STORAGE_MODE: e2eStorageMode,
      }).filter(([, value]) => typeof value === "string" && value.length > 0),
    );

    if (Object.keys(overrides).length === 0) {
      return;
    }

    const baseSource = session.envBackupPath
      ? await fsPromises.readFile(session.envBackupPath, "utf8")
      : fs.existsSync(ENV_FILE)
        ? await fsPromises.readFile(ENV_FILE, "utf8")
        : "";
    const source = mergeEnvSource(baseSource, overrides);

    await fsPromises.writeFile(ENV_FILE, source);
  },
};

const jobs = new Map<string, JobState>();

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
          "  const E2E_CURRENT_BUNDLE_ID = HotUpdater.getBundleId();",
          "",
          "  if (!E2E_SAFE_BUNDLE_IDS.has(E2E_CURRENT_BUNDLE_ID)) {",
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

async function fetchLatestBundle(args: { channel?: string }) {
  const url = new URL(`${session.consoleApiBaseUrl}/api/bundles`);
  url.searchParams.set("platform", session.platform);
  if (args.channel) {
    url.searchParams.set("channel", args.channel);
  }
  url.searchParams.set("limit", "1");
  url.searchParams.set("offset", "0");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch bundles: ${response.status} ${response.statusText}`,
    );
  }

  const bundles = (await response.json()) as {
    data?: Array<{ id: string }>;
  };
  const latestBundle = bundles.data?.[0];

  if (!latestBundle?.id) {
    throw new Error(`No bundles found for platform ${session.platform}`);
  }

  return latestBundle.id;
}

async function fetchBundleById(bundleId: string) {
  const response = await fetch(
    `${session.consoleApiBaseUrl}/api/bundles/${bundleId}`,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch bundle ${bundleId}: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as {
    channel: string;
    enabled: boolean;
    id: string;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[] | null;
  };
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
  const response = await fetch(
    `${session.consoleApiBaseUrl}/api/bundles/${bundleId}`,
    {
      body: JSON.stringify({ bundle: patch }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "PATCH",
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to patch bundle ${bundleId}: ${response.status} ${response.statusText}`,
    );
  }
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

async function waitForIosMetadataState(
  bundleId: string,
  verificationPending: boolean,
  attempts = 90,
) {
  const metadataPath = path.join(ensureStorePath(), "metadata.json");

  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(metadataPath)) {
      const metadata = readJson(metadataPath);
      const stagingBundleId =
        (metadata.stagingBundleId as string | undefined) ??
        (metadata.staging_bundle_id as string | undefined);
      const currentPending =
        (metadata.verificationPending as boolean | undefined) ??
        (metadata.verification_pending as boolean | undefined);

      if (
        stagingBundleId === bundleId &&
        currentPending === verificationPending
      ) {
        return;
      }
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for metadata state in ${metadataPath}`);
}

async function waitForAndroidMetadataState(
  bundleId: string,
  verificationPending: boolean,
  attempts = 90,
) {
  const probePath = path.join(session.resultsDir, "metadata-probe.json");
  const metadataPath = `${ensureStorePath()}/metadata.json`;

  for (let index = 0; index < attempts; index += 1) {
    if (copyAndroidFileIfExists(metadataPath, probePath)) {
      const metadata = readJson(probePath);
      if (
        metadata.stagingBundleId === bundleId &&
        metadata.verificationPending === verificationPending
      ) {
        return;
      }
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for metadata state in ${metadataPath}`);
}

async function bootstrap() {
  if (!session.appBackupPath) {
    session.appBackupPath = await backupFile(session.appSourceFile);
  }
  const shouldOverrideEnv =
    typeof appBaseUrl === "string" ||
    typeof serverBaseUrl === "string" ||
    typeof e2eStorageMode === "string";
  if (shouldOverrideEnv && !session.envBackupPath) {
    session.envBackupPath = await backupFile(session.envFile);
  }

  session.builtInBundleId = null;
  session.deployedBundles = [];
  session.storePath = null;

  if (shouldOverrideEnv) {
    await session.writeExampleEnv();
  }
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
  const builtInBundleId =
    session.platform === "ios"
      ? await readCurrentBundleIdFromMetadata(
          path.join(session.resultsDir, "initial-metadata.json"),
        )
      : await readBundleIdFromUiDump(
          session.initialMarker,
          path.join(session.resultsDir, "initial-ui.xml"),
        );

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

  await runLogged("pnpm", args, {
    cwd: session.exampleDir,
    logPath: path.join(
      session.resultsDir,
      `deploy-${request.channel}-${request.marker}.log`,
    ),
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
  const metadata =
    session.platform === "ios"
      ? readJson(path.join(ensureStorePath(), "metadata.json"))
      : (() => {
          const probePath = path.join(
            session.resultsDir,
            "metadata-reset-assert.json",
          );
          copyAndroidFile(`${ensureStorePath()}/metadata.json`, probePath);
          return readJson(probePath);
        })();

  assertMetadataReset(metadata);
  return {};
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
  if (!session.appBackupPath && !session.envBackupPath) {
    return {};
  }

  await restoreFile(session.appBackupPath, session.appSourceFile);
  await restoreFile(session.envBackupPath, session.envFile);

  session.appBackupPath = null;
  session.envBackupPath = null;
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

export async function handleWriteSummary(args: {
  scenario: string;
  status: string;
}) {
  return writeSummary(args);
}

export async function handleCleanup() {
  return cleanup();
}
