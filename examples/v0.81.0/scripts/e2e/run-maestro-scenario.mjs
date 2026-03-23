#!/usr/bin/env node

import fs from "fs";
import fsPromises from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import process from "process";
import { spawn, spawnSync } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import YAML from "yaml";
import { applyAppScenario } from "./set-app-scenario.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(__dirname, "../..");
const REPO_DIR = path.resolve(EXAMPLE_DIR, "../..");
const SERVER_DIR = path.join(REPO_DIR, "examples-server/hono-e2e-local");
const RESULTS_ROOT = path.join(EXAMPLE_DIR, ".maestro/results");
const APP_SOURCE_FILE = path.join(EXAMPLE_DIR, "App.tsx");
const ENV_FILE = path.join(EXAMPLE_DIR, ".env.hotupdater");
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = Number(process.env.HOT_UPDATER_SERVER_PORT || 3007);

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      options.platform = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--scenario") {
      options.scenario = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return [
    "Usage:",
    "  node ./scripts/e2e/run-maestro-scenario.mjs --platform <ios|android> --scenario <path>",
  ].join("\n");
}

function resolveMaestroBin() {
  const which = spawnSync("which", ["maestro"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  const candidates = [
    which.status === 0 ? which.stdout.trim() : "",
    path.join(os.homedir(), ".maestro/bin/maestro"),
    "/opt/homebrew/bin/maestro",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Maestro CLI not found. Install it or add it to PATH.");
}

function runCapture(command, args, options = {}) {
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

async function runLogged(command, args, options = {}) {
  await fsPromises.mkdir(path.dirname(options.logPath), { recursive: true });

  const output = [];
  const logStream = fs.createWriteStream(options.logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    output.push(chunk);
    logStream.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.push(chunk);
    logStream.write(chunk);
  });

  const exitCode = await new Promise((resolve, reject) => {
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

function resolvePlatformValue(value, platform) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.ios !== undefined || value.android !== undefined)
  ) {
    return value[platform];
  }

  return value;
}

function lookupToken(token, context) {
  const segments = token.split(".");

  const tryResolve = (source) => {
    let current = source;
    for (const segment of segments) {
      if (current == null || !(segment in current)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  };

  const direct = tryResolve(context);
  if (direct !== undefined) {
    return direct;
  }

  return tryResolve(context.vars ?? {});
}

function resolveTemplates(value, context) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, token) => {
      const resolved = lookupToken(token.trim(), context);
      if (resolved == null) {
        throw new Error(`Failed to resolve template token: ${token}`);
      }
      return String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplates(entry, context));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveTemplates(entry, context),
      ]),
    );
  }

  return value;
}

async function resolveServerPort(preferredPort) {
  const attempt = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ port }, () => {
        const address = server.address();
        const actualPort =
          typeof address === "object" && address ? address.port : port;
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          resolve(actualPort);
        });
      });
    });

  if (preferredPort > 0) {
    try {
      return await attempt(preferredPort);
    } catch {}
  }

  return attempt(0);
}

