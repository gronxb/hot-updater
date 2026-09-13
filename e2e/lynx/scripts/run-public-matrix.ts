import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildPublic } from "../../../examples/lynx/scripts/build-public.mjs";
import { createDeviceAdapter } from "../../../examples/lynx/scripts/public-matrix/device-adapters.mjs";
import {
  collectDeltaDelivery,
  collectFailedAttempt,
  collectInvalidatedContexts,
  collectReadyLaunch,
  collectSecondaryFatalFailure,
  collectUnconfirmedLaunch,
  hasCompleteReadyEvents,
  hasCompleteUnconfirmedEvents,
  normalizeBuild,
  resourcePaths,
  validateAttributedDiagnostics,
} from "../../../examples/lynx/scripts/public-matrix/evidence.mjs";
import {
  expectedLynxMatrixCellIds,
  LYNX_MATRIX_FRAMEWORKS,
  LYNX_MATRIX_PLATFORMS,
  type LynxMatrixFramework,
  type LynxMatrixPlatform,
  validateLynxMatrixCell,
  validateLynxMatrixSummary,
} from "../public-matrix-contract.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const example = path.join(repo, "examples/lynx");
const otaRoot = path.join(example, ".hot-updater/ota");
const origin = "http://127.0.0.1:18791";

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
const { values } = parseArgs({
  args: cliArgs,
  options: {
    platform: { type: "string", default: "all" },
    framework: { type: "string", default: "all" },
    "octane-source": { type: "string" },
    "results-dir": { type: "string" },
    "ios-device": { type: "string" },
    "ios-binary": { type: "string" },
    "android-serial": { type: "string" },
    "android-binary": { type: "string" },
    "native-artifacts": { type: "string" },
    "validate-summary": { type: "string" },
    "dry-run": { type: "boolean" },
  },
  strict: true,
});

function selected<T extends string>(
  requested: string,
  allowed: readonly T[],
  label: string,
): T[] {
  if (requested === "all") return [...allowed];
  if (!allowed.includes(requested as T)) {
    throw new Error(`Choose ${label} ${allowed.join(", ")}, or all.`);
  }
  return [requested as T];
}

const platforms = selected(values.platform!, LYNX_MATRIX_PLATFORMS, "platform");
const frameworks = selected(
  values.framework!,
  LYNX_MATRIX_FRAMEWORKS,
  "framework",
);
const cellIds = expectedLynxMatrixCellIds(platforms, frameworks);
const phaseNames = [
  "embedded A with exact resources and readiness",
  "full archive A to B",
  "origin-off B activation",
  "origin-off B retained launch",
  "real B to C BSDIFF and same-process generation reload",
  "retained old-context rejection after reload",
  "primary removal and full generation recreation",
  "secondary fatal candidate and full generation recovery",
  "unconfirmed candidate recovery",
];
const nativeArtifacts = values["native-artifacts"]
  ? JSON.parse(
      await fsp.readFile(path.resolve(values["native-artifacts"]), "utf8"),
    )
  : null;
if (nativeArtifacts) {
  assert.equal(nativeArtifacts.schemaVersion, "lynx-native-artifacts-v1");
  assert.equal(nativeArtifacts.target, "matrix");
  assert.equal(nativeArtifacts.appId, "com.hotupdater.lynxmatrix");
  assert.ok(
    nativeArtifacts.artifacts &&
      typeof nativeArtifacts.artifacts === "object" &&
      !Array.isArray(nativeArtifacts.artifacts),
    "Native artifact receipt is missing artifacts",
  );
  for (const platform of platforms) {
    const artifactPath = nativeArtifacts.artifacts[platform]?.path;
    assert.equal(
      typeof artifactPath,
      "string",
      `Native artifact receipt is missing ${platform}`,
    );
    assert.ok(artifactPath.length > 0);
  }
}

if (values["validate-summary"]) {
  const summary = JSON.parse(
    await fsp.readFile(path.resolve(values["validate-summary"]), "utf8"),
  );
  validateLynxMatrixSummary(summary, cellIds);
  console.log(`Validated ${cellIds.length} Lynx public matrix receipts.`);
  process.exit(0);
}

