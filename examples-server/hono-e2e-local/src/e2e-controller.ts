import fs from "fs";
import fsPromises from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { setTimeout as sleep } from "timers/promises";

type Platform = "ios" | "android";

type JobResult =
  | {
      builtInBundleId?: string;
      bundleId?: string;
      emptyCrashHistoryText?: string;
      initialMarker?: string;
      stableMarker?: string;
    }
  | Record<string, never>;

type JobState = {
  error?: string;
  result?: JobResult;
  status: "failed" | "running" | "succeeded";
};

type SessionState = {
  androidApkPath: string;
  appBackupPath: string | null;
  appBaseUrl: string;
  appId: string;
  appSourceFile: string;
  builtArtifactPath: string | null;
  builtInBundleId: string | null;
  crashBundleId: string | null;
  envBackupPath: string | null;
  envFile: string;
  exampleDir: string;
  initialMarker: string;
  iosDerivedDataPath: string;
  platform: Platform;
  repoDir: string;
  resultsDir: string;
  serverApiBaseUrl: string;
  stableBundleId: string | null;
  stableMarker: string;
  storePath: string | null;
  writeExampleEnv: () => Promise<void>;
};

const EXAMPLE_DIR = path.resolve(process.cwd(), "../../examples/v0.81.0");
const REPO_DIR = path.resolve(process.cwd(), "../..");
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

const platform = process.env.HOT_UPDATER_E2E_PLATFORM as Platform | undefined;
const appId = process.env.HOT_UPDATER_E2E_APP_ID;
const deviceId = process.env.HOT_UPDATER_E2E_DEVICE_ID;
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
if (!serverBaseUrl) {
  throw new Error("HOT_UPDATER_E2E_SERVER_BASE_URL is required");
}
if (!appBaseUrl) {
  throw new Error("HOT_UPDATER_E2E_APP_BASE_URL is required");
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
  appBaseUrl,
  appId,
  appSourceFile: APP_SOURCE_FILE,
  builtArtifactPath: null,
  builtInBundleId: null,
  crashBundleId: null,
  envBackupPath: null,
  envFile: ENV_FILE,
  exampleDir: EXAMPLE_DIR,
  initialMarker:
    platform === "ios" ? "builtin-ios-maestro" : "builtin-android-maestro",
  iosDerivedDataPath:
    process.env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH ??
    "/tmp/hotupdater-v081-ios-maestro",
  platform,
  repoDir: REPO_DIR,
  resultsDir,
  serverApiBaseUrl: `${serverBaseUrl}/hot-updater`,
  stableBundleId: null,
  stableMarker:
    platform === "ios" ? "stable-ios-maestro" : "stable-android-maestro",
  storePath: null,
  writeExampleEnv: async () => {
    const source = [
      `HOT_UPDATER_APP_BASE_URL=${appBaseUrl}`,
      `HOT_UPDATER_SERVER_BASE_URL=${serverBaseUrl}`,
      "HOT_UPDATER_STORAGE_MODE=standalone",
    ].join("\n");

    await fsPromises.writeFile(ENV_FILE, `${source}\n`);
  },
};

const jobs = new Map<string, JobState>();

function runCapture(command: string, args: string[], options: { allowFailure?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
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

async function runLogged(command: string, args: string[], options: { allowFailure?: boolean; cwd?: string; env?: NodeJS.ProcessEnv; logPath: string }) {
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
  mode: "crash" | "reset";
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
    .replace(MARKER_PATTERN, `const E2E_SCENARIO_MARKER = ${JSON.stringify(marker)};`)
    .replace(CRASH_GUARD_PATTERN, crashGuardSource);

  await fsPromises.writeFile(session.appSourceFile, nextSource);
}

async function waitForHttp(url: string, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${url}`);
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

async function fetchLatestBundleId() {
  const response = await fetch(`${session.serverApiBaseUrl}/api/bundles`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch bundles: ${response.status} ${response.statusText}`,
    );
  }

  const bundles = (await response.json()) as Array<{
    id: string;
    platform: Platform;
  }>;
  const latestBundle = bundles.find((bundle) => bundle.platform === session.platform);

  if (!latestBundle?.id) {
    throw new Error(`No bundles found for platform ${session.platform}`);
  }

  return latestBundle.id;
}