async function waitForHttp(url, attempts = 90) {
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

async function waitForFile(filePath, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function fetchLatestBundleId(baseUrl, platform) {
  const response = await fetch(`${baseUrl}/api/bundles`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch bundles: ${response.status} ${response.statusText}`,
    );
  }

  const bundles = await response.json();
  const latestBundle = bundles.find((bundle) => bundle.platform === platform);
  if (!latestBundle?.id) {
    throw new Error(`No bundles found for platform ${platform}`);
  }

  return latestBundle.id;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertLaunchReport(filePath, expectedStatus, expectedCrashBundleId = "") {
  const report = readJson(filePath);

  if (report.status !== expectedStatus) {
    throw new Error(
      `Expected launch status ${expectedStatus} but received ${report.status}`,
    );
  }

  if (
    expectedCrashBundleId &&
    report.crashedBundleId !== expectedCrashBundleId
  ) {
    throw new Error(
      `Expected crashedBundleId ${expectedCrashBundleId} but received ${report.crashedBundleId}`,
    );
  }
}

function assertMetadataState(metadata, expectedBundleId, expectedVerificationPending) {
  const stagingBundleId =
    metadata.stagingBundleId ?? metadata.staging_bundle_id ?? null;
  const verificationPending =
    metadata.verificationPending ?? metadata.verification_pending ?? null;

  if (stagingBundleId !== expectedBundleId) {
    throw new Error(
      `Expected stagingBundleId ${expectedBundleId} but received ${stagingBundleId}`,
    );
  }

  if (verificationPending !== expectedVerificationPending) {
    throw new Error(
      `Expected verificationPending ${expectedVerificationPending} but received ${verificationPending}`,
    );
  }
}

function assertCrashHistoryContains(filePath, expectedBundleId) {
  const history = readJson(filePath);
  const bundles = Array.isArray(history.bundles) ? history.bundles : [];
  if (!bundles.some((entry) => entry.bundleId === expectedBundleId)) {
    throw new Error(`Crash history is missing bundle ${expectedBundleId}`);
  }
}

async function backupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const backupDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "hu-e2e-"));
  const backupPath = path.join(backupDir, path.basename(filePath));
  await fsPromises.copyFile(filePath, backupPath);
  return backupPath;
}

async function restoreFile(sourcePath, targetPath) {
  if (!sourcePath) {
    await fsPromises.rm(targetPath, { force: true });
    return;
  }

  await fsPromises.copyFile(sourcePath, targetPath);
}

async function loadScenario(scenarioPath) {
  const source = await fsPromises.readFile(scenarioPath, "utf8");
  return YAML.parse(source);
}

function getContext(runtime, phase) {
  return {
    phase: {
      ...phase,
      marker: runtime.vars.phaseMarker,
    },
    platform: runtime.platform,
    platformConfig: runtime.platformConfig,
    scenario: runtime.scenario,
    vars: runtime.vars,
  };
}

async function createRuntime(platform, scenario) {
  const resultsDir = path.join(RESULTS_ROOT, platform);
  await fsPromises.rm(resultsDir, { recursive: true, force: true });
  await fsPromises.mkdir(resultsDir, { recursive: true });

  const rawServerBaseUrl = process.env.HOT_UPDATER_SERVER_BASE_URL?.replace(
    /\/$/,
    "",
  );
  const resolvedServerPort = rawServerBaseUrl
    ? new URL(rawServerBaseUrl).port ||
      (new URL(rawServerBaseUrl).protocol === "https:" ? "443" : "80")
    : await resolveServerPort(DEFAULT_SERVER_PORT);
  const serverBaseUrl =
    rawServerBaseUrl || `http://${DEFAULT_SERVER_HOST}:${resolvedServerPort}`;
  const serverPublicBaseUrl =
    platform === "android"
      ? `http://10.0.2.2:${resolvedServerPort}`
      : process.env.HOT_UPDATER_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
        serverBaseUrl;
  const platformConfig = scenario.platforms?.[platform];

  if (!platformConfig?.appId) {
    throw new Error(`Scenario is missing platform configuration for ${platform}`);
  }

  return {
    appBackupPath: await backupFile(APP_SOURCE_FILE),
    appBaseUrl: `${serverPublicBaseUrl}/hot-updater`,
    appId: platformConfig.appId,
    appSourceFile: APP_SOURCE_FILE,
    builtArtifactPath: null,
    envBackupPath: await backupFile(ENV_FILE),
    maestroBin: resolveMaestroBin(),
    platform,
    platformConfig,
    resultsDir,
    scenario,
    serverApiBaseUrl: `${serverBaseUrl}/hot-updater`,
    serverBaseUrl,
    serverChild: null,
    serverPort: String(resolvedServerPort),
    serverPublicBaseUrl,
    storePath: null,
    vars: {},
  };
}

async function writeEnvFile(runtime) {
  const source = [
    `HOT_UPDATER_APP_BASE_URL=${runtime.appBaseUrl}`,
    `HOT_UPDATER_SERVER_BASE_URL=${runtime.serverBaseUrl}`,
    "HOT_UPDATER_STORAGE_MODE=standalone",
  ].join("\n");

  await fsPromises.writeFile(ENV_FILE, `${source}\n`);
}

async function startLocalServer(runtime) {
  await fsPromises.rm(path.join(SERVER_DIR, "data"), {
    recursive: true,
    force: true,
  });
  await fsPromises.rm(path.join(SERVER_DIR, "storage"), {
    recursive: true,
    force: true,
  });
  await fsPromises.mkdir(path.join(SERVER_DIR, "data"), { recursive: true });
  await fsPromises.mkdir(path.join(SERVER_DIR, "storage"), {
    recursive: true,
  });

  await runLogged(
    "pnpm",
    ["exec", "hot-updater", "db", "migrate", "src/db.ts", "--yes"],
    {
      cwd: SERVER_DIR,
      env: {
        HOT_UPDATER_E2E_STORAGE_DIR: path.join(SERVER_DIR, "storage"),
        HOT_UPDATER_PUBLIC_BASE_URL: runtime.serverPublicBaseUrl,
        PORT: runtime.serverPort,
        TEST_DB_PATH: path.join(SERVER_DIR, "data/hot-updater-e2e"),
      },
      logPath: path.join(runtime.resultsDir, "server-migrate.log"),
    },
  );

  const logPath = path.join(runtime.resultsDir, "server.log");
  await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      HOT_UPDATER_E2E_STORAGE_DIR: path.join(SERVER_DIR, "storage"),
      HOT_UPDATER_PUBLIC_BASE_URL: runtime.serverPublicBaseUrl,
      PORT: runtime.serverPort,
      TEST_DB_PATH: path.join(SERVER_DIR, "data/hot-updater-e2e"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  runtime.serverChild = child;

  await waitForHttp(`${runtime.serverApiBaseUrl}/version`);
}

async function stopLocalServer(runtime) {
  if (!runtime.serverChild) {
    return;
  }

  runtime.serverChild.kill("SIGTERM");
  await new Promise((resolve) => {
    runtime.serverChild.once("close", resolve);
    setTimeout(resolve, 3000);
  });
  runtime.serverChild = null;
}

async function applyPhasePatch(runtime, phase) {
  const patch = phase.patch ?? {};
  const marker = resolvePlatformValue(patch.marker, runtime.platform);
  const context = getContext(runtime, phase);

  runtime.vars.phaseMarker = marker;

  await applyAppScenario({
    appPath: runtime.appSourceFile,
    marker,
    mode: patch.mode ?? "reset",
    safeBundleIds: resolveTemplates(patch.safeBundleIds ?? [], context),
  });
}

function resolveIosSimulatorUdid(preferredName) {
  const output = runCapture("xcrun", [
    "simctl",
    "list",
    "devices",
    "available",
    "-j",
  ]);
  const data = JSON.parse(output);

  const parseRuntimeWeight = (runtime) => {
    const match = runtime.match(/iOS-(\d+)-(\d+)/);
    if (!match) {
      return 0;
    }
    return Number(match[1]) * 100 + Number(match[2]);
  };

  const devices = Object.entries(data.devices ?? {})
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([runtime, entries]) =>
      (entries ?? [])
        .filter((device) => device.isAvailable && device.name.includes("iPhone"))
        .map((device) => ({
          ...device,
          runtime,
          runtimeWeight: parseRuntimeWeight(runtime),
          exactName: device.name === preferredName ? 1 : 0,
          booted: device.state === "Booted" ? 1 : 0,
        })),
    )
    .sort(
      (left, right) =>
        right.exactName - left.exactName ||
        right.booted - left.booted ||
        right.runtimeWeight - left.runtimeWeight ||
        left.name.localeCompare(right.name),
    );

  if (!devices[0]?.udid) {
    throw new Error(`No available iPhone simulator found for ${preferredName}`);
  }

  return devices[0].udid;
}

function ensureIosSimulatorBooted(simulatorUdid) {
  const listOutput = runCapture("xcrun", ["simctl", "list", "devices"]);
  const line = listOutput
    .split("\n")
    .find((entry) => entry.includes(simulatorUdid));
  const state = line?.match(/\(([^()]+)\)\s*$/)?.[1] ?? "";

  if (state !== "Booted") {
    runCapture("xcrun", ["simctl", "boot", simulatorUdid], {
      allowFailure: true,
    });
  }

  runCapture("xcrun", ["simctl", "bootstatus", simulatorUdid, "-b"]);
}

async function waitForLoggedBundleId(logFile, platform, attempts = 90) {
  const pattern = new RegExp(
    `/hot-updater/app-version/${platform}/[^/]+/[^/]+/([^/]+)/`,
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

async function prepareIos(runtime) {
  const simulatorName =
    process.env.IOS_SIMULATOR_NAME ||
    runtime.platformConfig.simulatorName ||
    "iPhone 16";
  const simulatorUdid = resolveIosSimulatorUdid(simulatorName);
  ensureIosSimulatorBooted(simulatorUdid);

  runtime.vars.deviceId = simulatorUdid;
  runtime.vars.deviceName = simulatorName;

  await fsPromises.writeFile(
    path.join(runtime.resultsDir, "maestro-device.log"),
    `Using iOS simulator ${simulatorName} (${simulatorUdid})\n`,
  );
}

async function buildIosRelease(runtime) {
  const derivedDataPath =
    runtime.platformConfig.derivedDataPath || "/tmp/hotupdater-v081-ios-maestro";

  await runLogged("bundle", ["install"], {
    cwd: path.join(EXAMPLE_DIR, "ios"),
    logPath: path.join(runtime.resultsDir, "bundle-install.log"),
  });

  await fsPromises.rm(
    path.join(EXAMPLE_DIR, "ios/Pods/ReactNativeDependencies-artifacts"),
    { recursive: true, force: true },
  );
  await fsPromises.rm(
    path.join(EXAMPLE_DIR, "ios/Pods/React-Core-prebuilt"),
    { recursive: true, force: true },
  );

  await runLogged("bundle", ["exec", "pod", "install", "--clean-install"], {
    cwd: path.join(EXAMPLE_DIR, "ios"),
    logPath: path.join(runtime.resultsDir, "pod-install.log"),
  });

  await runLogged(
    "xcodebuild",
    [
      "-workspace",
      path.join(EXAMPLE_DIR, "ios/HotUpdaterExample.xcworkspace"),
      "-scheme",
      "HotUpdaterExample",
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `id=${runtime.vars.deviceId}`,
      "-derivedDataPath",
      derivedDataPath,
      "build",
    ],
    {
      logPath: path.join(runtime.resultsDir, "xcodebuild.log"),
    },
  );

  runtime.builtArtifactPath = path.join(
    derivedDataPath,
    "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
  );
}

async function installIosRelease(runtime) {
  runCapture(
    "xcrun",
    ["simctl", "uninstall", runtime.vars.deviceId, runtime.appId],
    {
      allowFailure: true,
    },
  );

  await runLogged(
    "xcrun",
    ["simctl", "install", runtime.vars.deviceId, runtime.builtArtifactPath],
    {
      logPath: path.join(runtime.resultsDir, "simctl-install.log"),
    },
  );
}

async function launchIosApp(runtime) {
  runCapture(
    "xcrun",
    ["simctl", "terminate", runtime.vars.deviceId, runtime.appId],
    {
      allowFailure: true,
    },
  );

  await runLogged(
    "xcrun",
    ["simctl", "launch", runtime.vars.deviceId, runtime.appId],
    {
      logPath: path.join(runtime.resultsDir, "ios-launch.log"),
      allowFailure: true,
    },
  );

  if (!runtime.storePath) {
    const appDataDir = runCapture("xcrun", [
      "simctl",
      "get_app_container",
      runtime.vars.deviceId,
      runtime.appId,
      "data",
    ]);
    runtime.storePath = path.join(appDataDir, "Documents/bundle-store");
  }
}

async function waitForIosMetadataState(
  runtime,
  bundleId,
  verificationPending,
  attempts = 90,
) {
  const metadataPath = path.join(runtime.storePath, "metadata.json");

  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(metadataPath)) {
      const metadata = readJson(metadataPath);
      const stagingBundleId =
        metadata.stagingBundleId ?? metadata.staging_bundle_id;
      const actualVerificationPending =
        metadata.verificationPending ?? metadata.verification_pending;

      if (
        stagingBundleId === bundleId &&
        actualVerificationPending === verificationPending
      ) {
        return;
      }
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for metadata state in ${metadataPath}`);
}

function resolveAndroidSerial() {
  if (process.env.ANDROID_SERIAL) {
    return process.env.ANDROID_SERIAL;
  }

  const devices = runCapture("adb", ["devices"]);
  const match = devices
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] && columns[1] === "device");

  if (!match?.[0]) {
    throw new Error("No Android device or emulator is connected");
  }

  return match[0];
}

async function prepareAndroid(runtime) {
  runtime.vars.deviceId = resolveAndroidSerial();
  runtime.storePath = `/sdcard/Android/data/${runtime.appId}/files/bundle-store`;
}

async function buildAndroidRelease(runtime) {
  await runLogged("./gradlew", [":app:assembleRelease", "--rerun-tasks"], {
    cwd: path.join(EXAMPLE_DIR, "android"),
    logPath: path.join(runtime.resultsDir, "gradle-release.log"),
  });

  const apkPath =
    runtime.platformConfig.apkPath ||
    "android/app/build/outputs/apk/release/app-release.apk";
  runtime.builtArtifactPath = path.isAbsolute(apkPath)
    ? apkPath
    : path.join(EXAMPLE_DIR, apkPath);
}

async function installAndroidRelease(runtime) {
  runCapture("adb", ["-s", runtime.vars.deviceId, "uninstall", runtime.appId], {
    allowFailure: true,
  });

  await runLogged(
    "adb",
    ["-s", runtime.vars.deviceId, "install", "-r", runtime.builtArtifactPath],
    {
      logPath: path.join(runtime.resultsDir, "adb-install.log"),
    },
  );
}

async function forceStopAndroidApp(runtime) {
  runCapture(
    "adb",
    ["-s", runtime.vars.deviceId, "shell", "am", "force-stop", runtime.appId],
    {
      allowFailure: true,
    },
  );
}

async function launchAndroidApp(runtime) {
  await forceStopAndroidApp(runtime);

  await runLogged(
    "adb",
    [
      "-s",
      runtime.vars.deviceId,
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `${runtime.appId}/.MainActivity`,
    ],
    {
      logPath: path.join(runtime.resultsDir, "android-launch.log"),
      allowFailure: true,
    },
  );
}

function copyAndroidFile(runtime, remotePath, localPath) {
  const result = spawnSync(
    "adb",
    ["-s", runtime.vars.deviceId, "shell", "cat", remotePath],
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

function copyAndroidFileIfExists(runtime, remotePath, localPath) {
  const exists = spawnSync(
    "adb",
    ["-s", runtime.vars.deviceId, "shell", "[", "-f", remotePath, "]"],
    {
      stdio: "ignore",
    },
  );

  if (exists.status !== 0) {
    return false;
  }

  copyAndroidFile(runtime, remotePath, localPath);
  return true;
}

async function readBundleIdFromUiDump(
  runtime,
  expectedMarker,
  outputPath,
  attempts = 30,
) {
  for (let index = 0; index < attempts; index += 1) {
    runCapture(
      "adb",
      [
        "-s",
        runtime.vars.deviceId,
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/window_dump.xml",
      ],
      {
        allowFailure: true,
      },
    );

    const xml = runCapture(
      "adb",
      [
        "-s",
        runtime.vars.deviceId,
        "exec-out",
        "cat",
        "/sdcard/window_dump.xml",
      ],
      {
        allowFailure: true,
      },
    );

    fs.writeFileSync(outputPath, xml);

    if (expectedMarker && !xml.includes(expectedMarker)) {
      await sleep(1000);
      continue;
    }

    const match = xml.match(
      /text="BUNDLE ID"[\s\S]*?text="([0-9a-f-]{36})"/i,
    );
    if (match?.[1]) {
      return match[1];
    }

    await sleep(1000);
  }

  throw new Error("Timed out reading bundle id from Android UI dump");
}

async function waitForAndroidMetadataState(
  runtime,
  bundleId,
  verificationPending,
  attempts = 90,
) {
  const probePath = path.join(runtime.resultsDir, "metadata-probe.json");

  for (let index = 0; index < attempts; index += 1) {
    if (
      copyAndroidFileIfExists(
        runtime,
        `${runtime.storePath}/metadata.json`,
        probePath,
      )
    ) {
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

  throw new Error(
    `Timed out waiting for metadata state in ${runtime.storePath}/metadata.json`,
  );
}

async function runMaestroFlow(runtime, step, phase) {
  const flowConfig = step.flow ?? {};
  if (!Array.isArray(flowConfig.commands) || flowConfig.commands.length === 0) {
    throw new Error(
      `Phase ${phase.id} maestroFlow step requires flow.commands`,
    );
  }

  const flowDocument = `${YAML.stringify({ appId: runtime.appId }).trimEnd()}\n---\n${YAML.stringify([
    {
      runFlow: {
        label: flowConfig.label ?? `${phase.id}-${step.reportPrefix ?? "flow"}`,
        env: resolveTemplates(flowConfig.env ?? {}, getContext(runtime, phase)),
        commands: flowConfig.commands,
      },
    },
  ])}`;
  const reportPrefix = step.reportPrefix ?? phase.id;
  const flowPath = path.join(
    runtime.resultsDir,
    `${reportPrefix}-generated-flow.yaml`,
  );

  await fsPromises.writeFile(flowPath, flowDocument);

  await runLogged(
    runtime.maestroBin,
    [
      "test",
      "--device",
      runtime.vars.deviceId,
      "--debug-output",
      path.join(runtime.resultsDir, `${reportPrefix}-debug`),
      "--flatten-debug-output",
      "--format",
      "JUNIT",
      "--output",
      path.join(runtime.resultsDir, `${reportPrefix}-junit.xml`),
      "--test-output-dir",
      path.join(runtime.resultsDir, `${reportPrefix}-artifacts`),
      flowPath,
    ],
    {
      logPath: path.join(runtime.resultsDir, `${reportPrefix}-maestro.log`),
    },
  );
}

async function captureIosState(runtime, prefix, step) {
  const metadataPath = path.join(runtime.storePath, "metadata.json");
  await waitForFile(metadataPath);

  await fsPromises.copyFile(
    metadataPath,
    path.join(runtime.resultsDir, `${prefix}-metadata.json`),
  );

  const launchReportPath = path.join(runtime.storePath, "launch-report.json");
  if (fs.existsSync(launchReportPath)) {
    await fsPromises.copyFile(
      launchReportPath,
      path.join(runtime.resultsDir, `${prefix}-launch-report.json`),
    );
  }

  const crashHistoryPath = path.join(runtime.storePath, "crashed-history.json");
  if (fs.existsSync(crashHistoryPath)) {
    await fsPromises.copyFile(
      crashHistoryPath,
      path.join(runtime.resultsDir, `${prefix}-crashed-history.json`),
    );
    return;
  }

  if (step.defaultCrashHistory) {
    await fsPromises.writeFile(
      path.join(runtime.resultsDir, `${prefix}-crashed-history.json`),
      JSON.stringify(step.defaultCrashHistory, null, 2),
    );
  }
}

async function captureAndroidState(runtime, prefix, step) {
  copyAndroidFile(
    runtime,
    `${runtime.storePath}/metadata.json`,
    path.join(runtime.resultsDir, `${prefix}-metadata.json`),
  );

  if (
    !copyAndroidFileIfExists(
      runtime,
      `${runtime.storePath}/crashed-history.json`,
      path.join(runtime.resultsDir, `${prefix}-crashed-history.json`),
    ) &&
    step.defaultCrashHistory
  ) {
    await fsPromises.writeFile(
      path.join(runtime.resultsDir, `${prefix}-crashed-history.json`),
      JSON.stringify(step.defaultCrashHistory, null, 2),
    );
  }

  copyAndroidFileIfExists(
    runtime,
    `${runtime.storePath}/launch-report.json`,
    path.join(runtime.resultsDir, `${prefix}-launch-report.json`),
  );
}

async function readCurrentMetadata(runtime) {
  if (runtime.platform === "ios") {
    return readJson(path.join(runtime.storePath, "metadata.json"));
  }

  const probePath = path.join(runtime.resultsDir, "metadata-assert.json");
  copyAndroidFile(runtime, `${runtime.storePath}/metadata.json`, probePath);
  return readJson(probePath);
}

async function maybeReadLaunchReport(runtime) {
  const probePath = path.join(runtime.resultsDir, "launch-report-assert.json");

  if (runtime.platform === "ios") {
    const filePath = path.join(runtime.storePath, "launch-report.json");
    return fs.existsSync(filePath) ? filePath : null;
  }

  if (
    copyAndroidFileIfExists(
      runtime,
      `${runtime.storePath}/launch-report.json`,
      probePath,
    )
  ) {
    return probePath;
  }

  return null;
}

async function maybeReadCrashHistory(runtime) {
  const probePath = path.join(runtime.resultsDir, "crash-history-assert.json");

  if (runtime.platform === "ios") {
    const filePath = path.join(runtime.storePath, "crashed-history.json");
    return fs.existsSync(filePath) ? filePath : null;
  }

  if (
    copyAndroidFileIfExists(
      runtime,
      `${runtime.storePath}/crashed-history.json`,
      probePath,
    )
  ) {
    return probePath;
  }

  return null;
}

async function executeStep(runtime, phase, rawStep) {
  const step = resolveTemplates(rawStep, getContext(runtime, phase));

  switch (step.action) {
    case "prepareRelease": {
      if (runtime.platform === "ios") {
        await prepareIos(runtime);
      } else {
        await prepareAndroid(runtime);
      }
      return;
    }
    case "buildRelease": {
      if (runtime.platform === "ios") {
        await buildIosRelease(runtime);
      } else {
        await buildAndroidRelease(runtime);
      }
      return;
    }
    case "installRelease": {
      if (runtime.platform === "ios") {
        await installIosRelease(runtime);
      } else {
        await installAndroidRelease(runtime);
      }
      return;
    }
    case "launch": {
      if (runtime.platform === "ios") {
        await launchIosApp(runtime);
      } else {
        await launchAndroidApp(runtime);
      }
      return;
    }
    case "captureBuiltInBundleId": {
      if (runtime.platform === "ios") {
        runtime.vars[step.saveAs ?? "builtInBundleId"] = await waitForLoggedBundleId(
          path.join(runtime.resultsDir, "server.log"),
          runtime.platform,
        );
      } else {
        runtime.vars[step.saveAs ?? "builtInBundleId"] = await readBundleIdFromUiDump(
          runtime,
          runtime.vars.phaseMarker,
          path.join(runtime.resultsDir, "initial-ui.xml"),
        );
      }
      return;
    }
    case "deploy": {
      await runLogged(
        "pnpm",
        [
          "hot-updater",
          "deploy",
          "-p",
          runtime.platform,
          "-t",
          step.targetVersion,
        ],
        {
          cwd: EXAMPLE_DIR,
          logPath: path.join(
            runtime.resultsDir,
            `deploy-${step.reportPrefix ?? phase.id}.log`,
          ),
        },
      );

      runtime.vars[step.saveAs ?? "bundleId"] = await fetchLatestBundleId(
        runtime.serverApiBaseUrl,
        runtime.platform,
      );
      return;
    }
    case "waitForMetadata": {
      if (runtime.platform === "ios") {
        await waitForIosMetadataState(
          runtime,
          step.bundleId,
          step.verificationPending,
        );
      } else {
        await waitForAndroidMetadataState(
          runtime,
          step.bundleId,
          step.verificationPending,
        );
      }
      return;
    }
    case "maestroFlow": {
      await runMaestroFlow(runtime, step, phase);
      return;
    }
    case "captureState": {
      if (runtime.platform === "ios") {
        await captureIosState(runtime, step.prefix, step);
      } else {
        await captureAndroidState(runtime, step.prefix, step);
      }
      return;
    }
    case "assertMetadataActive": {
      const metadata = await readCurrentMetadata(runtime);
      assertMetadataState(metadata, step.bundleId, false);
      return;
    }
    case "assertLaunchReport": {
      const launchReportPath = await maybeReadLaunchReport(runtime);
      if (!launchReportPath) {
        if (step.optional) {
          return;
        }
        throw new Error("launch-report.json is missing");
      }

      assertLaunchReport(
        launchReportPath,
        step.status,
        step.crashedBundleId ?? "",
      );
      return;
    }
    case "assertCrashHistoryContains": {
      const crashHistoryPath = await maybeReadCrashHistory(runtime);
      if (!crashHistoryPath) {
        throw new Error("crashed-history.json is missing");
      }

      assertCrashHistoryContains(crashHistoryPath, step.bundleId);
      return;
    }
    case "sleep": {
      await sleep(Number(step.seconds) * 1000);
      return;
    }
    default:
      throw new Error(`Unknown step action: ${step.action}`);
  }
}

async function writeSummary(runtime) {
  const summaryConfig = runtime.scenario.summary ?? {};
  const fields = resolveTemplates(summaryConfig.fields ?? {}, {
    vars: runtime.vars,
  });

  await fsPromises.writeFile(
    path.join(runtime.resultsDir, "summary.json"),
    JSON.stringify(
      {
        platform: runtime.platform,
        binaryType: "Release",
        ...fields,
        status: summaryConfig.status,
      },
      null,
      2,
    ),
  );
}

async function restoreWorkspace(runtime) {
  await restoreFile(runtime.appBackupPath, APP_SOURCE_FILE);
  await restoreFile(runtime.envBackupPath, ENV_FILE);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.platform || !options.scenario) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }

  if (!["ios", "android"].includes(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}`);
  }

  const scenario = await loadScenario(
    path.resolve(process.cwd(), options.scenario),
  );
  const runtime = await createRuntime(options.platform, scenario);

  try {
    await writeEnvFile(runtime);
    await startLocalServer(runtime);

    for (const phase of scenario.phases ?? []) {
      await applyPhasePatch(runtime, phase);
      for (const step of phase.steps ?? []) {
        await executeStep(runtime, phase, step);
      }
    }

    await writeSummary(runtime);
  } finally {
    await stopLocalServer(runtime);
    await restoreWorkspace(runtime);
  }
}

await main();
