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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(__dirname, "../..");
const REPO_DIR = path.resolve(EXAMPLE_DIR, "../..");
const SERVER_DIR = path.join(REPO_DIR, "examples-server/hono-e2e-local");
const RESULTS_ROOT = path.join(EXAMPLE_DIR, ".maestro/results");
const DEFAULT_SERVER_PORT = Number(process.env.HOT_UPDATER_SERVER_PORT || 3007);
const DEFAULT_SERVER_HOST = "127.0.0.1";
const IOS_APP_ID = "org.reactjs.native.example.HotUpdaterExample";
const ANDROID_APP_ID = "com.hotupdaterexample";
const IOS_FLOW_PATH = path.join(EXAMPLE_DIR, ".maestro/flows/release-ota-recovery.yaml");
const ANDROID_FLOW_PATH = IOS_FLOW_PATH;

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      options.platform = argv[index + 1];
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
    "  node ./scripts/e2e/run-maestro-flow.mjs --platform <ios|android>",
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

  const logStream = fs.createWriteStream(options.logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => logStream.write(chunk));
  child.stderr.on("data", (chunk) => logStream.write(chunk));

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.platform) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }

  if (!["ios", "android"].includes(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}`);
  }

  const platform = options.platform;
  const maestroBin = resolveMaestroBin();
  const resultsDir = path.join(RESULTS_ROOT, platform);
  await fsPromises.rm(resultsDir, { recursive: true, force: true });
  await fsPromises.mkdir(resultsDir, { recursive: true });

  const serverPort = await resolveServerPort(DEFAULT_SERVER_PORT);
  const serverBaseUrl = `http://${DEFAULT_SERVER_HOST}:${serverPort}`;
  const publicBaseUrl =
    platform === "android"
      ? `http://10.0.2.2:${serverPort}`
      : serverBaseUrl;

  let deviceId = "";
  let appId = "";
  let flowPath = "";

  if (platform === "ios") {
    const simulatorName = process.env.IOS_SIMULATOR_NAME || "iPhone 16";
    deviceId = resolveIosSimulatorUdid(simulatorName);
    ensureIosSimulatorBooted(deviceId);
    await fsPromises.writeFile(
      path.join(resultsDir, "maestro-device.log"),
      `Using iOS simulator ${simulatorName} (${deviceId})\n`,
    );
    appId = IOS_APP_ID;
    flowPath = IOS_FLOW_PATH;
  } else {
    deviceId = resolveAndroidSerial();
    appId = ANDROID_APP_ID;
    flowPath = ANDROID_FLOW_PATH;
  }

  await fsPromises.rm(path.join(SERVER_DIR, "data"), {
    recursive: true,
    force: true,
  });
  await fsPromises.rm(path.join(SERVER_DIR, "storage"), {
    recursive: true,
    force: true,
  });
  await fsPromises.mkdir(path.join(SERVER_DIR, "data"), { recursive: true });
  await fsPromises.mkdir(path.join(SERVER_DIR, "storage"), { recursive: true });

  await runLogged(
    "pnpm",
    ["exec", "hot-updater", "db", "migrate", "src/db.ts", "--yes"],
    {
      cwd: SERVER_DIR,
      env: {
        HOT_UPDATER_E2E_STORAGE_DIR: path.join(SERVER_DIR, "storage"),
        HOT_UPDATER_PUBLIC_BASE_URL: publicBaseUrl,
        PORT: String(serverPort),
        TEST_DB_PATH: path.join(SERVER_DIR, "data/hot-updater-e2e"),
      },
      logPath: path.join(resultsDir, "server-migrate.log"),
    },
  );

  const serverLogPath = path.join(resultsDir, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "w" });
  const serverProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      HOT_UPDATER_E2E_ANDROID_APK_PATH:
        "android/app/build/outputs/apk/release/app-release.apk",
      HOT_UPDATER_E2E_APP_BASE_URL: `${publicBaseUrl}/hot-updater`,
      HOT_UPDATER_E2E_APP_ID: appId,
      HOT_UPDATER_E2E_DEVICE_ID: deviceId,
      HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH: "/tmp/hotupdater-v081-ios-maestro",
      HOT_UPDATER_E2E_PLATFORM: platform,
      HOT_UPDATER_E2E_RESULTS_DIR: resultsDir,
      HOT_UPDATER_E2E_SERVER_BASE_URL: serverBaseUrl,
      HOT_UPDATER_E2E_STORAGE_DIR: path.join(SERVER_DIR, "storage"),
      HOT_UPDATER_PUBLIC_BASE_URL: publicBaseUrl,
      PORT: String(serverPort),
      TEST_DB_PATH: path.join(SERVER_DIR, "data/hot-updater-e2e"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (chunk) => serverLogStream.write(chunk));
  serverProcess.stderr.on("data", (chunk) => serverLogStream.write(chunk));

  const stopServer = async () => {
    try {
      await fetch(`${serverBaseUrl}/e2e/cleanup`, { method: "POST" });
    } catch {}
    try {
      await fetch(`${serverBaseUrl}/shutdown`, { method: "POST" });
    } catch {}
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => {
      serverProcess.once("close", resolve);
      setTimeout(resolve, 3000);
    });
    serverLogStream.end();
  };

  try {
    await waitForHttp(`${serverBaseUrl}/hot-updater/version`);

    await runLogged(
      maestroBin,
      [
        "test",
        "--device",
        deviceId,
        "--debug-output",
        path.join(resultsDir, "debug"),
        "--flatten-debug-output",
        "--format",
        "JUNIT",
        "--output",
        path.join(resultsDir, "junit.xml"),
        "--test-output-dir",
        path.join(resultsDir, "artifacts"),
        "-e",
        `APP_ID=${appId}`,
        "-e",
        `CONTROL_URL=${serverBaseUrl}`,
        flowPath,
      ],
      {
        cwd: EXAMPLE_DIR,
        logPath: path.join(resultsDir, "maestro.log"),
      },
    );
  } finally {
    await stopServer();
  }
}

await main();
