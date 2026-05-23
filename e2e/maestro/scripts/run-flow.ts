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
  abortOnOutput?: (output: string) => string | null;
  activityPaths?: string[];
  idleTimeoutMs?: number;
  logPath: string;
  streamOutput?: boolean;
  timeoutMs?: number;
};

type ParsedEnvFile = Record<string, string>;

function parsePortEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return port;
}

type DeveloperE2ESetup = {
  appBaseUrl: URL;
};

type ControlJobState = {
  error?: string;
  result?: Record<string, unknown>;
  status?: string;
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
const CONTROL_JOB_HTTP_TIMEOUT_MS = 120 * 1000;
const CONTROL_JOB_TIMEOUT_MS = Number(
  process.env.HOT_UPDATER_E2E_CONTROL_JOB_TIMEOUT_MS || 45 * 60 * 1000,
);
const CONTROL_JOB_POLL_INTERVAL_MS = 1000;
const CONTROL_JOB_RETRY_LOG_INTERVAL_MS = 30 * 1000;
const PORT_STATE_PATH = path.join(E2E_RUNTIME_DIR, "server-port.txt");
const IOS_APP_ID = "org.reactjs.native.example.HotUpdaterExample";
const ANDROID_APP_ID = "com.hotupdaterexample";
const ANDROID_MAESTRO_DRIVER_PACKAGES = [
  "dev.mobile.maestro",
  "dev.mobile.maestro.test",
];
const DEFAULT_MAESTRO_DRIVER_PORT = 7001;
const ANDROID_MAESTRO_DRIVER_DEVICE_PORT = 7001;
const MAESTRO_DRIVER_HOST_PORT = parsePortEnv(
  "HOT_UPDATER_E2E_MAESTRO_DRIVER_PORT",
  DEFAULT_MAESTRO_DRIVER_PORT,
);
const ANDROID_MAESTRO_DRIVER_RUNNER =
  "dev.mobile.maestro.test/androidx.test.runner.AndroidJUnitRunner";
const MAESTRO_CLIENT_JAR_PATH = path.join(
  os.homedir(),
  ".maestro/lib/maestro-client.jar",
);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const MAESTRO_TRANSPORT_ATTEMPTS = 3;
const MAESTRO_TRANSPORT_RETRY_DELAY_MS = 2000;
const MAESTRO_DRIVER_STARTUP_TIMEOUT_MS =
  process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT || "240000";
const MAESTRO_DRIVER_HOST_PORT_PATTERN = String(
  MAESTRO_DRIVER_HOST_PORT,
).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAESTRO_ANDROID_TRANSPORT_PATTERNS = [
  /Not able to reach the gRPC server while processing deviceInfo command/i,
  /StatusRuntimeException:\s*UNAVAILABLE/i,
  /Command failed \(tcp:\d+\): closed/i,
  /dadb\.forwarding\.TcpForwarder/i,
  /Failed to launch app/i,
  /Maestro Android transport failure before E2E mutation/i,
  /Maestro command idle timeout/i,
  /ShouldNotReachHere: API object must not be garbage collected/i,
  /Unable to launch app/i,
];
const MAESTRO_IOS_TRANSPORT_PATTERNS = [
  new RegExp(
    `Failed to connect to /127\\.0\\.0\\.1:${MAESTRO_DRIVER_HOST_PORT_PATTERN}`,
    "i",
  ),
  /Failed to set permissions/i,
  /java\.io\.EOFException/i,
  /iOS driver not ready in time/i,
  /Launch app "\$\{APP_ID\}" FAILED/i,
  /Maestro iOS transport failure before E2E mutation/i,
  /Unable to set permissions for app/i,
  new RegExp(
    `unexpected end of stream on http://127\\.0\\.0\\.1:${MAESTRO_DRIVER_HOST_PORT_PATTERN}`,
    "i",
  ),
];
const MAESTRO_TRANSPORT_PATTERNS_BY_PLATFORM = {
  android: MAESTRO_ANDROID_TRANSPORT_PATTERNS,
  ios: MAESTRO_IOS_TRANSPORT_PATTERNS,
} satisfies Record<Platform, RegExp[]>;
const MAESTRO_UNSAFE_RETRY_ENDPOINT_PATTERN =
  /<--\s+POST\s+\/e2e\/(?:assert-|capture-|jobs\/(?:deploy-bundle|patch-bundle|wait-for-metadata)|reinstall-built-in-app|wait-for-crash-recovery|write-summary)\b/i;
const MAESTRO_FLOW_IDLE_TIMEOUT_MS = Number(
  process.env.MAESTRO_FLOW_IDLE_TIMEOUT_MS || 30 * 60 * 1000,
);
const MAESTRO_FLOW_TIMEOUT_MS = Number(
  process.env.MAESTRO_FLOW_TIMEOUT_MS || 45 * 60 * 1000,
);
const MAESTRO_LOG_ACTIVITY_POLL_MS = 5000;
const MAESTRO_LOCK_FILE = process.env.HOT_UPDATER_E2E_MAESTRO_LOCK_FILE;
const MAESTRO_LOCK_HELD_ENV = "HOT_UPDATER_E2E_MAESTRO_LOCK_HELD";
const MAESTRO_LOCK_POLL_MS = 1000;
const MAESTRO_LOCK_WAIT_LOG_INTERVAL_MS = 20 * 1000;
const COMMAND_TERMINATE_GRACE_MS = 5000;
const ACTIVE_LOGGED_CHILDREN = new Set<ReturnType<typeof spawn>>();
let terminationSignal: NodeJS.Signals | null = null;
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

function isNodeErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = HTTP_TIMEOUT_MS,
) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readJsonResponse<T>(response: Response, label: string) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function formatFetchFailure(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause =
    "cause" in error && error.cause instanceof Error
      ? `: ${error.cause.message}`
      : "";
  return `${error.message}${cause}`;
}

