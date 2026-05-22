#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { p } from "../../../packages/cli-tools/src/prompts.ts";

type Platform = "ios" | "android";

type RunFlowOptions = {
  flow: string;
  help?: boolean;
  platform?: Platform | string;
  reuseApp: boolean;
};

type RunCaptureOptions = {
  allowFailure?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type RunLoggedOptions = RunCaptureOptions & {
  idleTimeoutMs?: number;
  logPath: string;
  streamOutput?: boolean;
  timeoutMs?: number;
};

type ParsedEnvFile = Record<string, string>;

type DeveloperE2ESetup = {
  appBaseUrl: URL;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(__dirname, "../../..");
const E2E_DIR = path.join(REPO_DIR, "e2e");
const E2E_MAESTRO_DIR = path.join(E2E_DIR, "maestro");
const E2E_RUNTIME_DIR = path.join(E2E_DIR, ".runtime");
const EXAMPLE_DIR = path.join(REPO_DIR, "examples/v0.85.0");
const RESULTS_ROOT = path.join(E2E_DIR, "results");
const LEGACY_STANDALONE_SERVER_PORT = 3007;
const DEFAULT_UPDATE_SERVER_BASE_URL = `http://localhost:${LEGACY_STANDALONE_SERVER_PORT}/hot-updater`;
const DEFAULT_SERVER_PORT = Number(
  process.env.HOT_UPDATER_E2E_CONTROL_PORT ||
    process.env.HOT_UPDATER_SERVER_PORT ||
    3107,
);
const DEFAULT_SERVER_HOST = "127.0.0.1";
const HTTP_TIMEOUT_MS = 5000;
const PORT_STATE_PATH = path.join(E2E_RUNTIME_DIR, "server-port.txt");
const IOS_APP_ID = "org.reactjs.native.example.HotUpdaterExample";
const ANDROID_APP_ID = "com.hotupdaterexample";
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const MAESTRO_ANDROID_TRANSPORT_ATTEMPTS = 3;
const MAESTRO_ANDROID_TRANSPORT_RETRY_DELAY_MS = 2000;
const MAESTRO_ANDROID_TRANSPORT_PATTERNS = [
  /Not able to reach the gRPC server while processing deviceInfo command/i,
  /StatusRuntimeException:\s*UNAVAILABLE/i,
  /Command failed \(tcp:\d+\): closed/i,
  /Maestro command idle timeout/i,
  /ShouldNotReachHere: API object must not be garbage collected/i,
];
const MAESTRO_FLOW_IDLE_TIMEOUT_MS = Number(
  process.env.MAESTRO_FLOW_IDLE_TIMEOUT_MS || 30 * 60 * 1000,
);
const MAESTRO_FLOW_TIMEOUT_MS = Number(
  process.env.MAESTRO_FLOW_TIMEOUT_MS || 45 * 60 * 1000,
);
const COMMAND_TERMINATE_GRACE_MS = 5000;
const DEFAULT_FLOW_PATH = path.join(
  E2E_MAESTRO_DIR,
  "flows/release-ota-recovery.yaml",
);

function getRequiredArgValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): RunFlowOptions {
  const options: RunFlowOptions = {
    flow: DEFAULT_FLOW_PATH,
    reuseApp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      options.platform = getRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--flow") {
      options.flow = path.resolve(
        REPO_DIR,
        getRequiredArgValue(argv, index, arg),
      );
      index += 1;
      continue;
    }
    if (arg === "--reuse-app") {
      options.reuseApp = true;
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
    "  node ./e2e/maestro/scripts/run-flow.ts --platform <ios|android> [--flow <path>] [--reuse-app]",
  ].join("\n");
}

function showUsage() {
  p.note(usage(), "Usage");
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

function parseEnvFile(source: string): ParsedEnvFile {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) {
          return null;
        }
        return [
          line.slice(0, separatorIndex).trim(),
          line.slice(separatorIndex + 1).trim(),
        ] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
}

function parseConfiguredUrl(
  name: string,
  rawValue: string,
  relativeEnvPath: string,
  exampleUrl: string,
) {
  try {
    return new URL(rawValue);
  } catch {
    throw new Error(
      [
        `Invalid ${name} in ${relativeEnvPath}: ${rawValue}`,
        `Expected a full URL such as ${exampleUrl}.`,
      ].join("\n"),
    );
  }
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

function ensureAndroidReverse(deviceId: string, appBaseUrl: URL) {
  if (!isLoopbackHost(appBaseUrl.hostname)) {
    return null;
  }

  const port = getUrlPort(appBaseUrl);
  runCapture("adb", ["-s", deviceId, "reverse", `tcp:${port}`, `tcp:${port}`]);

  return port;
}

async function validateDeveloperE2ESetup(
  platform: Platform,
): Promise<DeveloperE2ESetup> {
  const envPath = path.join(EXAMPLE_DIR, ".env.hotupdater");
  const envSource = fs.existsSync(envPath)
    ? await fsPromises.readFile(envPath, "utf8")
    : "";
  const parsedEnv = parseEnvFile(envSource);
  const appBaseUrlRaw =
    parsedEnv.HOT_UPDATER_APP_BASE_URL || DEFAULT_UPDATE_SERVER_BASE_URL;
  const relativeEnvPath = path.relative(REPO_DIR, envPath);
  const appBaseUrl = parseConfiguredUrl(
    "HOT_UPDATER_APP_BASE_URL",
    appBaseUrlRaw,
    relativeEnvPath,
    DEFAULT_UPDATE_SERVER_BASE_URL,
  );
  const controlPort = DEFAULT_SERVER_PORT;
  const appBaseUrlPort = getUrlPort(appBaseUrl);

  if (appBaseUrlPort === controlPort) {
    throw new Error(
      [
        `HOT_UPDATER_APP_BASE_URL=${appBaseUrlRaw} points at the Maestro control server port ${controlPort}.`,
        "Point the app at the standalone update server instead.",
        `Use a URL such as http://localhost:${LEGACY_STANDALONE_SERVER_PORT}/hot-updater.`,
      ].join("\n"),
    );
  }

  if (
    platform === "ios" &&
    (appBaseUrl.hostname === "10.0.2.2" || appBaseUrl.hostname === "10.0.3.2")
  ) {
    throw new Error(
      [
        `HOT_UPDATER_APP_BASE_URL=${appBaseUrlRaw} is Android-emulator-only and is not reachable from the iOS simulator.`,
        "iOS Maestro E2E does not rewrite .env.hotupdater.",
        `Use an iOS-simulator-reachable host such as http://127.0.0.1:${LEGACY_STANDALONE_SERVER_PORT}/hot-updater or a host LAN IP that both platforms can reach.`,
      ].join("\n"),
    );
  }

  return {
    appBaseUrl,
  };
}

function runCapture(
  command: string,
  args: string[],
  options: RunCaptureOptions = {},
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

async function fetchWithTimeout(url: string, options: RequestInit = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

function stripAnsi(value: string) {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function extractMeaningfulLogLines(contents: string, limit = 8) {
  const lines = stripAnsi(contents)
    .split(/\r?\n|\r/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const meaningful = lines.filter((line) =>
    /\b(error|failed|exception|invalid|missing|timed out|timeout|unable|canceled|not found|expected|observed|verificationpending|stagingbundleid|crashedbundleid|launchreport|metadatapath|deploy|hot-updater cli|remote-bundles)\b/i.test(
      line,
    ),
  );

  const selected = (meaningful.length > 0 ? meaningful : lines)
    .slice(-limit)
    .filter((line, index, array) => array.indexOf(line) === index);

  return selected;
}

async function readLogSummary(logPath: string, header: string) {
  if (!fs.existsSync(logPath)) {
    return null;
  }

  const contents = await fsPromises.readFile(logPath, "utf8");
  const lines = extractMeaningfulLogLines(contents);
  if (lines.length === 0) {
    return null;
  }

  return [header, ...lines.map((line) => `  ${line}`)].join("\n");
}

async function readTextIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return fsPromises.readFile(filePath, "utf8");
}

async function readMaestroFailureSummary(args: string[]) {
  const debugOutputIndex = args.indexOf("--debug-output");
  const debugOutputPath =
    debugOutputIndex === -1 ? undefined : args[debugOutputIndex + 1];

  if (!debugOutputPath) {
    return null;
  }

  const debugLogPath = path.join(debugOutputPath, "maestro.log");
  if (!fs.existsSync(debugLogPath)) {
    return null;
  }

  const debugContents = await fsPromises.readFile(debugLogPath, "utf8");
  const sections: string[] = [];
  const maestroSummaryLines = extractMeaningfulLogLines(debugContents);

  if (maestroSummaryLines.length > 0) {
    sections.push(
      [
        "Maestro failure summary:",
        ...maestroSummaryLines.map((line) => `  ${line}`),
      ].join("\n"),
    );
  }

  const resultsDir = path.dirname(debugOutputPath);
  const serverLogSummary = await readLogSummary(
    path.join(resultsDir, "server.log"),
    `E2E server log: ${path.join(resultsDir, "server.log")}`,
  );
  if (serverLogSummary) {
    sections.push(serverLogSummary);
  }

  const nestedLogPaths = Array.from(
    new Set(
      Array.from(debugContents.matchAll(/\bSee (\/\S+)/g), (match) => match[1]),
    ),
  );

  for (const nestedLogPath of nestedLogPaths) {
    const nestedSummary = await readLogSummary(
      nestedLogPath,
      `Underlying command log: ${nestedLogPath}`,
    );
    if (nestedSummary) {
      sections.push(nestedSummary);
      break;
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

async function formatCommandFailure(
  command: string,
  args: string[],
  logPath: string,
  exitCode: number | null,
) {
  const sections = [
    `${command} ${args.join(" ")} failed with code ${exitCode}.`,
  ];

  if (path.basename(command) === "maestro") {
    const maestroSummary = await readMaestroFailureSummary(args);
    if (maestroSummary) {
      sections.push(maestroSummary);
    }
  } else {
    const logSummary = await readLogSummary(logPath, `Command log: ${logPath}`);
    if (logSummary) {
      sections.push(logSummary);
    }
  }

  sections.push(`Full log: ${logPath}`);

  return sections.join("\n\n");
}

function formatDuration(ms: number) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

function terminateChildProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
) {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

async function runLogged(
  command: string,
  args: string[],
  options: RunLoggedOptions,
) {
  await fsPromises.mkdir(path.dirname(options.logPath), { recursive: true });

  const logStream = fs.createWriteStream(options.logPath, { flags: "w" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timeoutReason: string | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;
  const timeoutMessage = (reason: string) =>
    `${reason}; terminating ${command} ${args.join(" ")}`;
  const terminateForTimeout = (reason: string) => {
    if (timeoutReason) {
      return;
    }

    timeoutReason = reason;
    const message = `\n${timeoutMessage(reason)}\n`;
    logStream.write(message);
    if (options.streamOutput) {
      process.stderr.write(message);
    }

    terminateChildProcess(child, "SIGTERM");
    killTimer = setTimeout(() => {
      terminateChildProcess(child, "SIGKILL");
    }, COMMAND_TERMINATE_GRACE_MS);
    killTimer.unref();
  };
  const resetIdleTimer = () => {
    if (!options.idleTimeoutMs) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      terminateForTimeout(
        `Maestro command idle timeout after ${formatDuration(options.idleTimeoutMs ?? 0)}`,
      );
    }, options.idleTimeoutMs);
    idleTimer.unref();
  };

  if (options.timeoutMs) {
    hardTimer = setTimeout(() => {
      terminateForTimeout(
        `Command timeout after ${formatDuration(options.timeoutMs ?? 0)}`,
      );
    }, options.timeoutMs);
    hardTimer.unref();
  }
  resetIdleTimer();

  child.stdout?.on("data", (chunk: Buffer | string) => {
    resetIdleTimer();
    logStream.write(chunk);
    if (options.streamOutput) {
      process.stdout.write(chunk);
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    resetIdleTimer();
    logStream.write(chunk);
    if (options.streamOutput) {
      process.stderr.write(chunk);
    }
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  if (hardTimer) {
    clearTimeout(hardTimer);
  }
  if (killTimer) {
    clearTimeout(killTimer);
  }

  await new Promise<void>((resolve, reject) => {
    logStream.once("error", reject);
    logStream.end(() => resolve());
  });

  if (timeoutReason && !options.allowFailure) {
    throw new Error(
      [
        `${command} ${args.join(" ")} ${timeoutReason}.`,
        `Full log: ${options.logPath}`,
      ].join("\n\n"),
    );
  }

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      await formatCommandFailure(command, args, options.logPath, exitCode),
    );
  }
}

async function isRetryableAndroidMaestroTransportFailure({
  debugOutputPath,
  serverLogPath,
}: {
  debugOutputPath: string;
  serverLogPath: string;
}) {
  const debugLog = await readTextIfExists(
    path.join(debugOutputPath, "maestro.log"),
  );
  const commandLog = await readTextIfExists(
    path.join(path.dirname(debugOutputPath), "maestro.log"),
  );
  const serverLog = await readTextIfExists(serverLogPath);
  const combinedLog = `${debugLog}\n${commandLog}`;

  if (
    !MAESTRO_ANDROID_TRANSPORT_PATTERNS.some((pattern) =>
      pattern.test(combinedLog),
    )
  ) {
    return false;
  }

  return !/<--\s+POST\s+\/e2e\//.test(stripAnsi(serverLog));
}

async function moveIfExists(sourcePath: string, targetPath: string) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  await fsPromises.rm(targetPath, { force: true, recursive: true });
  await fsPromises.rename(sourcePath, targetPath);
}

async function preserveMaestroAttemptArtifacts(
  resultsDir: string,
  attempt: number,
) {
  await Promise.all([
    moveIfExists(
      path.join(resultsDir, "maestro.log"),
      path.join(resultsDir, `maestro.attempt-${attempt}.log`),
    ),
    moveIfExists(
      path.join(resultsDir, "junit.xml"),
      path.join(resultsDir, `junit.attempt-${attempt}.xml`),
    ),
    moveIfExists(
      path.join(resultsDir, "debug"),
      path.join(resultsDir, `debug.attempt-${attempt}`),
    ),
    moveIfExists(
      path.join(resultsDir, "artifacts"),
      path.join(resultsDir, `artifacts.attempt-${attempt}`),
    ),
  ]);
}

async function runMaestroWithAndroidTransportRetry({
  appId,
  controlUrl,
  deviceId,
  flow,
  maestroBin,
  platform,
  resultsDir,
  serverLogPath,
  scenarioName,
}: {
  appId: string;
  controlUrl: string;
  deviceId: string;
  flow: string;
  maestroBin: string;
  platform: Platform;
  resultsDir: string;
  serverLogPath: string;
  scenarioName: string;
}) {
  const debugOutputPath = path.join(resultsDir, "debug");
  const maestroArgs = [
    "test",
    "--device",
    deviceId,
    "--debug-output",
    debugOutputPath,
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
    `CONTROL_URL=${controlUrl}`,
    flow,
  ];

  for (
    let attempt = 1;
    attempt <= MAESTRO_ANDROID_TRANSPORT_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await runLogged(maestroBin, maestroArgs, {
        cwd: REPO_DIR,
        idleTimeoutMs: MAESTRO_FLOW_IDLE_TIMEOUT_MS,
        logPath: path.join(resultsDir, "maestro.log"),
        streamOutput: true,
        timeoutMs: MAESTRO_FLOW_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      const canRetry =
        platform === "android" &&
        attempt < MAESTRO_ANDROID_TRANSPORT_ATTEMPTS &&
        (await isRetryableAndroidMaestroTransportFailure({
          debugOutputPath,
          serverLogPath,
        }));

      if (!canRetry) {
        throw error;
      }

      p.log.warning(
        `Retry ${platform}/${scenarioName} after transient Maestro Android transport failure`,
      );
      await preserveMaestroAttemptArtifacts(resultsDir, attempt);
      await sleep(MAESTRO_ANDROID_TRANSPORT_RETRY_DELAY_MS);
    }
  }
}

async function resolveServerPort(
  preferredPort: number,
  allowRandomFallback: boolean,
) {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: DEFAULT_SERVER_HOST, port }, () => {
        const address = server.address();
        const actualPort =
          typeof address === "object" && address ? address.port : port;
        server.close((closeError?: Error) => {
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
    } catch (error) {
      if (!allowRandomFallback) {
        throw error;
      }
    }
  }

  if (!allowRandomFallback) {
    throw new Error(`Port ${preferredPort} is unavailable`);
  }

  return attempt(0);
}

async function waitForHttp(url: string, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetchWithTimeout(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function resolveIosSimulatorUdid(preferredName: string) {
  const output = runCapture("xcrun", [
    "simctl",
    "list",
    "devices",
    "available",
    "-j",
  ]);
  const data = JSON.parse(output) as {
    devices?: Record<
      string,
      Array<{
        isAvailable: boolean;
        name: string;
        state: string;
        udid: string;
      }>
    >;
  };

  const parseRuntimeWeight = (runtime: string) => {
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
        .filter(
          (device) => device.isAvailable && device.name.includes("iPhone"),
        )
        .map((device) => ({
          ...device,
          booted: device.state === "Booted" ? 1 : 0,
          exactName: device.name === preferredName ? 1 : 0,
          runtime,
          runtimeWeight: parseRuntimeWeight(runtime),
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

function ensureIosSimulatorBooted(simulatorUdid: string) {
  const listOutput = runCapture("xcrun", ["simctl", "list", "devices"]);
  const line = listOutput
    .split("\n")
    .find((entry: string) => entry.includes(simulatorUdid));
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
    .map((line: string) => line.trim().split(/\s+/))
    .find((columns: string[]) => columns[0] && columns[1] === "device");

  if (!match?.[0]) {
    throw new Error("No Android device or emulator is connected");
  }

  return match[0];
}

function getScenarioName(flowPath: string) {
  return path.basename(flowPath, path.extname(flowPath));
}

function formatRepoRelative(targetPath: string) {
  return path.relative(REPO_DIR, targetPath) || targetPath;
}

function shouldReuseStoredPort(storedPort: number) {
  if (!Number.isInteger(storedPort) || storedPort <= 0) {
    return false;
  }

  const explicitlyConfiguredLegacyPort =
    process.env.HOT_UPDATER_E2E_CONTROL_PORT ===
      String(LEGACY_STANDALONE_SERVER_PORT) ||
    process.env.HOT_UPDATER_SERVER_PORT ===
      String(LEGACY_STANDALONE_SERVER_PORT);

  if (
    storedPort === LEGACY_STANDALONE_SERVER_PORT &&
    !explicitlyConfiguredLegacyPort
  ) {
    return false;
  }

  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.platform) {
    showUsage();
    process.exit(options.help ? 0 : 1);
  }

  const platform = options.platform;
  if (platform !== "ios" && platform !== "android") {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const developerSetup = await validateDeveloperE2ESetup(platform);

  if (!fs.existsSync(options.flow)) {
    throw new Error(`Flow file does not exist: ${options.flow}`);
  }

  const scenarioName = getScenarioName(options.flow);
  const maestroBin = resolveMaestroBin();
  const resultsDir = path.join(RESULTS_ROOT, platform, scenarioName);

  await fsPromises.rm(resultsDir, { recursive: true, force: true });
  await fsPromises.mkdir(resultsDir, { recursive: true });
  await fsPromises.mkdir(E2E_RUNTIME_DIR, { recursive: true });

  const storedPort =
    options.reuseApp && fs.existsSync(PORT_STATE_PATH)
      ? Number((await fsPromises.readFile(PORT_STATE_PATH, "utf8")).trim())
      : Number.NaN;
  const preferredPort = shouldReuseStoredPort(storedPort)
    ? storedPort
    : DEFAULT_SERVER_PORT;
  const serverPort = await resolveServerPort(preferredPort, !options.reuseApp);
  await fsPromises.writeFile(PORT_STATE_PATH, `${serverPort}\n`);

  const serverBaseUrl = `http://${DEFAULT_SERVER_HOST}:${serverPort}`;

  p.log.step(`Start ${platform}/${scenarioName}`);
  p.log.info(`Flow: ${formatRepoRelative(options.flow)}`);
  p.log.info(`Results: ${formatRepoRelative(resultsDir)}`);
  p.log.info(`Control server: ${serverBaseUrl}`);

  let deviceId = "";
  let appId = "";

  if (platform === "ios") {
    const simulatorName = process.env.IOS_SIMULATOR_NAME || "iPhone 16";
    deviceId = resolveIosSimulatorUdid(simulatorName);
    ensureIosSimulatorBooted(deviceId);
    await fsPromises.writeFile(
      path.join(resultsDir, "maestro-device.log"),
      `Using iOS simulator ${simulatorName} (${deviceId})\n`,
    );
    appId = IOS_APP_ID;
  } else {
    deviceId = resolveAndroidSerial();
    const reversedPort = ensureAndroidReverse(
      deviceId,
      developerSetup.appBaseUrl,
    );
    const androidDeviceLogLines = [`Using Android device ${deviceId}`];
    if (reversedPort !== null) {
      const reverseMessage = `adb reverse tcp:${reversedPort} tcp:${reversedPort}`;
      androidDeviceLogLines.push(reverseMessage);
      p.log.info(
        `Android reverse: tcp:${reversedPort} -> host tcp:${reversedPort}`,
      );
    }
    await fsPromises.writeFile(
      path.join(resultsDir, "maestro-device.log"),
      `${androidDeviceLogLines.join("\n")}\n`,
    );
    appId = ANDROID_APP_ID;
  }

  await fsPromises.rm(E2E_RUNTIME_DIR, {
    recursive: true,
    force: true,
  });
  await fsPromises.mkdir(E2E_RUNTIME_DIR, { recursive: true });
  await fsPromises.writeFile(PORT_STATE_PATH, `${serverPort}\n`);

  const serverLogPath = path.join(resultsDir, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "w" });
  const serverProcess = spawn(
    "node",
    [
      "--experimental-strip-types",
      path.join(REPO_DIR, "e2e/maestro/server/index.ts"),
    ],
    {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        HOT_UPDATER_E2E_ANDROID_APK_PATH:
          "android/app/build/outputs/apk/release/app-release.apk",
        HOT_UPDATER_E2E_APP_BASE_URL: developerSetup.appBaseUrl.toString(),
        HOT_UPDATER_E2E_APP_ID: appId,
        HOT_UPDATER_E2E_DEVICE_ID: deviceId,
        HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH:
          "/tmp/hotupdater-v085-ios-maestro",
        HOT_UPDATER_E2E_PLATFORM: platform,
        HOT_UPDATER_E2E_RESULTS_DIR: resultsDir,
        HOT_UPDATER_E2E_REUSE_APP: String(options.reuseApp),
        HOT_UPDATER_E2E_SERVER_HOST: DEFAULT_SERVER_HOST,
        PORT: String(serverPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  serverProcess.stdout?.on("data", (chunk: Buffer | string) =>
    serverLogStream.write(chunk),
  );
  serverProcess.stderr?.on("data", (chunk: Buffer | string) =>
    serverLogStream.write(chunk),
  );

  const stopServer = async () => {
    try {
      await fetchWithTimeout(`${serverBaseUrl}/e2e/cleanup`, {
        method: "POST",
      });
    } catch {}
    try {
      await fetchWithTimeout(`${serverBaseUrl}/shutdown`, { method: "POST" });
    } catch {}
    serverProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      serverProcess.once("close", () => resolve());
      setTimeout(() => resolve(), 3000);
    });
    serverLogStream.end();
  };

  try {
    await waitForHttp(serverBaseUrl);

    await runMaestroWithAndroidTransportRetry({
      appId,
      controlUrl: serverBaseUrl,
      deviceId,
      flow: options.flow,
      maestroBin,
      platform,
      resultsDir,
      scenarioName,
      serverLogPath,
    });
    p.log.success(`Pass ${platform}/${scenarioName}`);
  } catch (error) {
    p.log.error(`Fail ${platform}/${scenarioName}`);
    throw error;
  } finally {
    await stopServer();
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown run-flow error";
  p.log.error(message);
  process.exit(1);
}
