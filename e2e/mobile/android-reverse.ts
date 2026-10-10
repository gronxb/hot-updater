import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MobileContext } from "./context.ts";

type ReverseMapping = { device: string; host: string };
type ExecuteAdb = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const execFileAsync = promisify(execFile);

const executeAdb: ExecuteAdb = async (args, env) => {
  const result = await execFileAsync("adb", args, {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.stdout;
};

function tcpPort(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`Invalid Android reverse port: ${value}`);
  }
  return `tcp:${Number(value)}`;
}

export function planAndroidReverses(env: NodeJS.ProcessEnv): ReverseMapping[] {
  const expected = new Map<string, string>();
  const appUrl = new URL(
    env.HOT_UPDATER_E2E_APP_BASE_URL ?? "http://localhost:3007/hot-updater",
  );
  if (appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1") {
    const appPort =
      appUrl.port || (appUrl.protocol === "https:" ? "443" : "80");
    expected.set(
      tcpPort(appPort),
      tcpPort(env.HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT ?? appPort),
    );
  }
  // Presigned download URLs send the device to the local profile's S3.
  if (env.AWS_S3_ENDPOINT !== undefined) {
    const storageUrl = new URL(env.AWS_S3_ENDPOINT);
    if (
      storageUrl.hostname === "localhost" ||
      storageUrl.hostname === "127.0.0.1"
    ) {
      const storagePort = tcpPort(
        storageUrl.port || (storageUrl.protocol === "https:" ? "443" : "80"),
      );
      expected.set(storagePort, storagePort);
    }
  }
  const controlDevice = tcpPort(
    env.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT ?? "3107",
  );
  const controlHost = tcpPort(
    env.PORT || env.HOT_UPDATER_E2E_CONTROL_PORT || "3107",
  );
  if (
    expected.has(controlDevice) &&
    expected.get(controlDevice) !== controlHost
  ) {
    throw new Error(
      `App and control Android reverse mappings conflict on ${controlDevice}`,
    );
  }
  expected.set(controlDevice, controlHost);
  return [...expected].map(([device, host]) => ({ device, host }));
}

function readReverses(output: string): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const line of output.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3)
      throw new Error(`Unexpected adb reverse entry: ${line}`);
    const [, device, host] = fields;
    if (mappings.has(device))
      throw new Error(`Duplicate adb reverse mapping: ${device}`);
    mappings.set(device, host);
  }
  return mappings;
}

/** Call before fixture bootstrap, with buildControlServerEnv's resolved env. */
export async function acquireAndroidReverses(
  context: MobileContext,
  env: NodeJS.ProcessEnv,
  execute: ExecuteAdb = executeAdb,
): Promise<() => Promise<void>> {
  if (context.platform !== "android") return async () => {};
  if (!context.deviceId || context.deviceId.includes("*")) {
    throw new Error("Android reverse requires an explicit leased device ID");
  }
  const expected = planAndroidReverses(env);
  const command = (args: string[]) =>
    execute(["-s", context.deviceId, "reverse", ...args], env);
  const existing = readReverses(await command(["--list"]));
  for (const { device, host } of expected) {
    const current = existing.get(device);
    if (current !== undefined && current !== host) {
      throw new Error(
        `Android reverse ${device} is already mapped to ${current}; expected ${host}`,
      );
    }
  }
  const owned = new Map<string, string>();
  const release = async () => {
    const errors: unknown[] = [];
    for (const [device, host] of owned) {
      try {
        const current = readReverses(await command(["--list"]));
        if (current.get(device) === host) await command(["--remove", device]);
        owned.delete(device);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        "Failed to release owned Android reverse mappings",
      );
  };
  try {
    for (const { device, host } of expected) {
      if (existing.has(device)) continue;
      await command(["--no-rebind", device, host]);
      owned.set(device, host);
    }
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Android reverse acquisition and cleanup failed",
      );
    }
    throw error;
  }
  return release;
}