async function startControlJob(controlUrl: string, pathName: string) {
  const deadline = Date.now() + CONTROL_JOB_TIMEOUT_MS;
  let lastLogAt = 0;

  for (;;) {
    try {
      const response = await fetchWithTimeout(
        `${controlUrl}${pathName}`,
        {
          method: "POST",
        },
        CONTROL_JOB_HTTP_TIMEOUT_MS,
      );
      const body = await readJsonResponse<{ jobId?: string }>(
        response,
        pathName,
      );
      if (!body.jobId) {
        throw new Error(`${pathName} did not return a jobId`);
      }
      return body.jobId;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `${pathName} did not start within ${formatDuration(
            CONTROL_JOB_TIMEOUT_MS,
          )}: ${formatFetchFailure(error)}`,
        );
      }

      const now = Date.now();
      if (now - lastLogAt >= CONTROL_JOB_RETRY_LOG_INTERVAL_MS) {
        p.log.info(
          `Retrying ${pathName} after transient control fetch failure: ${formatFetchFailure(
            error,
          )}`,
        );
        lastLogAt = now;
      }
      await sleep(CONTROL_JOB_POLL_INTERVAL_MS);
    }
  }
}

async function waitForControlJob(controlUrl: string, jobId: string) {
  const deadline = Date.now() + CONTROL_JOB_TIMEOUT_MS;
  let lastLogAt = 0;

  for (;;) {
    let body: ControlJobState;
    try {
      const response = await fetchWithTimeout(
        `${controlUrl}/e2e/jobs/${jobId}`,
        {},
        CONTROL_JOB_HTTP_TIMEOUT_MS,
      );
      body = await readJsonResponse<ControlJobState>(
        response,
        `/e2e/jobs/${jobId}`,
      );
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Control job ${jobId} did not finish within ${formatDuration(
            CONTROL_JOB_TIMEOUT_MS,
          )}: ${formatFetchFailure(error)}`,
        );
      }

      const now = Date.now();
      if (now - lastLogAt >= CONTROL_JOB_RETRY_LOG_INTERVAL_MS) {
        p.log.info(
          `Waiting for control job ${jobId} after transient fetch failure: ${formatFetchFailure(
            error,
          )}`,
        );
        lastLogAt = now;
      }
      await sleep(CONTROL_JOB_POLL_INTERVAL_MS);
      continue;
    }

    if (body.status === "succeeded") {
      return body.result ?? {};
    }
    if (body.status === "failed") {
      throw new Error(body.error ?? `Control job ${jobId} failed`);
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Control job ${jobId} did not finish within ${formatDuration(
          CONTROL_JOB_TIMEOUT_MS,
        )}`,
      );
    }
    await sleep(CONTROL_JOB_POLL_INTERVAL_MS);
  }
}