if (values["dry-run"]) {
  console.log("Lynx public acceptance matrix");
  for (const cellId of cellIds) {
    console.log(`- ${cellId}`);
    for (const phase of phaseNames) console.log(`  - ${phase}`);
  }
  process.exit(0);
}

const required = (name: keyof typeof values) => {
  const result = values[name];
  if (typeof result !== "string" || !result) {
    throw new Error(`--${name} is required for this matrix selection.`);
  }
  return path.resolve(result);
};

const requiredString = (name: keyof typeof values) => {
  const result = values[name];
  if (typeof result !== "string" || !result) {
    throw new Error(`--${name} is required for this matrix selection.`);
  }
  return result;
};

const resultsDir = required("results-dir");
const binaryPath = (platform: LynxMatrixPlatform) => {
  const explicit =
    platform === "ios" ? values["ios-binary"] : values["android-binary"];
  const received = explicit ?? nativeArtifacts?.artifacts?.[platform]?.path;
  if (typeof received !== "string" || !received) {
    throw new Error(
      `--${platform}-binary or --native-artifacts with ${platform} is required for this matrix selection.`,
    );
  }
  return path.resolve(received);
};
const octaneSource = frameworks.includes("octane")
  ? required("octane-source")
  : undefined;
await fsp.mkdir(resultsDir, { recursive: true });

function command(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return result.stdout;
}

const commit = command("git", ["rev-parse", "HEAD"]).trim();
const runId = `${Date.now()}-${process.pid}`;
let server: ChildProcess | null = null;

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the matrix OTA origin");
}

async function assertOriginUnused() {
  try {
    const response = await fetch(`${origin}/health`);
    throw new Error(`origin remained reachable with HTTP ${response.status}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("origin remained reachable")
    ) {
      throw error;
    }
  }
  return {
    outcome: "connection-refused",
    url: `${origin}/health`,
    observedAt: new Date().toISOString(),
  };
}

async function startServer() {
  try {
    const response = await fetch(`${origin}/health`);
    if (response.ok) {
      throw new Error(
        `The matrix requires exclusive ownership of ${origin}; stop the existing server.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("exclusive ownership")
    ) {
      throw error;
    }
  }
  const log = fs.openSync(path.join(resultsDir, "ota-server.log"), "a");
  server = spawn(
    process.execPath,
    [path.join(example, "scripts/ota-server.mjs")],
    {
      cwd: repo,
      stdio: ["ignore", log, log],
    },
  );
  server.once("exit", () => fs.closeSync(log));
  await waitForHealth();
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("OTA origin did not stop after SIGTERM")),
      15_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function runtimeId(platform: LynxMatrixPlatform) {
  return platform === "ios"
    ? "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    : "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2";
}

function sdkBaseURL(platform: LynxMatrixPlatform) {
  return platform === "ios"
    ? `${origin}/hot-updater`
    : "http://10.0.2.2:18791/hot-updater";
}

async function compile(
  framework: LynxMatrixFramework,
  platform: LynxMatrixPlatform,
  role: string,
  variant: "A" | "B" | "C",
  behavior: "normal" | "unconfirmed" = "normal",
) {
  const fixture = `matrix-${runId}-${platform}-${role.toLowerCase()}`;
  const outDir = path.join(
    example,
    ".hot-updater/public-matrix/builds",
    framework,
    fixture,
  );
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.rm(`${outDir}.build.json`, { force: true });
  const compilerReceipt = await buildPublic({
    framework,
    outDir,
    variant,
    behavior,
    baseURL: sdkBaseURL(platform),
    octaneSource,
  });
  return { fixture, compilerReceipt };
}

async function deploy({
  framework,
  platform,
  fixture,
  channel,
  patch,
  fromBundleId,
}: {
  framework: LynxMatrixFramework;
  platform: LynxMatrixPlatform;
  fixture: string;
  channel: string;
  patch?: boolean;
  fromBundleId?: string;
}) {
  const args = [
    path.join(example, "scripts/ota-deploy.mjs"),
    framework,
    platform,
    "zip",
    fixture,
    "--channel",
    channel,
    "--runtime-id",
    runtimeId(platform),
  ];
  if (patch) args.push("--patch");
  if (fromBundleId) args.push("--from-bundle-id", fromBundleId);
  const stdout = command(process.execPath, args);
  const match = stdout.match(/"receiptPath"\s*:\s*"([^"]+)"/);
  if (!match)
    throw new Error(`Deploy did not report a receipt path:\n${stdout}`);
  return JSON.parse(await fsp.readFile(match[1], "utf8"));
}