async function waitForLoggedBundleId(logFile: string, attempts = 90) {
  const pattern = new RegExp(
    `/hot-updater/app-version/${session.platform}/[^/]+/[^/]+/([^/]+)/`,
    "g",
  );

  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(logFile)) {
      const content = await fsPromises.readFile(logFile, "utf8");
      const matches = [...content.matchAll(pattern)];
      const bundleId = matches.at(-1)?.[1];
      if (bundleId) {
        return bundleId;
      }
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for bundle id in ${logFile}`);
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

async function prepareIosRelease() {
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

  session.builtArtifactPath = path.join(
    session.iosDerivedDataPath,
    "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
  );

  runCapture(
    "xcrun",
    ["simctl", "uninstall", deviceId as string, session.appId],
    { allowFailure: true },
  );
  await runLogged(
    "xcrun",
    ["simctl", "install", deviceId as string, session.builtArtifactPath],
    {
      logPath: path.join(session.resultsDir, "simctl-install.log"),
    },
  );
}

async function prepareAndroidRelease() {
  await runLogged("./gradlew", [":app:assembleRelease", "--rerun-tasks"], {
    cwd: path.join(session.exampleDir, "android"),
    logPath: path.join(session.resultsDir, "gradle-release.log"),
  });

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

async function readBundleIdFromUiDump(expectedMarker: string, outputPath: string, attempts = 30) {
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
      [
        "-s",
        deviceId as string,
        "exec-out",
        "cat",
        "/sdcard/window_dump.xml",
      ],
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

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function assertMetadataState(metadata: Record<string, unknown>, bundleId: string) {
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

function assertLaunchReport(filePath: string, expectedStatus: string, expectedCrashBundleId = "") {
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

async function waitForIosMetadataState(bundleId: string, verificationPending: boolean, attempts = 90) {
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

async function waitForAndroidMetadataState(bundleId: string, verificationPending: boolean, attempts = 90) {
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
  if (!session.envBackupPath) {
    session.envBackupPath = await backupFile(session.envFile);
  }

  await session.writeExampleEnv();
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
    stableMarker: session.stableMarker,
  };
}

async function captureBuiltInBundleId() {
  const builtInBundleId =
    session.platform === "ios"
      ? await waitForLoggedBundleId(path.join(session.resultsDir, "server.log"))
      : await readBundleIdFromUiDump(
          session.initialMarker,
          path.join(session.resultsDir, "initial-ui.xml"),
        );

  session.builtInBundleId = builtInBundleId;

  return { builtInBundleId };
}

async function deployPhase(phase: "crash" | "stable") {
  if (phase === "stable") {
    await applyAppScenario({
      marker: session.stableMarker,
      mode: "reset",
      safeBundleIds: [],
    });
  } else {
    if (!session.builtInBundleId || !session.stableBundleId) {
      throw new Error("Crash deploy requires builtInBundleId and stableBundleId");
    }
    await applyAppScenario({
      marker: session.stableMarker,
      mode: "crash",
      safeBundleIds: [session.builtInBundleId, session.stableBundleId],
    });
  }

  await runLogged(
    "pnpm",
    ["hot-updater", "deploy", "-p", session.platform, "-t", "1.0.x"],
    {
      cwd: session.exampleDir,
      logPath: path.join(session.resultsDir, `deploy-${phase}.log`),
    },
  );

  const bundleId = await fetchLatestBundleId();

  if (phase === "stable") {
    session.stableBundleId = bundleId;
  } else {
    session.crashBundleId = bundleId;
  }

  return {
    bundleId,
    stableMarker: session.stableMarker,
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

async function captureState(prefix: "recovered" | "stable") {
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
          const probePath = path.join(session.resultsDir, "metadata-assert.json");
          copyAndroidFile(`${ensureStorePath()}/metadata.json`, probePath);
          return readJson(probePath);
        })();

  assertMetadataState(metadata, bundleId);
  return {};
}

async function assertLaunchReportState({
  crashedBundleId,
  optional,
  status,
}: {
  crashedBundleId?: string;
  optional: boolean;
  status: string;
}) {
  const launchReportPath =
    session.platform === "ios"
      ? path.join(ensureStorePath(), "launch-report.json")
      : path.join(session.resultsDir, "launch-report-assert.json");

  if (session.platform === "android") {
    if (!copyAndroidFileIfExists(`${ensureStorePath()}/launch-report.json`, launchReportPath)) {
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
    copyAndroidFile(`${ensureStorePath()}/crashed-history.json`, crashHistoryPath);
  }

  assertCrashHistoryContains(crashHistoryPath, bundleId);
  return {};
}

async function writeSummary() {
  await fsPromises.writeFile(
    path.join(session.resultsDir, "summary.json"),
    JSON.stringify(
      {
        platform: session.platform,
        binaryType: "Release",
        builtInBundleId: session.builtInBundleId,
        stableBundleId: session.stableBundleId,
        crashBundleId: session.crashBundleId,
        status: "RECOVERED",
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
  const jobId = crypto.randomUUID();
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

export function startDeployJob(phase: "crash" | "stable") {
  return createJob(() => deployPhase(phase));
}

export function getJob(jobId: string) {
  return jobs.get(jobId) ?? null;
}

export async function handleCaptureBuiltInBundleId() {
  return captureBuiltInBundleId();
}

export async function handleWaitForMetadata(bundleId: string, verificationPending: boolean) {
  return waitForMetadata(bundleId, verificationPending);
}

export async function handleCaptureState(prefix: "recovered" | "stable") {
  return captureState(prefix);
}

export async function handleAssertMetadataActive(bundleId: string) {
  return assertMetadataActive(bundleId);
}

export async function handleAssertLaunchReport({
  crashedBundleId,
  optional,
  status,
}: {
  crashedBundleId?: string;
  optional: boolean;
  status: string;
}) {
  return assertLaunchReportState({
    crashedBundleId,
    optional,
    status,
  });
}

export async function handleAssertCrashHistory(bundleId: string) {
  return assertCrashHistory(bundleId);
}

export async function handleWriteSummary() {
  return writeSummary();
}

export async function handleCleanup() {
  return cleanup();
}
