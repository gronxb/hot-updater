import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DetoxPlatform = "ios" | "android";

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

export function resolveControlBaseUrl(env: NodeJS.ProcessEnv): string {
  return (
    env.CONTROL_URL ??
    env.HOT_UPDATER_E2E_CONTROL_BASE_URL ??
    `http://127.0.0.1:${resolveControlPort(env)}`
  );
}

function stripEnvValueQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvAssignment(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = pattern.exec(line);
    if (!match?.[1]) continue;
    return stripEnvValueQuotes(match[1]);
  }
  return undefined;
}

function readEnvTargetAppBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const targetPath = env.HOT_UPDATER_E2E_ENV_TARGET_PATH;
  if (!targetPath) return undefined;

  try {
    return parseEnvAssignment(
      fs.readFileSync(targetPath, "utf8"),
      "HOT_UPDATER_APP_BASE_URL",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function resolveAppBaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.HOT_UPDATER_E2E_APP_BASE_URL) {
    return env.HOT_UPDATER_E2E_APP_BASE_URL;
  }
  if (env.HOT_UPDATER_APP_BASE_URL) {
    return env.HOT_UPDATER_APP_BASE_URL;
  }
  const envTargetAppBaseUrl = readEnvTargetAppBaseUrl(env);
  if (envTargetAppBaseUrl) {
    return envTargetAppBaseUrl;
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
      env.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT ?? controlPort,
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

function safeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveIosDerivedDataPath(
  platform: DetoxPlatform,
  controlPort: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (platform !== "ios") return undefined;
  if (env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH) {
    return env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH;
  }

  const scope = safeFileToken(
    [
      env.HOT_UPDATER_E2E_CHANNEL_NAMESPACE,
      env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE,
      env.HOT_UPDATER_E2E_IOS_SIMULATOR_NAME,
      env.HOT_UPDATER_E2E_DEVICE_ID,
      controlPort,
    ]
      .filter(Boolean)
      .join("-"),
  );
  return path.join(
    os.tmpdir(),
    `hotupdater-v085-ios-detox-${scope || controlPort}`,
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
  const iosDerivedDataPath = resolveIosDerivedDataPath(
    platform,
    controlPort,
    env,
  );
  return {
    ...env,
    HOT_UPDATER_E2E_APP_BASE_URL: resolveAppBaseUrl(env),
    HOT_UPDATER_E2E_APP_ID: resolveAppId(platform, env),
    HOT_UPDATER_E2E_DEVICE_ID: resolveDeviceId(platform, env),
    ...(iosDerivedDataPath
      ? { HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH: iosDerivedDataPath }
      : {}),
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