function assertCompilerMatchesEmbedded(
  compilerReceipt: any,
  embeddedReceipt: any,
) {
  for (const resourcePath of resourcePaths) {
    const built = compilerReceipt.files.find(
      (file: any) => file.path === resourcePath,
    );
    assert.ok(built, `Missing compiler output ${resourcePath}`);
    assert.equal(
      embeddedReceipt.files?.[resourcePath]?.sha256,
      built.sha256,
      `Native embedded A differs from the current compiler output: ${resourcePath}`,
    );
  }
}

function eventCursor(adapter: any) {
  return adapter.readEvents().length;
}

function eventsSince(adapter: any, cursor: number) {
  return adapter.readEvents().slice(cursor);
}

async function waitForEvent(
  adapter: any,
  cursor: number,
  predicate: (event: any) => boolean,
  description: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = eventsSince(adapter, cursor);
    if (events.some(predicate)) return events;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForReadyEvents(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = eventsSince(adapter, cursor);
    if (hasCompleteReadyEvents(events, build, processId)) return events;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for complete ${build.variant} readiness`);
}

async function waitForUnconfirmedEvents(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = eventsSince(adapter, cursor);
    if (hasCompleteUnconfirmedEvents(events, build, processId)) return events;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for complete unconfirmed ${build.variant} startup`,
  );
}