async function runBootstrapBeforeMaestro(controlUrl: string, flow: string) {
  const flowSource = await fsPromises.readFile(flow, "utf8");
  if (!/\bACTION:\s*bootstrap\b/.test(flowSource)) {
    return;
  }

  p.log.info("Prepare native app before Maestro driver");
  const jobId = await startControlJob(controlUrl, "/e2e/jobs/bootstrap");
  await waitForControlJob(controlUrl, jobId);
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

function installTerminationHandlers() {
  const handleSignal = (signal: NodeJS.Signals) => {
    terminationSignal = signal;
    for (const child of ACTIVE_LOGGED_CHILDREN) {
      terminateChildProcess(child, "SIGTERM");
    }
    if (ACTIVE_LOGGED_CHILDREN.size === 0) {
      process.exit(signal === "SIGINT" ? 130 : 143);
    }

    const killTimer = setTimeout(() => {
      for (const child of ACTIVE_LOGGED_CHILDREN) {
        terminateChildProcess(child, "SIGKILL");
      }
    }, COMMAND_TERMINATE_GRACE_MS);
    killTimer.unref();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}

function javaToolOptionsWithUserHome(homeDir: string) {
  const userHomeOption = `-Duser.home=${homeDir}`;
  const existing = process.env.JAVA_TOOL_OPTIONS?.trim();
  return existing ? `${existing} ${userHomeOption}` : userHomeOption;
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
  ACTIVE_LOGGED_CHILDREN.add(child);
  let timeoutReason: string | null = null;
  let lastActivityAt = Date.now();
  let activityCheckPending = false;
  const activityPathSnapshots = new Map<string, string>();
  let activityTimer: NodeJS.Timeout | null = null;
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
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const resetIdleTimer = () => {
    if (!options.idleTimeoutMs) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      const idleForMs = Date.now() - lastActivityAt;
      if (idleForMs < (options.idleTimeoutMs ?? 0)) {
        resetIdleTimer();
        return;
      }
      terminateForTimeout(
        `Maestro command idle timeout after ${formatDuration(options.idleTimeoutMs ?? 0)}`,
      );
    }, options.idleTimeoutMs);
    idleTimer.unref();
  };
  const checkActivityPaths = async () => {
    if (!options.activityPaths || activityCheckPending) {
      return;
    }

    activityCheckPending = true;
    try {
      for (const activityPath of options.activityPaths) {
        const stats = await fsPromises.stat(activityPath).catch(() => null);
        const nextSnapshot = stats ? `${stats.mtimeMs}:${stats.size}` : "";
        const previousSnapshot = activityPathSnapshots.get(activityPath);
        activityPathSnapshots.set(activityPath, nextSnapshot);
        if (
          previousSnapshot !== undefined &&
          nextSnapshot !== previousSnapshot
        ) {
          markActivity();
          resetIdleTimer();
        }
      }
    } finally {
      activityCheckPending = false;
    }
  };
  const handleOutput = (chunk: Buffer | string, output: NodeJS.WriteStream) => {
    markActivity();
    resetIdleTimer();
    logStream.write(chunk);
    if (options.streamOutput) {
      output.write(chunk);
    }

    const abortReason = options.abortOnOutput?.(String(chunk));
    if (abortReason) {
      terminateForTimeout(abortReason);
    }
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
  if (options.activityPaths && options.activityPaths.length > 0) {
    void checkActivityPaths();
    activityTimer = setInterval(() => {
      void checkActivityPaths();
    }, MAESTRO_LOG_ACTIVITY_POLL_MS);
    activityTimer.unref();
  }

  child.stdout?.on("data", (chunk: Buffer | string) => {
    handleOutput(chunk, process.stdout);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    handleOutput(chunk, process.stderr);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  ACTIVE_LOGGED_CHILDREN.delete(child);
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  if (activityTimer) {
    clearInterval(activityTimer);
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

  if (terminationSignal && !options.allowFailure) {
    throw new Error(
      [
        `${command} ${args.join(" ")} terminated after ${terminationSignal}.`,
        `Full log: ${options.logPath}`,
      ].join("\n\n"),
    );
  }

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

function hasRetryableMaestroTransportSignal(platform: Platform, log: string) {
  return MAESTRO_TRANSPORT_PATTERNS_BY_PLATFORM[platform].some((pattern) =>
    pattern.test(log),
  );
}

async function isRetryableMaestroTransportFailure({
  debugOutputPath,
  platform,
  serverLogPath,
}: {
  debugOutputPath: string;
  platform: Platform;
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

  if (!hasRetryableMaestroTransportSignal(platform, combinedLog)) {
    return false;
  }

  return !MAESTRO_UNSAFE_RETRY_ENDPOINT_PATTERN.test(stripAnsi(serverLog));
}

function getPreMutationTransportAbortReason(
  platform: Platform,
  output: string,
  serverLogPath: string,
) {
  const cleanOutput = stripAnsi(output);
  if (!hasRetryableMaestroTransportSignal(platform, cleanOutput)) {
    return null;
  }

  const serverLog = fs.existsSync(serverLogPath)
    ? stripAnsi(fs.readFileSync(serverLogPath, "utf8"))
    : "";
  if (MAESTRO_UNSAFE_RETRY_ENDPOINT_PATTERN.test(serverLog)) {
    return null;
  }

  return `Maestro ${platform} transport failure before E2E mutation`;
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

async function runMaestroWithTransportRetry({
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
  const effectiveMaestroBin = prepareMaestroDriverPortLauncher(maestroBin);
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
  const maestroHomeDir = path.join(
    E2E_RUNTIME_DIR,
    "maestro-home",
    `${platform}-${MAESTRO_DRIVER_HOST_PORT}`,
  );
  await fsPromises.mkdir(maestroHomeDir, { recursive: true });

  for (let attempt = 1; attempt <= MAESTRO_TRANSPORT_ATTEMPTS; attempt += 1) {
    const releaseMaestroLock = await acquireMaestroDriverLock();
    try {
      if (platform === "android") {
        p.log.info("Reset Android Maestro driver host state");
        await resetAndroidMaestroDriverHostState(deviceId);
        await ensureAndroidMaestroDriver(deviceId);
      } else {
        p.log.info("Reset iOS Maestro driver host state");
        await resetIosMaestroDriverHostState();
      }
      await runLogged(effectiveMaestroBin, maestroArgs, {
        abortOnOutput: (output) =>
          getPreMutationTransportAbortReason(platform, output, serverLogPath),
        cwd: REPO_DIR,
        env: {
          [MAESTRO_LOCK_HELD_ENV]: "1",
          HOME: maestroHomeDir,
          JAVA_TOOL_OPTIONS: javaToolOptionsWithUserHome(maestroHomeDir),
          MAESTRO_DRIVER_STARTUP_TIMEOUT: MAESTRO_DRIVER_STARTUP_TIMEOUT_MS,
        },
        activityPaths: [
          path.join(debugOutputPath, "maestro.log"),
          serverLogPath,
        ],
        idleTimeoutMs: MAESTRO_FLOW_IDLE_TIMEOUT_MS,
        logPath: path.join(resultsDir, "maestro.log"),
        streamOutput: true,
        timeoutMs: MAESTRO_FLOW_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      const canRetry =
        attempt < MAESTRO_TRANSPORT_ATTEMPTS &&
        (await isRetryableMaestroTransportFailure({
          debugOutputPath,
          platform,
          serverLogPath,
        }));

      if (!canRetry) {
        throw error;
      }

      p.log.warning(
        `Retry ${platform}/${scenarioName} after transient Maestro ${platform} transport failure`,
      );
      await preserveMaestroAttemptArtifacts(resultsDir, attempt);
      await sleep(MAESTRO_TRANSPORT_RETRY_DELAY_MS);
    } finally {
      await resetMaestroDriverState(platform, deviceId);
      await releaseMaestroLock();
    }
  }
}

function resolveMaestroAppHome(maestroBin: string) {
  const resolvedBin =
    maestroBin.includes(path.sep) && fs.existsSync(maestroBin)
      ? fs.realpathSync(maestroBin)
      : runCapture("which", [maestroBin]).trim();
  return path.dirname(path.dirname(resolvedBin));
}

function findMaestroCliJar(appHome: string) {
  const libDir = path.join(appHome, "lib");
  const jarName = fs
    .readdirSync(libDir)
    .find((fileName: string) => /^maestro-cli.*\.jar$/.test(fileName));
  if (!jarName) {
    throw new Error(`Maestro CLI jar not found under ${libDir}`);
  }
  return path.join(libDir, jarName);
}

function patchMaestroTestCommandClass(classPath: string, port: number) {
  const original = fs.readFileSync(classPath);
  const from = Buffer.from([0x11, 0x1b, 0x59]);
  const to = Buffer.from([0x11, (port >> 8) & 0xff, port & 0xff]);
  const patched = Buffer.from(original);
  let replacements = 0;
  let offset = 0;

  while ((offset = patched.indexOf(from, offset)) !== -1) {
    to.copy(patched, offset);
    replacements += 1;
    offset += to.length;
  }

  if (replacements === 0) {
    throw new Error("Unable to patch Maestro TestCommand driver port");
  }

  fs.writeFileSync(classPath, patched);
}

function prepareMaestroDriverPortLauncher(maestroBin: string) {
  if (MAESTRO_DRIVER_HOST_PORT === DEFAULT_MAESTRO_DRIVER_PORT) {
    return maestroBin;
  }

  const appHome = resolveMaestroAppHome(maestroBin);
  const cliJar = findMaestroCliJar(appHome);
  const patchDir = path.join(
    E2E_RUNTIME_DIR,
    "maestro-driver-port",
    String(MAESTRO_DRIVER_HOST_PORT),
  );
  const classPath = path.join(
    patchDir,
    "maestro/cli/command/TestCommand.class",
  );
  const launcherPath = path.join(patchDir, "bin/maestro");

  if (!fs.existsSync(launcherPath)) {
    fs.rmSync(patchDir, { recursive: true, force: true });
    fs.mkdirSync(patchDir, { recursive: true });
    runCapture("jar", ["xf", cliJar, "maestro/cli/command/TestCommand.class"], {
      cwd: patchDir,
    });
    patchMaestroTestCommandClass(classPath, MAESTRO_DRIVER_HOST_PORT);
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(
      launcherPath,
      [
        "#!/bin/sh",
        "set -eu",
        `APP_HOME=${JSON.stringify(appHome)}`,
        `PATCH_DIR=${JSON.stringify(patchDir)}`,
        'if [ -n "${JAVA_HOME:-}" ]; then',
        '  JAVA_CMD="$JAVA_HOME/bin/java"',
        "else",
        '  JAVA_CMD="java"',
        "fi",
        'exec "$JAVA_CMD" -classpath "$PATCH_DIR:$APP_HOME/lib/*" maestro.cli.AppKt "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.chmodSync(launcherPath, 0o755);
  }

  return launcherPath;
}

async function acquireAtomicDirectoryLock(lockDir: string) {
  for (;;) {
    try {
      await fsPromises.mkdir(lockDir, { recursive: false });
      return async () => {
        await fsPromises.rm(lockDir, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) {
        throw error;
      }

      const stats = await fsPromises.stat(lockDir).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > 10_000) {
        await fsPromises.rm(lockDir, { force: true, recursive: true });
        continue;
      }
      await sleep(50);
    }
  }
}

async function withMaestroLockState<T>(callback: () => Promise<T>) {
  if (!MAESTRO_LOCK_FILE) {
    return callback();
  }

  const release = await acquireAtomicDirectoryLock(
    `${MAESTRO_LOCK_FILE}.state-lock`,
  );
  try {
    return await callback();
  } finally {
    await release();
  }
}

async function readCounter(filePath: string) {
  const value = await fsPromises.readFile(filePath, "utf8").catch((error) => {
    if (isNodeErrorCode(error, "ENOENT")) {
      return "0";
    }
    throw error;
  });
  const parsed = Number.parseInt(value.trim() || "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function writeCounter(filePath: string, value: number) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(tempPath, `${value}\n`);
  await fsPromises.rename(tempPath, filePath);
}

async function acquireMaestroDriverLock() {
  if (!MAESTRO_LOCK_FILE) {
    return async () => {};
  }

  await fsPromises.mkdir(path.dirname(MAESTRO_LOCK_FILE), { recursive: true });
  const ticketFile = `${MAESTRO_LOCK_FILE}.ticket`;
  const turnFile = `${MAESTRO_LOCK_FILE}.turn`;
  const ticket = await withMaestroLockState(async () => {
    const nextTicket = await readCounter(ticketFile);
    await writeCounter(ticketFile, nextTicket + 1);
    if (!fs.existsSync(turnFile)) {
      await writeCounter(turnFile, 0);
    }
    return nextTicket;
  });

  const waitStartedAt = Date.now();
  let lastWaitLogAt = 0;
  for (;;) {
    const turn = await withMaestroLockState(() => readCounter(turnFile));
    if (turn === ticket) {
      break;
    }

    const now = Date.now();
    if (now - lastWaitLogAt >= MAESTRO_LOCK_WAIT_LOG_INTERVAL_MS) {
      const waitedSeconds = Math.floor((now - waitStartedAt) / 1000);
      console.error(
        `hot-updater-e2e: waiting for maestro driver lock (${waitedSeconds}s)`,
      );
      lastWaitLogAt = now;
    }
    await sleep(MAESTRO_LOCK_POLL_MS);
  }

  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    await withMaestroLockState(async () => {
      const turn = await readCounter(turnFile);
      if (turn <= ticket) {
        await writeCounter(turnFile, ticket + 1);
      }
    });
  };
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

function maestroDriverPortResetCommand(port: number) {
  return [
    `pids="$(lsof -nP -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"`,
    `if [[ -z "$pids" ]]; then pids="$(lsof -nP -ti tcp:${port} 2>/dev/null || true)"; fi`,
    'if [[ -n "$pids" ]]; then kill -9 $pids 2>/dev/null || true; fi',
  ].join("\n");
}

function iosMaestroDriverHostResetCommand(port: number) {
  if (port !== DEFAULT_MAESTRO_DRIVER_PORT) {
    return maestroDriverPortResetCommand(port);
  }

  return [
    "pkill -f '[m]aestro-driver-ios-config\\\\.xctestrun' 2>/dev/null || true",
    "pkill -f '[m]aestro_xctestrunner' 2>/dev/null || true",
    maestroDriverPortResetCommand(port),
  ].join("\n");
}

async function resetMaestroDriverPortState() {
  runCapture(
    "/bin/zsh",
    ["-lc", maestroDriverPortResetCommand(MAESTRO_DRIVER_HOST_PORT)],
    {
      allowFailure: true,
    },
  );
  await sleep(1000);
}

async function resetIosMaestroDriverHostState() {
  runCapture(
    "/bin/zsh",
    ["-lc", iosMaestroDriverHostResetCommand(MAESTRO_DRIVER_HOST_PORT)],
    {
      allowFailure: true,
    },
  );
  await sleep(1000);
}

async function resetAndroidMaestroDriverHostState(deviceId: string) {
  runCapture(
    "adb",
    ["-s", deviceId, "forward", "--remove", `tcp:${MAESTRO_DRIVER_HOST_PORT}`],
    { allowFailure: true },
  );
  stopAndroidMaestroDriver(deviceId);
  await resetMaestroDriverPortState();
}

async function resetMaestroDriverState(platform: Platform, deviceId: string) {
  if (platform === "android") {
    await resetAndroidMaestroDriverHostState(deviceId);
    return;
  }

  await resetIosMaestroDriverHostState();
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

function isAndroidPackageInstalled(deviceId: string, packageName: string) {
  return runCapture(
    "adb",
    ["-s", deviceId, "shell", "pm", "list", "packages", packageName],
    { allowFailure: true },
  ).includes(`package:${packageName}`);
}

function ensureAndroidMaestroDriverPackages(deviceId: string) {
  if (
    ANDROID_MAESTRO_DRIVER_PACKAGES.every((packageName) =>
      isAndroidPackageInstalled(deviceId, packageName),
    )
  ) {
    return;
  }

  if (!fs.existsSync(MAESTRO_CLIENT_JAR_PATH)) {
    throw new Error(`Maestro client jar not found: ${MAESTRO_CLIENT_JAR_PATH}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-driver-"));
  try {
    runCapture("jar", ["xf", MAESTRO_CLIENT_JAR_PATH, "maestro-app.apk"], {
      cwd: tempDir,
    });
    runCapture("jar", ["xf", MAESTRO_CLIENT_JAR_PATH, "maestro-server.apk"], {
      cwd: tempDir,
    });
    runCapture("adb", [
      "-s",
      deviceId,
      "install",
      "-r",
      path.join(tempDir, "maestro-app.apk"),
    ]);
    runCapture("adb", [
      "-s",
      deviceId,
      "install",
      "-r",
      path.join(tempDir, "maestro-server.apk"),
    ]);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

async function waitForTcpPort(port: number, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(
        { host: DEFAULT_SERVER_HOST, port },
        () => {
          socket.end();
          resolve(true);
        },
      );
      socket.once("error", () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) {
      return;
    }
    await sleep(1000);
  }

  throw new Error(
    `Timed out waiting for Android Maestro driver on tcp:${port}`,
  );
}

function startAndroidMaestroInstrumentation(deviceId: string) {
  const instrument = spawn(
    "adb",
    [
      "-s",
      deviceId,
      "shell",
      "am",
      "instrument",
      "-w",
      ANDROID_MAESTRO_DRIVER_RUNNER,
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  instrument.unref();
}

function stopAndroidMaestroDriver(deviceId: string) {
  for (const packageName of ANDROID_MAESTRO_DRIVER_PACKAGES) {
    runCapture(
      "adb",
      ["-s", deviceId, "shell", "am", "force-stop", packageName],
      {
        allowFailure: true,
      },
    );
  }
}

async function ensureAndroidMaestroDriver(deviceId: string) {
  ensureAndroidMaestroDriverPackages(deviceId);
  runCapture("adb", [
    "-s",
    deviceId,
    "forward",
    `tcp:${MAESTRO_DRIVER_HOST_PORT}`,
    `tcp:${ANDROID_MAESTRO_DRIVER_DEVICE_PORT}`,
  ]);

  const driverPid = runCapture(
    "adb",
    ["-s", deviceId, "shell", "pidof", "dev.mobile.maestro"],
    { allowFailure: true },
  );
  if (!driverPid) {
    startAndroidMaestroInstrumentation(deviceId);
  }

  try {
    await waitForTcpPort(MAESTRO_DRIVER_HOST_PORT, 10);
    return;
  } catch (error) {
    if (!driverPid) {
      throw error;
    }
  }

  stopAndroidMaestroDriver(deviceId);
  startAndroidMaestroInstrumentation(deviceId);
  await waitForTcpPort(MAESTRO_DRIVER_HOST_PORT);
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
  p.log.info(`Maestro driver port: ${MAESTRO_DRIVER_HOST_PORT}`);

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
  ACTIVE_LOGGED_CHILDREN.add(serverProcess);

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
    ACTIVE_LOGGED_CHILDREN.delete(serverProcess);
    serverLogStream.end();
  };

  try {
    await waitForHttp(serverBaseUrl);
    await runBootstrapBeforeMaestro(serverBaseUrl, options.flow);

    await runMaestroWithTransportRetry({
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

installTerminationHandlers();

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unknown run-flow error";
  p.log.error(message);
  process.exit(1);
}
