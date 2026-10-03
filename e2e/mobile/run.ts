#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listScenarioNames,
  resolveSuiteScenarioNames,
} from "../shared/scenarios.ts";
import {
  buildControlServerEnv,
  startControlServer,
} from "../shared/scripts/control-server.ts";
import { startOwnedAgentDeviceDaemon } from "./agent-device-daemon.ts";
import { acquireAndroidReverses } from "./android-reverse.ts";
import type { MobileContext } from "./context.ts";
import { normalizeMobileResult, writeMobileResult } from "./result.ts";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const shutdownGraceMs = 150_000;

export function parseMobileOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const values: Record<string, string> = {};
  const scenarios = (env.HOT_UPDATER_E2E_SCENARIOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const flags = new Set<string>();
  const valueFlags = [
    "platform",
    "device",
    "session",
    "run-id",
    "head-sha",
    "profile",
    "results-dir",
    "suite",
    "scenario",
  ];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (["--dry-run", "--list", "--help", "-h"].includes(arg)) {
      flags.add(arg === "-h" ? "--help" : arg);
      continue;
    }
    const key = arg?.startsWith("--") ? arg.slice(2) : "";
    if (!valueFlags.includes(key)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${arg}`);
    if (key === "scenario") scenarios.push(value);
    else if (Object.hasOwn(values, key))
      throw new Error(`Duplicate argument: ${arg}`);
    else values[key] = value;
  }
  if (flags.has("--help") || flags.has("--list"))
    return { values, flags, scenarios };
  if (values.platform !== "ios" && values.platform !== "android")
    throw new Error("--platform must be ios or android");
  if (scenarios.length && values.suite)
    throw new Error("Use either --suite or --scenario, not both");
  const selected = scenarios.length
    ? scenarios
    : [...resolveSuiteScenarioNames(values.suite ?? "default")];
  const known = new Set(listScenarioNames());
  if (new Set(selected).size !== selected.length)
    throw new Error("Duplicate scenarios are not allowed");
  for (const name of selected)
    if (!known.has(name)) throw new Error(`Unknown scenario: ${name}`);
  values.device ??=
    env.HOT_UPDATER_E2E_DEVICE_ID ??
    (values.platform === "android"
      ? (env.HOT_UPDATER_E2E_ANDROID_SERIAL ?? env.ANDROID_SERIAL)
      : undefined) ??
    "";
  if (
    !values.device ||
    (values.platform === "ios" &&
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        values.device,
      ))
  ) {
    throw new Error(
      "--device must identify an explicitly leased device (iOS requires a UDID)",
    );
  }
  return { values, flags, scenarios: selected };
}

function positiveTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error("Scenario timeout must be a positive integer");
  return result;
}

async function freePort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return String(address.port);
}

export async function readOptionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

// The bot signals its shell group. Children get their own groups so the control
// server remains available while the SDK aborts and drains the active attempt.
export async function runSdkChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<number | null> {
  signal.throwIfAborted();
  const child = spawn(command, args, {
    cwd: repoDir,
    env,
    stdio: "inherit",
    detached: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    child.kill("SIGTERM");
    timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }, shutdownGraceMs);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    return await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    signal.removeEventListener("abort", interrupt);
    clearTimeout(timer);
  }
}

export async function runMobile(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseMobileOptions(argv, env);
  if (options.flags.has("--help")) {
    console.log(
      "pnpm -w e2e -- --prepared --platform ios|android --device <UDID|serial> [--scenario <name>] [--suite default] [--dry-run] [--list]",
    );
    return 0;
  }
  if (options.flags.has("--list")) {
    console.log(listScenarioNames().join("\n"));
    return 0;
  }
  if (options.flags.has("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          ...options.values,
          scenarios: options.scenarios,
          workers: 1,
          retries: 0,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (env.CONTROL_URL || env.HOT_UPDATER_E2E_CONTROL_BASE_URL)
    throw new Error(
      "Mobile runs require an owned control server; remove the external control URL",
    );

  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
  if (options.values["head-sha"] && options.values["head-sha"] !== actualHead)
    throw new Error("Requested head SHA differs from the checked-out revision");
  const runId = options.values["run-id"] ?? randomUUID();
  const session = options.values.session ?? `hot-updater-${randomUUID()}`;
  const internalDir = path.join(repoDir, "e2e/results/mobile", randomUUID());
  const resultsDir = path.resolve(options.values["results-dir"] ?? internalDir);
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, ".mobile-run"), runId, {
    flag: "wx",
  });
  await fs.mkdir(internalDir, { recursive: true });
  const platform = options.values.platform as "ios" | "android";
  const deviceId = options.values.device!;
  const controlPort = env.HOT_UPDATER_E2E_CONTROL_PORT ?? (await freePort());
  const childEnv = buildControlServerEnv(platform, {
    ...env,
    HOT_UPDATER_E2E_CONTROL_PORT: controlPort,
    HOT_UPDATER_E2E_DEVICE_ID: deviceId,
    HOT_UPDATER_E2E_RESULTS_DIR: resultsDir,
    HOT_UPDATER_E2E_CHANNEL_NAMESPACE:
      env.HOT_UPDATER_E2E_CHANNEL_NAMESPACE ?? `mobile-${randomUUID()}`,
  });
  const context: MobileContext = {
    platform,
    deviceId,
    session,
    runId,
    headSha: actualHead,
    profile: options.values.profile ?? "local",
    resultsDir,
    appId: childEnv.HOT_UPDATER_E2E_APP_ID!,
    appPath: path.resolve(
      platform === "ios"
        ? (env.HOT_UPDATER_E2E_IOS_BINARY_PATH ??
            path.join(
              env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH ??
                "examples/v0.85.0/ios/build",
              "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
            ))
        : (env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ??
            "examples/v0.85.0/android/app/build/outputs/apk/release/app-release.apk"),
    ),
    scenarioNames: options.scenarios,
    controlBaseUrl: `http://${childEnv.HOT_UPDATER_E2E_SERVER_HOST}:${controlPort}`,
    scenarioTimeoutMs: positiveTimeout(
      env.HOT_UPDATER_E2E_TEST_TIMEOUT_MS,
      3_600_000,
    ),
    setupTimeoutMs: 3_600_000,
    cleanupTimeoutMs: 120_000,
  };
  const contextPath = path.join(internalDir, "context.json");
  await fs.writeFile(contextPath, JSON.stringify(context));
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error("Mobile run cancelled"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let daemon:
    | Awaited<ReturnType<typeof startOwnedAgentDeviceDaemon>>
    | undefined;
  let releaseReverse: (() => Promise<void>) | undefined;
  let exitCode: number | null = null;
  let cleanupStatus: "passed" | "failed" | "unknown" = "unknown";
  const errors: string[] = [];
  const reportPath = path.join(internalDir, "runner/report.json");
  try {
    await fs.access(context.appPath);
    daemon = await startOwnedAgentDeviceDaemon(childEnv, cancellation.signal);
    server = await startControlServer(platform, childEnv, {
      detached: true,
      verifyProcess: true,
      signal: cancellation.signal,
    });
    releaseReverse = await acquireAndroidReverses(context, childEnv);
    const cli = path.join(path.dirname(require.resolve("e2e")), "cli/bin.js");
    exitCode = await runSdkChild(
      process.execPath,
      [
        cli,
        "run",
        "--config",
        "e2e.mobile.config.ts",
        "--target",
        platform,
        "--workers",
        "1",
        "--retries",
        "0",
        "--max-failures",
        "1",
        "--output",
        path.join(internalDir, "runner"),
      ],
      { ...daemon.env, HOT_UPDATER_E2E_MOBILE_CONTEXT: contextPath },
      cancellation.signal,
    );
  } catch (error) {
    errors.push(String(error));
  }
  try {
    const report = await readOptionalJson(reportPath);
    const receipt = await readOptionalJson(
      path.join(resultsDir, "sdk-report.json"),
    );
    const evidence = await readOptionalJson(
      path.join(resultsDir, "scenario-evidence.json"),
    );
    const cleanupEvidence = await readOptionalJson(
      path.join(resultsDir, "cleanup-evidence.json"),
    );
    let quarantine = await readOptionalJson(
      path.join(resultsDir, "quarantine.json"),
    );
    const inputs = {
      report,
      receipt,
      evidence,
      cleanupEvidence,
      quarantine,
      exitCode,
      cancelled: cancellation.signal.aborted,
      errors,
    };
    try {
      const preliminary = normalizeMobileResult(context, {
        ...inputs,
        cleanupStatus: "passed",
      });
      if (server && preliminary.cleanupStatus === "passed") {
        const response = await fetch(`${server.baseUrl}/e2e/cleanup`, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          throw new Error(`Control cleanup failed: HTTP ${response.status}`);
        cleanupStatus = "passed";
      }
    } catch (error) {
      errors.push(String(error));
      cleanupStatus = "failed";
    } finally {
      // Artifact/report failures must never skip owned resource teardown.
      try {
        await daemon?.stop();
      } catch (error) {
        errors.push(String(error));
        cleanupStatus = "failed";
      }
      daemon = undefined;
      try {
        await releaseReverse?.();
      } catch (error) {
        errors.push(String(error));
        cleanupStatus = "failed";
      }
      try {
        await server?.stop({ cleanup: false });
      } catch (error) {
        errors.push(String(error));
        cleanupStatus = "failed";
      }
      releaseReverse = undefined;
      server = undefined;
    }
    if (cleanupStatus !== "passed") {
      quarantine ??= {
        schemaVersion: 1,
        scenarioName: null,
        reason: "Could not prove complete mobile teardown",
        quarantineRequired: true,
      };
      await fs.writeFile(
        path.join(resultsDir, "quarantine.json"),
        JSON.stringify(quarantine),
      );
    }
    if (report)
      await fs.writeFile(
        path.join(resultsDir, "runner-report.json"),
        JSON.stringify(report),
      );
    const result = normalizeMobileResult(context, {
      ...inputs,
      quarantine,
      cleanupStatus,
      errors,
      cancelled: cancellation.signal.aborted,
    });
    await writeMobileResult(context, result);
    console.log(
      `Mobile result: ${path.join(resultsDir, "hot-updater-result.json")}`,
    );
    return result.status === "passed"
      ? 0
      : cancellation.signal.aborted
        ? 130
        : 1;
  } finally {
    try {
      await daemon?.stop();
    } finally {
      try {
        await releaseReverse?.();
      } finally {
        try {
          await server?.stop({ cleanup: false });
        } finally {
          process.off("SIGINT", interrupt);
          process.off("SIGTERM", interrupt);
        }
      }
    }
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runMobile(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