async function waitForStaleContextRejections(
  adapter: any,
  cursor: number,
  bundleId: string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const events = eventsSince(adapter, cursor).filter(
      (event: any) =>
        event.event === "staleContextRejected" &&
        event.code === "STALE_CONTEXT" &&
        String(event.bundleId) === bundleId,
    );
    if (events.length === 2) return events;
    if (events.length > 2) {
      throw new Error(
        `Observed duplicate stale-context probes for ${bundleId}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for both stale-context rejections for ${bundleId}`,
  );
}

function storedReceipt(input: any): any {
  const raw = input?.receipt ?? input;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function stateForChannel(adapter: any, channel: string) {
  const state = adapter.readStates().find(({ value }: any) => {
    const candidates = [value.confirmed, value.next, value.pending?.selection];
    return candidates.some(
      (candidate) => storedReceipt(candidate)?.channel === channel,
    );
  });
  assert.ok(state, `No native state found for channel ${channel}`);
  return state.value;
}

function exclusions(state: any, kind: "fatal" | "unconfirmed") {
  const key =
    kind === "fatal"
      ? state.crashedBundleIds
        ? "crashedBundleIds"
        : "crashed"
      : state.unconfirmedReleaseIds
        ? "unconfirmedReleaseIds"
        : "unconfirmed";
  const result = state[key];
  assert.ok(Array.isArray(result), `Native state is missing ${key}`);
  return result.map(String);
}

async function runCell(
  adapter: any,
  framework: LynxMatrixFramework,
  platform: LynxMatrixPlatform,
) {
  const cellId = `${framework}-${platform}`;
  const cellDir = path.join(resultsDir, cellId);
  await fsp.mkdir(cellDir, { recursive: true });
  adapter.resultsDir = cellDir;
  adapter.resetCell();
  const channel = `lynx-matrix-${runId}-${cellId}`;
  const binaryInstalled = await adapter.installedBinaryHash();

  const [aSource, bSource, cSource, fatalSource, unconfirmedSource] = [
    await compile(framework, platform, "A", "A"),
    await compile(framework, platform, "B", "B"),
    await compile(framework, platform, "C", "C"),
    await compile(framework, platform, "FATAL", "B", "unconfirmed"),
    await compile(framework, platform, "UNCONFIRMED", "A", "unconfirmed"),
  ];
  const embeddedReceiptPath = path.join(
    otaRoot,
    "receipts",
    `${framework}-${platform}-A-sdk3-managed-embedded.json`,
  );
  const embeddedReceipt = JSON.parse(
    await fsp.readFile(embeddedReceiptPath, "utf8"),
  );
  assertCompilerMatchesEmbedded(aSource.compilerReceipt, embeddedReceipt);

  const bDeployment = await deploy({
    framework,
    platform,
    fixture: bSource.fixture,
    channel,
  });
  const A = normalizeBuild({
    role: "A",
    compilerReceipt: aSource.compilerReceipt,
    embeddedReceipt,
    runtimeId: runtimeId(platform),
  });
  const B = normalizeBuild({
    role: "B",
    compilerReceipt: bSource.compilerReceipt,
    deploymentReceipt: bDeployment,
    runtimeId: runtimeId(platform),
  });

  let cursor = eventCursor(adapter);
  const processA = adapter.launch(framework, channel);
  await adapter.waitForText("Bundle A ready");
  adapter.screenshot(`${cellId}-embedded-A`);
  const aEvents = eventsSince(adapter, cursor);

  cursor = eventCursor(adapter);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install next launch");
  await adapter.waitForText("Update installed. Close and reopen the app.");
  const archiveLogs = adapter.readNativeLogs();
  assert.ok(
    archiveLogs.includes(
      `HotUpdaterArchiveInstalled bundleId=${bDeployment.bundleId}`,
    ),
    "Native logs do not prove a full B archive installation",
  );
  assert.ok(
    !archiveLogs.includes(
      `HotUpdaterArchiveFallbackApplied bundleId=${bDeployment.bundleId}`,
    ),
    "Initial B archive was mislabeled as fallback",
  );

  await stopServer();
  const originProbe = await assertOriginUnused();
  cursor = eventCursor(adapter);
  const processBActivation = adapter.launch(framework, channel);
  await adapter.waitForText("Bundle B ready");
  const bActivationEvents = eventsSince(adapter, cursor);
  adapter.screenshot(`${cellId}-offline-B-activation`);
  await assertOriginUnused();

  cursor = eventCursor(adapter);
  const processBRetain = adapter.launch(framework, channel);
  await adapter.waitForText("Bundle B ready");
  const bRetainEvents = eventsSince(adapter, cursor);
  adapter.screenshot(`${cellId}-offline-B-retain`);
  await assertOriginUnused();
  await startServer();

  const cDeployment = await deploy({
    framework,
    platform,
    fixture: cSource.fixture,
    channel,
    patch: true,
    fromBundleId: B.bundleId,
  });
  const C = normalizeBuild({
    role: "C",
    compilerReceipt: cSource.compilerReceipt,
    deploymentReceipt: cDeployment,
    runtimeId: runtimeId(platform),
  });
  cursor = eventCursor(adapter);
  const reloadProcess = adapter.processId();
  assert.equal(reloadProcess, processBRetain);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install and reload");
  await adapter.waitForText("Bundle C ready");
  await waitForReadyEvents(adapter, cursor, C, reloadProcess);
  assert.equal(
    adapter.processId(),
    reloadProcess,
    "HotUpdater.reload() restarted the OS process",
  );
  adapter.clickText("Verify stale after reload");
  await waitForStaleContextRejections(adapter, cursor, B.bundleId);
  const cEvents = eventsSince(adapter, cursor);
  const deltaLogs = adapter.readNativeLogs();
  adapter.screenshot(`${cellId}-delta-C-reload`);

  cursor = eventCursor(adapter);
  adapter.clickText("Replace primary");
  await adapter.waitForText("Bundle C ready");
  await waitForReadyEvents(adapter, cursor, C, reloadProcess);
  adapter.clickText("Verify stale after reload");
  await waitForStaleContextRejections(adapter, cursor, C.bundleId);
  const primaryReplacementEvents = eventsSince(adapter, cursor);
  adapter.screenshot(`${cellId}-primary-replacement`);

  const fatalDeployment = await deploy({
    framework,
    platform,
    fixture: fatalSource.fixture,
    channel,
  });
  const fatal = normalizeBuild({
    role: "FATAL",
    compilerReceipt: fatalSource.compilerReceipt,
    deploymentReceipt: fatalDeployment,
    runtimeId: runtimeId(platform),
  });
  cursor = eventCursor(adapter);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install and reload");
  await adapter.waitForText("readiness deliberately withheld");
  await waitForUnconfirmedEvents(adapter, cursor, fatal, reloadProcess);
  adapter.clickText("Fail secondary");
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      event.event === "runtimeFailed" &&
      String(event.bundleId) === fatal.bundleId,
    "secondary fatal candidate failure",
  );
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      event.event === "generationStarted" &&
      event.reason === "recovery" &&
      String(event.bundleId) === C.bundleId,
    "fatal candidate recovery",
  );
  await adapter.waitForText("Bundle C ready");
  await waitForReadyEvents(adapter, cursor, C, reloadProcess);
  const fatalEvents = eventsSince(adapter, cursor);
  const fatalState = stateForChannel(adapter, channel);

  const unconfirmedDeployment = await deploy({
    framework,
    platform,
    fixture: unconfirmedSource.fixture,
    channel,
  });
  const unconfirmed = normalizeBuild({
    role: "UNCONFIRMED",
    compilerReceipt: unconfirmedSource.compilerReceipt,
    deploymentReceipt: unconfirmedDeployment,
    runtimeId: runtimeId(platform),
  });
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install next launch");
  await adapter.waitForText("Update installed. Close and reopen the app.");
  cursor = eventCursor(adapter);
  const processUnconfirmedAttempt = adapter.launch(framework, channel);
  await adapter.waitForText("readiness deliberately withheld");
  await waitForUnconfirmedEvents(
    adapter,
    cursor,
    unconfirmed,
    processUnconfirmedAttempt,
  );
  const unconfirmedAttemptEvents = eventsSince(adapter, cursor);
  cursor = eventCursor(adapter);
  adapter.launch(framework, channel);
  await adapter.waitForText("Bundle C ready");
  const unconfirmedRecoveryEvents = eventsSince(adapter, cursor);
  const unconfirmedState = stateForChannel(adapter, channel);

  const allEvents = adapter.readEvents();
  validateAttributedDiagnostics(allEvents);
  const allLogs = adapter.readNativeLogs();
  await fsp.writeFile(
    path.join(cellDir, "events.json"),
    `${JSON.stringify(allEvents, null, 2)}\n`,
  );
  await fsp.writeFile(path.join(cellDir, "native.log"), allLogs);

  const embeddedA = collectReadyLaunch({
    phaseEvents: aEvents,
    allEvents,
    build: A,
    processId: processA,
  });
  const activationB = collectReadyLaunch({
    phaseEvents: bActivationEvents,
    allEvents,
    build: B,
    processId: processBActivation,
  });
  const retainB = collectReadyLaunch({
    phaseEvents: bRetainEvents,
    allEvents,
    build: B,
    processId: processBRetain,
  });
  const afterReload = collectReadyLaunch({
    phaseEvents: cEvents,
    allEvents,
    build: C,
    processId: reloadProcess,
  });
  const beforeReload = retainB;
  const generationRetirement = collectInvalidatedContexts(
    allEvents,
    beforeReload,
  );
  const afterPrimaryReplacement = collectReadyLaunch({
    phaseEvents: primaryReplacementEvents,
    allEvents,
    build: C,
    processId: reloadProcess,
  });
  const primaryGenerationRetirement = collectInvalidatedContexts(
    allEvents,
    afterReload,
    { reason: "primaryRemoved" },
  );
  const fatalCandidateLaunch = collectUnconfirmedLaunch({
    phaseEvents: fatalEvents,
    allEvents,
    build: fatal,
    processId: reloadProcess,
  });
  const fatalFailure = collectSecondaryFatalFailure(
    fatalEvents,
    fatalCandidateLaunch,
  );
  const fatalGenerationRetirement = collectInvalidatedContexts(
    allEvents,
    fatalCandidateLaunch,
    { reason: "recovery", requireStaleAuthorities: false },
  );
  const fatalRecovered = collectReadyLaunch({
    phaseEvents: fatalEvents,
    allEvents,
    build: C,
    processId: fatalFailure.processId,
  });
  const unconfirmedFailure = collectFailedAttempt(
    unconfirmedAttemptEvents,
    unconfirmed,
  );
  const unconfirmedCandidateLaunch = collectUnconfirmedLaunch({
    phaseEvents: unconfirmedAttemptEvents,
    allEvents,
    build: unconfirmed,
    processId: processUnconfirmedAttempt,
  });
  const unconfirmedRecovered = collectReadyLaunch({
    phaseEvents: unconfirmedRecoveryEvents,
    allEvents,
    build: C,
    processId: adapter.processId(),
  });
  const countCandidateAttempts = (build: any) =>
    new Set(
      allEvents
        .filter(
          (event: any) =>
            event.event === "generationWillEvaluate" &&
            String(event.bundleId) === build.bundleId &&
            String(event.releaseId) === build.releaseId,
        )
        .map(
          (event: any) =>
            `${event.processId}\u0000${event.generationId}\u0000${event.attemptId}`,
        ),
    ).size;
  assert.equal(countCandidateAttempts(fatal), 1);
  assert.equal(countCandidateAttempts(unconfirmed), 1);

  const receipt = {
    schemaVersion: "lynx-public-matrix-v1",
    cellId,
    framework,
    platform,
    commit,
    binary: {
      path: adapter.binaryPath,
      installedSha256: binaryInstalled,
      finalSha256: await adapter.installedBinaryHash(),
    },
    builds: { A, B, C, fatal, unconfirmed },
    phases: {
      embeddedA,
      archiveB: {
        transport: "archive",
        archiveFallbackUsed: false,
        archiveSha256: bDeployment.archiveSha256,
        stagedSelection: {
          bundleId: B.bundleId,
          releaseId: B.releaseId,
        },
      },
      offline: {
        originProbe,
        activationB,
        retainB,
        originStayedDown: true,
      },
      deltaC: {
        delivery: collectDeltaDelivery(cDeployment, deltaLogs),
        beforeReload,
        afterReload,
        generationRetirement,
      },
      primaryLifecycle: {
        beforeRemoval: afterReload,
        generationRetirement: primaryGenerationRetirement,
        afterReplacement: afterPrimaryReplacement,
      },
      fatalRecovery: {
        kind: "fatal",
        candidate: {
          bundleId: fatal.bundleId,
          releaseId: fatal.releaseId,
        },
        failedAttemptId: fatalFailure.attemptId,
        failureEvent: fatalFailure,
        candidateLaunch: fatalCandidateLaunch,
        generationRetirement: fatalGenerationRetirement,
        recovered: fatalRecovered,
        persistedExclusions: exclusions(fatalState, "fatal"),
        candidateRetried: false,
      },
      unconfirmedRecovery: {
        kind: "unconfirmed",
        candidate: {
          bundleId: unconfirmed.bundleId,
          releaseId: unconfirmed.releaseId,
        },
        failedAttemptId: unconfirmedFailure.attemptId,
        failureEvent: unconfirmedFailure,
        candidateLaunch: unconfirmedCandidateLaunch,
        recovered: unconfirmedRecovered,
        persistedExclusions: exclusions(unconfirmedState, "unconfirmed"),
        candidateRetried: false,
      },
    },
    passed: true,
  };
  validateLynxMatrixCell(receipt);
  await fsp.writeFile(
    path.join(cellDir, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`[lynx-matrix:passed] ${cellId}`);
  return receipt;
}

const adapters = new Map<LynxMatrixPlatform, any>();
if (platforms.includes("ios")) {
  adapters.set(
    "ios",
    createDeviceAdapter("ios", {
      deviceId: requiredString("ios-device"),
      binaryPath: binaryPath("ios"),
      resultsDir,
      session: `lynx-matrix-${runId}-ios`,
    }),
  );
}
if (platforms.includes("android")) {
  adapters.set(
    "android",
    createDeviceAdapter("android", {
      deviceId: requiredString("android-serial"),
      binaryPath: binaryPath("android"),
      resultsDir,
    }),
  );
}

const receipts = [];
try {
  await startServer();
  for (const platform of platforms) {
    const adapter = adapters.get(platform);
    const sourceHash = await adapter.sourceBinaryHash();
    adapter.install();
    assert.equal(
      await adapter.installedBinaryHash(),
      sourceHash,
      "Installed native binary differs from the supplied artifact",
    );
    for (const framework of frameworks) {
      receipts.push(await runCell(adapter, framework, platform));
    }
  }
} finally {
  await stopServer();
}

const summary = {
  schemaVersion: "lynx-public-matrix-summary-v1",
  commit,
  cells: receipts,
  passed: true,
};
validateLynxMatrixSummary(summary, cellIds);
await fsp.writeFile(
  path.join(resultsDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(`[lynx-matrix:passed] ${receipts.length} cells`);
