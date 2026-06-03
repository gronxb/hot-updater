import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export type DetoxPlatform = "ios" | "android";

type ControlServerHandle = {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
};

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const resultsRoot = path.join(repoDir, "e2e/results/detox");
const iosAppId = "org.reactjs.native.example.HotUpdaterExample";
const androidAppId = "com.hotupdaterexample";

function parsePositivePort(value: string | undefined, name: string): string {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return String(port);
}

function resolveControlPort(env: NodeJS.ProcessEnv): string {
  return parsePositivePort(
    env.HOT_UPDATER_E2E_CONTROL_PORT ?? "3107",
    "HOT_UPDATER_E2E_CONTROL_PORT",
  );
}

function resolveControlBaseUrl(env: NodeJS.ProcessEnv): string {
  return (
    env.CONTROL_URL ??
    env.HOT_UPDATER_E2E_CONTROL_BASE_URL ??
    `http://127.0.0.1:${resolveControlPort(env)}`
  );
}

function resolveAppBaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.HOT_UPDATER_E2E_APP_BASE_URL) {
    return env.HOT_UPDATER_E2E_APP_BASE_URL;
  }
  if (env.HOT_UPDATER_CONTROL_BASE_URL) {
    return env.HOT_UPDATER_CONTROL_BASE_URL;
  }
  const providerPort = env.HOT_UPDATER_SERVER_PORT ?? env.PORT ?? "3007";
  return `http://127.0.0.1:${providerPort}/hot-updater`;
}

function resolveRuntimeConfigUrl(
  platform: DetoxPlatform,
  controlPort: string,
  env: NodeJS.ProcessEnv,
): string {
  if (env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL) {
    return env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL;
  }
  if (platform === "android") {
    const devicePort = parsePositivePort(
      env.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT ?? "3107",
      "HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT",
    );
    return `http://localhost:${devicePort}/e2e/runtime-config`;
  }
  return `http://localhost:${controlPort}/e2e/runtime-config`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function isLikelyUdid(value: string): boolean {
  return /^[0-9A-Fa-f-]{20,}$/.test(value);
}

function resolveIosSimulatorUdidByName(
  simulatorName: string,
  env: NodeJS.ProcessEnv,
): string {
  if (isLikelyUdid(simulatorName)) {
    return simulatorName;
  }

  const result = spawnSync(
    "xcrun",
    ["simctl", "list", "devices", "available", "-j"],
    {
      encoding: "utf8",
      env,
    },
  );
  if (result.status !== 0 || !result.stdout) {
    return simulatorName;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return simulatorName;
    }
    throw error;
  }
  const root = readRecord(parsed);
  const devices = readRecord(root?.devices);
  if (!devices) {
    return simulatorName;
  }

  for (const runtimeDevices of Object.values(devices)) {
    if (!Array.isArray(runtimeDevices)) {
      continue;
    }
    for (const device of runtimeDevices) {
      const simulator = readRecord(device);
      if (
        simulator?.name === simulatorName &&
        simulator.udid &&
        typeof simulator.udid === "string" &&
        simulator.isAvailable !== false
      ) {
        return simulator.udid;
      }
    }
  }

  return simulatorName;
}

function resolveDeviceId(
  platform: DetoxPlatform,
  env: NodeJS.ProcessEnv,
): string {
  if (env.HOT_UPDATER_E2E_DEVICE_ID) {
    return env.HOT_UPDATER_E2E_DEVICE_ID;
  }
  if (platform === "android") {
    return (
      env.HOT_UPDATER_E2E_ANDROID_SERIAL ??
      env.ANDROID_SERIAL ??
      "emulator-5554"
    );
  }
  return resolveIosSimulatorUdidByName(
    env.HOT_UPDATER_E2E_IOS_SIMULATOR_NAME ??
      env.IOS_SIMULATOR_NAME ??
      "iPhone 16",
    env,
  );
}

function resolveAppId(platform: DetoxPlatform, env: NodeJS.ProcessEnv): string {
  if (env.HOT_UPDATER_E2E_APP_ID) {
    return env.HOT_UPDATER_E2E_APP_ID;
  }
  return platform === "android" ? androidAppId : iosAppId;
}

function nodeOptionsForDetox(env: NodeJS.ProcessEnv): string {
  const existingOptions = (env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean);
  if (existingOptions.includes("--experimental-vm-modules")) {
    return existingOptions.join(" ");
  }
  return [...existingOptions, "--experimental-vm-modules"].join(" ");
}

export function buildDetoxChildEnv(
  platform: DetoxPlatform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const controlBaseUrl = resolveControlBaseUrl(env);
  return {
    ...env,
    CONTROL_URL: controlBaseUrl,
    HOT_UPDATER_E2E_CONTROL_BASE_URL: controlBaseUrl,
    HOT_UPDATER_E2E_PLATFORM: platform,
    NODE_OPTIONS: nodeOptionsForDetox(env),
  };
}

export function buildDetoxControlServerEnv(
  platform: DetoxPlatform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const controlPort = resolveControlPort(env);
  return {
    ...env,
    HOT_UPDATER_E2E_APP_BASE_URL: resolveAppBaseUrl(env),
    HOT_UPDATER_E2E_APP_ID: resolveAppId(platform, env),
    HOT_UPDATER_E2E_DEVICE_ID: resolveDeviceId(platform, env),
    HOT_UPDATER_E2E_PLATFORM: platform,
    HOT_UPDATER_E2E_RESULTS_DIR:
      env.HOT_UPDATER_E2E_RESULTS_DIR ?? path.join(resultsRoot, platform),
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL: resolveRuntimeConfigUrl(
      platform,
      controlPort,
      env,
    ),
    HOT_UPDATER_E2E_SERVER_HOST: env.HOT_UPDATER_E2E_SERVER_HOST ?? "127.0.0.1",
    PORT: controlPort,
  };
}

async function fetchIgnoringFailure(
  url: string,
  init?: RequestInit,
): Promise<void> {
  try {
    await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}

async function waitForControlServer(baseUrl: string): Promise<void> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for Detox control server ${baseUrl}: ${lastError}`,
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    setTimeout(() => resolve(), 3000);
  });
}

export async function startDetoxControlServer(
  platform: DetoxPlatform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlServerHandle> {
  if (env.CONTROL_URL || env.HOT_UPDATER_E2E_CONTROL_BASE_URL) {
    return {
      baseUrl: resolveControlBaseUrl(env),
      stop: async () => {},
    };
  }

  const serverEnv = buildDetoxControlServerEnv(platform, env);
  const controlBaseUrl = `http://${serverEnv.HOT_UPDATER_E2E_SERVER_HOST}:${serverEnv.PORT}`;
  await fs.mkdir(serverEnv.HOT_UPDATER_E2E_RESULTS_DIR ?? resultsRoot, {
    recursive: true,
  });

  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(repoDir, "e2e/maestro/server/index.ts"),
    ],
    {
      cwd: repoDir,
      env: serverEnv,
      stdio: "inherit",
    },
  );

  await waitForControlServer(controlBaseUrl);

  return {
    baseUrl: controlBaseUrl,
    stop: async () => {
      await fetchIgnoringFailure(`${controlBaseUrl}/e2e/cleanup`, {
        method: "POST",
      });
      await fetchIgnoringFailure(`${controlBaseUrl}/shutdown`, {
        method: "POST",
      });
      await stopChild(child);
    },
  };
}
