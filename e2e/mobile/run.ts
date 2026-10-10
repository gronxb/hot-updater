#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listLynxScenarioNames } from "../lynx/scenarios.ts";
import {
  LYNX_EXCLUDED_DEFAULT_SCENARIOS,
  readLynxDefaultScenarioNames,
} from "../lynx/suite-manifest.ts";
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
import { collectAttemptEvidence } from "./attempt.ts";
import type { MobileContext } from "./context.ts";
import { normalizeMobileResult, writeMobileResult } from "./result.ts";
import { lynxMobileEnvironment, resolveMobileRuntime } from "./target.ts";

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
    "runtime",
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
  values.runtime = resolveMobileRuntime(values.runtime, env);
  if (flags.has("--help") || flags.has("--list"))
    return { values, flags, scenarios };
  if (values.platform !== "ios" && values.platform !== "android")
    throw new Error("--platform must be ios or android");
  if (scenarios.length && values.suite)
    throw new Error("Use either --suite or --scenario, not both");
  const selected = scenarios.length
    ? scenarios
    : values.runtime === "lynx" && (values.suite ?? "default") === "default"
      ? [...readLynxDefaultScenarioNames(repoDir)]
      : [...resolveSuiteScenarioNames(values.suite ?? "default")];
  const known = new Set(
    values.runtime === "lynx"
      ? listLynxScenarioNames().filter(
          (name) =>
            !LYNX_EXCLUDED_DEFAULT_SCENARIOS.some(
              (excluded) => excluded === name,
            ),
        )
      : listScenarioNames(),
  );
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

// The CLI entry the installed e2e package declares in its bin field.
export function resolveE2eCli(): string {
  let directory = path.dirname(require.resolve("e2e"));
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        bin?: Record<string, string>;
      };
      if (pkg.name === "e2e" && pkg.bin?.e2e)
        return path.resolve(directory, pkg.bin.e2e);
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("The installed e2e package declares no CLI");
    directory = parent;
  }
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
  const runtime = resolveMobileRuntime(options.values.runtime, env);
  if (runtime === "lynx") env = lynxMobileEnvironment(repoDir, env);
  if (options.flags.has("--help")) {
    console.log(
      "pnpm -w e2e -- --prepared --runtime react-native|lynx --platform ios|android --device <UDID|serial> [--scenario <name>] [--suite default] [--dry-run] [--list]",
    );
    return 0;
  }
  if (options.flags.has("--list")) {
    console.log(
      (runtime === "lynx"
        ? readLynxDefaultScenarioNames(repoDir)
        : listScenarioNames()
      ).join("\n"),
    );
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
    runtime,
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
              path.resolve(
                repoDir,
                "examples/v0.85.0/ios",
                env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH || "build",
              ),
              "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
            ))
        : (env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ??
            "examples/v0.85.0/android/app/build/outputs/apk/release/app-release.apk"),
    ),
    scenarioNames: options.scenarios,
    controlBaseUrl: `http://${childEnv.HOT_UPDATER_E2E_SERVER_HOST}:${controlPort}`,
    testTimeoutMs: positiveTimeout(
      env.HOT_UPDATER_E2E_TEST_TIMEOUT_MS,
      3_600_000,
    ),
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
    exitCode = await runSdkChild(
      process.execPath,
      [
        resolveE2eCli(),
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
    // Each attempt's teardown filed its own records; gather them here.
    const {
      evidence,
      cleanupEvidence,
      quarantine: attemptQuarantine,
    } = collectAttemptEvidence(resultsDir);
    for (const [name, record] of [
      ["scenario-evidence.json", evidence],
      ["cleanup-evidence.json", cleanupEvidence],
    ] as const) {
      if (record)
        await fs.writeFile(
          path.join(resultsDir, name),
          `${JSON.stringify(record, null, 2)}\n`,
        );
    }
    let quarantine: unknown = attemptQuarantine;
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
    }
    if (quarantine !== undefined)
      await fs.writeFile(
        path.join(resultsDir, "quarantine.json"),
        JSON.stringify(quarantine),
      );
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
