import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildPublic } from "../../../examples/lynx/scripts/build-public.mjs";
import { createPublicMatrixBundleDiff } from "../../../examples/lynx/scripts/public-matrix/create-bundle-diff.mjs";
import { createDeviceAdapter } from "../../../examples/lynx/scripts/public-matrix/device-adapters.mjs";
import {
  collectDeltaDelivery,
  collectFatalPendingDetailLaunch,
  collectInvalidatedContexts,
  collectPendingDetailLaunch,
  collectProcessInterruption,
  collectReadyLaunch,
  collectSecondaryFatalFailure,
  hasCompleteAlreadyRunningDetailEvents,
  hasCompletePendingDetailEvents,
  hasCompleteReadyEvents,
  normalizeBuild,
  resourcePaths,
  validateAttributedDiagnostics,
} from "../../../examples/lynx/scripts/public-matrix/evidence.mjs";
import {
  expectedRawDetailNativeFailure,
  MISSING_ASSET_RESPONSE_SHA256,
  readSdkInstallFailureEvidence,
} from "../../../examples/lynx/scripts/public-matrix/raw-detail-rejection.mjs";
import { validateGenerationEventsSnapshot } from "../../../examples/lynx/src/e2eApp/generationEvents.ts";
import { lynxE2eRuntimeId } from "../embedded-bundle.ts";
import { GenerationEventLedger } from "../generation-event-ledger.ts";
import {
  assertNoManagedResourceEngineErrors,
  findManagedResourceEngineErrorCodes,
} from "../managed-resource-errors.ts";
import {
  validateMatrixRuntimeJournalDiagnostics,
  validateNavigationStackBoundary,
  validateRuntimeEventFieldBoundaryDiagnostics,
} from "../native-diagnostics-evidence.ts";
import {
  expectedLynxMatrixCellIds,
  LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS,
  LYNX_MATRIX_FRAMEWORKS,
  LYNX_MATRIX_PLATFORMS,
  type LynxMatrixFramework,
  type LynxMatrixPlatform,
  validateLynxNativeArtifactsReceipt,
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
const installFailuresPath = path.join(otaRoot, "matrix-install-failures.jsonl");

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
  "canonical navigation boundaries and native stack depth 16/17",
  "real A to B BSDIFF plus raw detail staged for offline activation",
  "origin-off B activation",
  "origin-off B retained launch",
  "real B to C BSDIFF and same-process generation reload",
  "retained old-context rejection after reload",
  "cross-provenance native rejection without cached redownload",
  "primary removal and full generation recreation",
  "pending-detail managed-transition cancellation and reconstruction",
  "fatal detail after primary confirmation and full generation recovery",
  "fatal detail before primary confirmation and full generation recovery",
  "pending detail process death after confirmation and full-stack recovery",
  "pending detail process death before confirmation and full-stack recovery",
  "reverse C to B and B to server A BSDIFF rollback",
  "runtime journal field, retention, repair, and canonical-byte receipts",
];
const nativeArtifacts = values["native-artifacts"]
  ? JSON.parse(
      await fsp.readFile(path.resolve(values["native-artifacts"]), "utf8"),
    )
  : null;
const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
});
const commit = commitResult.stdout.trim();
if (commitResult.status !== 0 || !/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error("Could not resolve the exact matrix source commit");
}
if (nativeArtifacts) {
  validateLynxNativeArtifactsReceipt(nativeArtifacts, {
    appId: "com.hotupdater.lynxmatrix",
    commit,
    platforms,
    target: "matrix",
  });
} else if (!values["dry-run"] && !values["validate-summary"]) {
  throw new Error("--native-artifacts is required for a device matrix run");
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

const runId = `${Date.now()}-${process.pid}`;
let server: ChildProcess | null = null;
const serverLogPath = () => path.join(resultsDir, "ota-server.log");

function serverRequestCount(targetUrl: string) {
  if (!fs.existsSync(serverLogPath())) return 0;
  const pathname = new URL(targetUrl).pathname;
  return fs
    .readFileSync(serverLogPath(), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((count, line) => {
      try {
        const item = JSON.parse(line);
        return item.method === "GET" && item.path === pathname
          ? count + 1
          : count;
      } catch {
        return count;
      }
    }, 0);
}

function serverRequests(targetUrl: string) {
  if (!fs.existsSync(serverLogPath())) return [];
  const expected = new URL(targetUrl);
  return fs
    .readFileSync(serverLogPath(), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const item = JSON.parse(line);
        return item.method === "GET" && item.path === expected.pathname
          ? [item]
          : [];
      } catch {
        return [];
      }
    });
}

async function waitForServerRequestCount(targetUrl: string, minimum: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = serverRequestCount(targetUrl);
    if (count >= minimum) return count;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${minimum} GET requests to ${targetUrl}`,
  );
}

async function waitForSdkInstallFailure(cursor: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const records = readSdkInstallFailureEvidence(installFailuresPath);
    if (records.length > cursor) {
      assert.equal(records.length, cursor + 1);
      return records[cursor];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for structured SDK install failure");
}

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
  const log = fs.openSync(serverLogPath(), "a");
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

async function resetServerState() {
  await stopServer();
  await Promise.all([
    fsp.rm(path.join(otaRoot, "postgres"), { recursive: true, force: true }),
    fsp.rm(path.join(otaRoot, "objects"), { recursive: true, force: true }),
  ]);
  await startServer();
}

function runtimeId(platform: LynxMatrixPlatform) {
  return lynxE2eRuntimeId(platform);
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
  behavior: "detail-unconfirmed" | "normal" | "unconfirmed" = "normal",
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
    matrixStableFont: true,
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
  bundleId,
  runtimeIdOverride,
  allowIncompatibleRuntime,
}: {
  framework: LynxMatrixFramework;
  platform: LynxMatrixPlatform;
  fixture: string;
  channel: string;
  patch?: boolean;
  fromBundleId?: string;
  bundleId?: string;
  runtimeIdOverride?: string;
  allowIncompatibleRuntime?: boolean;
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
    runtimeIdOverride ?? runtimeId(platform),
  ];
  if (patch) args.push("--patch");
  if (fromBundleId) args.push("--from-bundle-id", fromBundleId);
  if (bundleId) args.push("--bundle-id", bundleId);
  if (allowIncompatibleRuntime) args.push("--allow-incompatible-runtime");
  const stdout = command(process.execPath, args);
  const match = stdout.match(/"receiptPath"\s*:\s*"([^"]+)"/);
  if (!match)
    throw new Error(`Deploy did not report a receipt path:\n${stdout}`);
  return JSON.parse(await fsp.readFile(match[1], "utf8"));
}

async function setReleaseEnabled(releaseId: string, enabled: boolean) {
  const token = (
    await fsp.readFile(path.join(otaRoot, "admin-token"), "utf8")
  ).trim();
  const response = await fetch(
    `${origin}/hot-updater/admin/releases/${encodeURIComponent(releaseId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ patch: { enabled } }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Release ${releaseId} policy update failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
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

const runtimeSnapshotsPath = path.join(
  otaRoot,
  "matrix-runtime-snapshots.jsonl",
);

function runtimeSnapshotRecords(): any[] {
  if (!fs.existsSync(runtimeSnapshotsPath)) return [];
  return fs
    .readFileSync(runtimeSnapshotsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(
          `Malformed posted runtime snapshot at line ${index + 1}`,
        );
      }
    });
}

async function checkpointRuntimeEvents(
  adapter: any,
  ledger: GenerationEventLedger,
  label: string,
) {
  const cursor = runtimeSnapshotRecords().length;
  adapter.clickText("Capture runtime events");
  await adapter.waitForText("Runtime events captured:");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const records = runtimeSnapshotRecords();
    if (records.length > cursor) {
      assert.equal(
        records.length,
        cursor + 1,
        `${label}: expected one package runtime snapshot publication`,
      );
      const snapshot = validateGenerationEventsSnapshot(
        records[cursor].snapshot,
        { allowTruncated: true },
      );
      ledger.merge(label, snapshot);
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: package getRuntimeEvents snapshot was not posted`);
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

async function waitForAlreadyRunningDetailEvents(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = eventsSince(adapter, cursor);
    if (hasCompleteAlreadyRunningDetailEvents(events, build, processId)) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for already-running ${build.variant} detail admission`,
  );
}

async function exerciseDetailPage(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
  displayVariant: "A" | "B" | "C",
  closeWith: "back" | "close",
) {
  adapter.clickText("Open detail page");
  await adapter.waitForText(`Detail bundle ${displayVariant} ready`);
  await waitForReadyEvents(adapter, cursor, build, processId);
  await adapter.screenshot(`detail-${displayVariant}-${closeWith}`);
  if (closeWith === "back") adapter.nativeBack();
  else adapter.clickText("Close detail page");
  await adapter.waitForText(`Bundle ${displayVariant} ready`);
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      ["pageClosed", "nativeBack", "routeClosed"].includes(event.event) &&
      event.pageEntry === "detail.lynx.bundle" &&
      event.topPageEntry === "main.lynx.bundle",
    `managed detail ${closeWith}`,
  );
  return eventsSince(adapter, cursor);
}

async function leaveDetailPageOpen(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
  displayVariant: "A" | "B" | "C",
) {
  adapter.clickText("Open detail page");
  await adapter.waitForText(`Detail bundle ${displayVariant} ready`);
  await waitForAlreadyRunningDetailEvents(adapter, cursor, build, processId);
  return eventsSince(adapter, cursor);
}

async function closeReconstructedDetailPage(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
  displayVariant: "A" | "B" | "C",
) {
  await adapter.waitForText(`Detail bundle ${displayVariant} ready`);
  await waitForReadyEvents(adapter, cursor, build, processId);
  adapter.nativeBack();
  await adapter.waitForText(`Bundle ${displayVariant} ready`);
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      ["nativeBack", "routeClosed"].includes(event.event) &&
      event.pageEntry === "detail.lynx.bundle" &&
      event.topPageEntry === "main.lynx.bundle",
    `${displayVariant} reconstructed detail native back`,
  );
  return eventsSince(adapter, cursor);
}

function boundaryParameters(vector: string) {
  if (vector === "canonical-options") {
    return { title: "Second Page", value: "a+b" };
  }
  if (vector === "parameter-count") {
    return Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`p${index}`, String(index)]),
    );
  }
  if (vector === "key-bytes") return { ["é".repeat(64)]: "ok" };
  if (vector === "value-bytes") return { value: "é".repeat(512) };
  if (vector === "decoded-query-bytes") {
    return { a: "a".repeat(1_024), b: "b".repeat(998) };
  }
  return { a: "é".repeat(512), b: "b".repeat(970) };
}

async function exerciseNavigationBoundaries(
  adapter: any,
  displayVariant: string,
) {
  const receipts = [];
  for (const vector of [
    "canonical-options",
    "parameter-count",
    "key-bytes",
    "value-bytes",
    "decoded-query-bytes",
    "raw-route-bytes",
  ]) {
    const cursor = eventCursor(adapter);
    adapter.clickText("Verify navigation boundary");
    await adapter.waitForText(`Detail bundle ${displayVariant} ready`);
    await waitForEvent(
      adapter,
      cursor,
      (event) =>
        ["pageOpened", "routeOpened"].includes(event.event) &&
        event.pageEntry === "detail.lynx.bundle",
      `${vector} accepted native detail`,
    );
    adapter.clickText("Close detail page");
    await adapter.waitForText(`Bundle ${displayVariant} ready`);
    await adapter.waitForText(
      `Navigation boundary ${vector}: max accepted, plus one rejected`,
    );
    const events = eventsSince(adapter, cursor);
    const opened = events.filter(
      (event: any) =>
        ["pageOpened", "routeOpened"].includes(event.event) &&
        event.pageEntry === "detail.lynx.bundle",
    );
    assert.equal(
      opened.length,
      1,
      `${vector} reached native open more than once`,
    );
    const parameters = opened[0].parameters ?? opened[0].pageParameters;
    assert.deepEqual(parameters, boundaryParameters(vector));
    const closed = events.find(
      (event: any) =>
        ["pageClosed", "routeClosed"].includes(event.event) &&
        event.contextId === opened[0].contextId &&
        event.topPageEntry === "main.lynx.bundle",
    );
    assert.ok(
      closed,
      `${vector} accepted page did not close through Sparkling`,
    );
    receipts.push({
      vector,
      acceptedContextId: opened[0].contextId,
      nativePageClass: opened[0].nativePageClass,
      sourceContextId: opened[0].sourceContextId,
      parameters,
      acceptedOpenCount: 1,
      overflowNativeOpenCount: 0,
      closedToMain: true,
    });
  }
  assert.equal(new Set(receipts.map((item) => item.acceptedContextId)).size, 6);
  return receipts;
}

async function waitForDiagnostic(
  adapter: any,
  cursor: number,
  action: string,
  processId: string,
) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const records = adapter
      .readDiagnostics()
      .slice(cursor)
      .filter((record: any) => record.action === action);
    if (records.length > 0) {
      assert.equal(
        records.length,
        1,
        `${action} emitted more than one receipt`,
      );
      assert.equal(records[0].ok, true, `${action}: ${records[0].error}`);
      assert.equal(records[0].processId, processId);
      return { ...records[0].data, processId: records[0].processId };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${action} diagnostic receipt`);
}

async function exerciseNativeDiagnostics(adapter: any, displayVariant: string) {
  const processId = adapter.processId();
  let cursor = adapter.readDiagnostics().length;
  adapter.clickText("Exercise stack boundary");
  const navigationStackBoundary = await waitForDiagnostic(
    adapter,
    cursor,
    "navigationStackBoundary",
    processId,
  );
  validateNavigationStackBoundary(navigationStackBoundary);
  const closeCursor = eventCursor(adapter);
  for (let depth = 16; depth > 1; depth -= 1) {
    adapter.nativeBack();
    await waitForEvent(
      adapter,
      closeCursor,
      (event) =>
        ["nativeBack", "routeClosed"].includes(event.event) &&
        Array.isArray(event.orderedPageEntries) &&
        event.orderedPageEntries.length === depth - 1,
      `native stack close from depth ${depth}`,
    );
  }
  await adapter.waitForText(`Bundle ${displayVariant} ready`);

  cursor = adapter.readDiagnostics().length;
  adapter.clickText("Exercise event boundaries");
  const runtimeEventFieldBoundaries = await waitForDiagnostic(
    adapter,
    cursor,
    "runtimeEventFieldBoundaries",
    processId,
  );
  validateRuntimeEventFieldBoundaryDiagnostics(runtimeEventFieldBoundaries);

  cursor = adapter.readDiagnostics().length;
  adapter.clickText("Exercise journal fixtures");
  const runtimeJournalFixtures = await waitForDiagnostic(
    adapter,
    cursor,
    "runtimeJournalFixtures",
    processId,
  );
  validateMatrixRuntimeJournalDiagnostics(runtimeJournalFixtures);
  return {
    navigationStackBoundary,
    runtimeEventFieldBoundaries,
    runtimeJournalFixtures,
  };
}

async function exercisePendingManagedTransition(
  adapter: any,
  build: any,
  processId: string,
) {
  const cursor = eventCursor(adapter);
  adapter.clickText("Hold secondary");
  adapter.clickText("Open detail page");
  const pendingEvents = await waitForEvent(
    adapter,
    cursor,
    (event) =>
      event.event === "firstContent" &&
      event.pageEntry === "detail.lynx.bundle" &&
      String(event.bundleId) === build.bundleId,
    "pending detail firstContent",
  );
  const opened = pendingEvents.findLast(
    (event: any) =>
      ["pageOpened", "routeOpened"].includes(event.event) &&
      event.pageEntry === "detail.lynx.bundle" &&
      String(event.bundleId) === build.bundleId,
  );
  assert.ok(opened?.pageAttemptId, "Pending detail lacks a page attempt");
  assert.ok(
    !pendingEvents.some(
      (event: any) =>
        event.event === "pageAdmitted" &&
        event.pageAttemptId === opened.pageAttemptId,
    ),
    "Held detail was admitted before the managed transition",
  );
  adapter.clickText("Reload pending");
  await adapter.waitForText(`Detail bundle ${build.variant} ready`);
  const events = await waitForEvent(
    adapter,
    cursor,
    (event) =>
      event.event === "pageAttemptTerminal" &&
      event.pageAttemptId === opened.pageAttemptId &&
      event.terminal === "authorized-cancel" &&
      event.reason === "managedTransition",
    "managed-transition pending terminal",
  );
  const terminal = events.findLast(
    (event: any) =>
      event.event === "pageAttemptTerminal" &&
      event.pageAttemptId === opened.pageAttemptId,
  );
  const accepted = events.findLast(
    (event: any) =>
      event.event === "transitionAccepted" &&
      event.transitionId === terminal.transitionId,
  );
  assert.ok(accepted, "Pending terminal did not share transitionAccepted ID");
  const reconstructed = events.findLast(
    (event: any) =>
      event.event === "generationStarted" &&
      event.transitionId === terminal.transitionId &&
      String(event.bundleId) === build.bundleId &&
      JSON.stringify(event.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]),
  );
  assert.ok(reconstructed, "Managed transition did not reconstruct the stack");
  assert.notEqual(reconstructed.generationId, opened.generationId);
  assert.equal(String(reconstructed.releaseId), String(build.releaseId));
  const admitted = events.findLast(
    (event: any) =>
      event.event === "pageAdmitted" &&
      event.generationId === reconstructed.generationId &&
      event.pageEntry === "detail.lynx.bundle",
  );
  assert.ok(admitted, "Reconstructed detail was not admitted");
  assert.notEqual(admitted.pageAttemptId, opened.pageAttemptId);
  adapter.clickText("Close detail page");
  await adapter.waitForText(`Bundle ${build.variant} ready`);
  assert.equal(adapter.processId(), processId);
  return eventsSince(adapter, cursor);
}

function pendingManagedTransitionReceipt(
  events: any[],
  before: any,
  after: any,
) {
  const terminal = events.findLast(
    (event: any) =>
      event.event === "pageAttemptTerminal" &&
      event.terminal === "authorized-cancel" &&
      event.reason === "managedTransition",
  );
  assert.ok(terminal?.transitionId && terminal?.pageAttemptId);
  const accepted = events.findLast(
    (event: any) =>
      event.event === "transitionAccepted" &&
      event.transitionId === terminal.transitionId,
  );
  const started = events.findLast(
    (event: any) =>
      event.event === "generationStarted" &&
      event.transitionId === terminal.transitionId &&
      event.generationId === after.identity.generationId,
  );
  const admitted = events.findLast(
    (event: any) =>
      event.event === "pageAdmitted" &&
      event.generationId === after.identity.generationId &&
      event.pageEntry === "detail.lynx.bundle",
  );
  assert.ok(accepted && started && admitted);
  return {
    processId: before.identity.processId,
    bundleId: before.identity.bundleId,
    releaseId: before.identity.releaseId,
    sourceGenerationId: before.identity.generationId,
    pendingPageAttemptId: terminal.pageAttemptId,
    terminal: "authorized-cancel",
    reason: "managedTransition",
    transitionId: terminal.transitionId,
    targetGenerationId: after.identity.generationId,
    reconstructedPageAttemptId: admitted.pageAttemptId,
    orderedPageEntries: started.orderedPageEntries,
    orderedPageParameters: started.orderedPageParameters,
    topPageEntry: started.topPageEntry,
    sourceContextId: terminal.sourceContextId,
    nativePageClass: terminal.nativePageClass,
  };
}

async function openUnconfirmedDetailPage(
  adapter: any,
  cursor: number,
  build: any,
  processId: string,
  displayVariant: "A" | "B",
  primaryReady = false,
) {
  adapter.clickText("Open detail page");
  await adapter.waitForText(
    `Detail bundle ${displayVariant}: readiness deliberately withheld`,
  );
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const events = eventsSince(adapter, cursor);
    if (
      hasCompletePendingDetailEvents(events, build, processId, primaryReady)
    ) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for pending detail in unconfirmed ${build.variant}`,
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

function changedAssetFile(deployment: any, assetPath: string) {
  const url = new URL(
    deployment.deliveryArtifactResponse?.changedAssets?.[assetPath]?.file?.url,
  );
  assert.equal(
    url.origin,
    origin,
    `Unexpected matrix asset origin for ${assetPath}`,
  );
  assert.ok(url.pathname.startsWith("/files/"));
  const key = url.pathname
    .slice("/files/".length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const file = path.resolve(otaRoot, "objects", key);
  const objectRoot = `${path.resolve(otaRoot, "objects")}${path.sep}`;
  assert.ok(
    file.startsWith(objectRoot),
    "Changed asset escaped the object store",
  );
  return { file, url: url.toString() };
}

async function rejectRawDetailTarget(
  adapter: any,
  platform: LynxMatrixPlatform,
  deployment: any,
  target: any,
  running: any,
  displayVariant: "A" | "B" | "C",
  mode: "corrupt" | "missing",
) {
  const detail = changedAssetFile(deployment, "detail.lynx.bundle");
  const original = await fsp.readFile(detail.file);
  assert.equal(deployment.deliveryArtifactResponse?.fileUrl, null);
  assert.equal(deployment.deliveryArtifactResponse?.fileHash, null);
  const eventsBefore = adapter.readEvents();
  const generationBefore = eventsBefore.findLast(
    (event: any) => event.event === "generationStarted",
  );
  const processBefore = adapter.processId();
  const fallbackMarker = `HotUpdaterArchiveFallbackApplied bundleId=${target.bundleId}`;
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  const requestsBefore = serverRequests(detail.url);
  const nativeLogsBefore = adapter.readNativeLogs();
  const failureCursor =
    readSdkInstallFailureEvidence(installFailuresPath).length;
  const fallbackCountBefore = nativeLogsBefore.split(fallbackMarker).length - 1;
  const moved = `${detail.file}.${process.pid}.${Date.now()}.missing`;
  const corruptBytes = Buffer.from("corrupt-detail");
  let nativeInstallError = "";
  let nativeInstallFailure: any;
  let consumedRequests: any[] = [];
  try {
    if (mode === "missing") await fsp.rename(detail.file, moved);
    else await fsp.writeFile(detail.file, corruptBytes);
    adapter.clickText("Install next launch");
    nativeInstallError = await adapter.waitForTextValue("Installation failed:");
    nativeInstallFailure = await waitForSdkInstallFailure(failureCursor);
    await waitForServerRequestCount(detail.url, requestsBefore.length + 1);
    consumedRequests = serverRequests(detail.url).slice(requestsBefore.length);
  } finally {
    if (mode === "missing") await fsp.rename(moved, detail.file);
    else await fsp.writeFile(detail.file, original);
  }
  await adapter.waitForText(`Bundle ${displayVariant} ready`);
  assert.equal(adapter.processId(), processBefore);
  const eventsAfter = adapter.readEvents();
  const generationAfter = eventsAfter.findLast(
    (event: any) => event.event === "generationStarted",
  );
  assert.equal(generationAfter?.bundleId, generationBefore?.bundleId);
  assert.equal(generationAfter?.releaseId, generationBefore?.releaseId);
  assert.equal(generationAfter?.generationId, generationBefore?.generationId);
  assert.ok(
    !eventsAfter
      .slice(eventsBefore.length)
      .some(
        (event: any) =>
          event.event === "generationStarted" &&
          String(event.bundleId) === target.bundleId,
      ),
    `${mode} detail unexpectedly activated the rejected target`,
  );
  const nativeLogsAfter = adapter.readNativeLogs();
  const fallbackCountAfter = nativeLogsAfter.split(fallbackMarker).length - 1;
  assert.equal(fallbackCountAfter, fallbackCountBefore);
  assert.ok(consumedRequests.length >= 1, `${mode} detail was not requested`);
  for (const request of consumedRequests) {
    assert.equal(request.requestUrl, detail.url);
    assert.equal(request.path, new URL(detail.url).pathname);
    assert.equal(request.status, mode === "missing" ? 404 : 200);
    assert.equal(
      request.responseErrorCode,
      mode === "missing" ? "HTTP_404" : null,
    );
  }
  const responseSha256s = [
    ...new Set(consumedRequests.map((request) => request.responseSha256)),
  ];
  assert.equal(responseSha256s.length, 1);
  const actualAssetSha256 =
    mode === "corrupt"
      ? createHash("sha256").update(corruptBytes).digest("hex")
      : null;
  if (actualAssetSha256) {
    assert.equal(responseSha256s[0], actualAssetSha256);
    assert.notEqual(
      actualAssetSha256,
      target.files["detail.lynx.bundle"].sha256,
    );
  }
  if (mode === "missing") {
    assert.equal(responseSha256s[0], MISSING_ASSET_RESPONSE_SHA256);
  }
  const expectedFailure = expectedRawDetailNativeFailure(platform, mode);
  assert.deepEqual(
    {
      code: nativeInstallFailure.failure.code,
      message: nativeInstallFailure.failure.message,
    },
    expectedFailure,
  );
  assert.equal(nativeInstallFailure.failure.bundleId, target.bundleId);
  assert.equal(nativeInstallFailure.failure.releaseId, target.releaseId);
  assert.ok(
    nativeInstallError.includes(
      `[${expectedFailure.code}] ${expectedFailure.message}`,
    ),
  );
  return {
    mode,
    targetBundleId: target.bundleId,
    targetReleaseId: target.releaseId,
    rawDetailAssetPath: "detail.lynx.bundle",
    rawDetailFileUrl: detail.url,
    expectedSha256: target.files["detail.lynx.bundle"].sha256,
    actualAssetSha256,
    requestUrl: detail.url,
    requestPath: new URL(detail.url).pathname,
    requestCountBefore: requestsBefore.length,
    requestCountAfter: requestsBefore.length + consumedRequests.length,
    consumedRequestCount: consumedRequests.length,
    responseStatus: consumedRequests[0].status,
    responseSha256: responseSha256s[0],
    responseErrorCode: consumedRequests[0].responseErrorCode,
    nativeInstallError,
    nativeInstallErrorCode: nativeInstallFailure.failure.code,
    nativeInstallErrorMessage: nativeInstallFailure.failure.message,
    nativeInstallErrorReceivedAt: nativeInstallFailure.receivedAt,
    nativeInstallErrorTransport: nativeInstallFailure.transport,
    archiveFileUrl: null,
    archiveFileHash: null,
    archiveFallbackUsed: false,
    runningBundleId: running.bundleId,
    runningReleaseId: running.releaseId,
    processId: processBefore,
    generationId: generationBefore?.generationId,
    generationIdAfter: generationAfter?.generationId,
    bundleIdAfter: generationAfter?.bundleId,
    releaseIdAfter: generationAfter?.releaseId,
    fallbackMarkerCountBefore: fallbackCountBefore,
    fallbackMarkerCountAfter: fallbackCountAfter,
    rejectedBeforeTransition: true,
  };
}

async function rejectCrossProvenanceTarget(
  adapter: any,
  deployment: any,
  running: any,
  displayVariant: "A" | "B" | "C",
) {
  assert.equal(deployment.incompatibleRuntimeAllowed, true);
  assert.notEqual(deployment.runtimeId, running.runtimeId);
  assert.equal(
    deployment.deliveryArtifactResponse?.changedAssets,
    undefined,
    "Cross-provenance fixture must use ordinary complete-artifact delivery",
  );
  const artifactUrl = deployment.fileUrl;
  assert.equal(typeof artifactUrl, "string");
  const eventsBefore = adapter.readEvents();
  const generationBefore = eventsBefore.findLast(
    (event: any) => event.event === "generationStarted",
  );
  assert.equal(String(generationBefore?.bundleId), running.bundleId);
  assert.equal(String(generationBefore?.releaseId), running.releaseId);
  const processId = adapter.processId();
  const requestCountBefore = serverRequestCount(artifactUrl);

  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install next launch");
  await adapter.waitForText("Installation failed:");
  await adapter.waitForText("INCOMPATIBLE");
  const requestCountAfterFirst = await waitForServerRequestCount(
    artifactUrl,
    requestCountBefore + 1,
  );
  assert.equal(
    requestCountAfterFirst,
    requestCountBefore + 1,
    "The first incompatible preparation fetched the artifact more than once",
  );

  adapter.clickText("Check update");
  const cachedResult = await adapter.waitForEitherText([
    "Update check failed:",
    "Update verified and ready to install.",
  ]);
  if (cachedResult === "Update verified and ready to install.") {
    adapter.clickText("Install next launch");
    await adapter.waitForText("Installation failed:");
  }
  await adapter.waitForText("INCOMPATIBLE");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    serverRequestCount(artifactUrl),
    requestCountAfterFirst,
    "Cached cross-provenance rejection downloaded the artifact again",
  );
  await adapter.waitForText(`Bundle ${displayVariant} ready`);
  assert.equal(adapter.processId(), processId);
  const eventsAfter = adapter.readEvents();
  const generationAfter = eventsAfter.findLast(
    (event: any) => event.event === "generationStarted",
  );
  assert.equal(generationAfter?.generationId, generationBefore?.generationId);
  assert.ok(
    !eventsAfter
      .slice(eventsBefore.length)
      .some(
        (event: any) =>
          event.event === "generationStarted" &&
          String(event.bundleId) === deployment.bundleId,
      ),
    "The cross-provenance candidate reached managed evaluation",
  );
  return {
    candidate: {
      bundleId: deployment.bundleId,
      releaseId: deployment.releaseId,
      runtimeId: deployment.runtimeId,
      manifestSha256: deployment.persistedManifestFileHash,
      artifactUrl,
    },
    running: {
      bundleId: running.bundleId,
      releaseId: running.releaseId,
      runtimeId: running.runtimeId,
      processId,
      generationId: generationBefore?.generationId,
    },
    nativeErrorCode: "INCOMPATIBLE",
    rejectedBeforeGenerationEvaluation: true,
    firstArtifactRequestCount: 1,
    cachedArtifactRequestCount: 0,
  };
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
  const key = kind === "fatal" ? "crashedBundleIds" : "unconfirmedReleaseIds";
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
  const runtimeEventLedger = new GenerationEventLedger();

  const [
    aSource,
    bSource,
    cSource,
    fatalSource,
    confirmedInterruptionSource,
    unconfirmedSource,
    incompatibleSource,
  ] = [
    await compile(framework, platform, "A", "A"),
    await compile(framework, platform, "B", "B"),
    await compile(framework, platform, "C", "C"),
    await compile(framework, platform, "FATAL", "B", "unconfirmed"),
    await compile(
      framework,
      platform,
      "CONFIRMED_INTERRUPTION",
      "B",
      "detail-unconfirmed",
    ),
    await compile(framework, platform, "UNCONFIRMED", "A", "unconfirmed"),
    await compile(framework, platform, "INCOMPATIBLE", "C"),
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

  const aDeployment = await deploy({
    framework,
    platform,
    fixture: aSource.fixture,
    channel,
    bundleId: embeddedReceipt.embeddedBundleId,
  });
  assert.equal(
    aDeployment.bundleId,
    embeddedReceipt.embeddedBundleId,
    "Server A must register the exact embedded multi-page Bundle",
  );
  const bDeployment = await deploy({
    framework,
    platform,
    fixture: bSource.fixture,
    channel,
    patch: true,
    fromBundleId: aDeployment.bundleId,
  });
  const A = normalizeBuild({
    role: "A",
    compilerReceipt: aSource.compilerReceipt,
    embeddedReceipt,
    runtimeId: runtimeId(platform),
  });
  const serverA = normalizeBuild({
    role: "A",
    compilerReceipt: aSource.compilerReceipt,
    deploymentReceipt: aDeployment,
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
  const aEvents = await exerciseDetailPage(
    adapter,
    cursor,
    A,
    processA,
    "A",
    "close",
  );
  const navigationBoundaries = await exerciseNavigationBoundaries(adapter, "A");
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: before native boundaries`,
  );
  const nativeDiagnostics = await exerciseNativeDiagnostics(adapter, "A");
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: after native boundaries`,
  );
  await adapter.screenshot(`${cellId}-embedded-A`);

  const bRejections = [];
  for (const mode of ["missing", "corrupt"] as const) {
    bRejections.push(
      await rejectRawDetailTarget(
        adapter,
        platform,
        bDeployment,
        B,
        A,
        "A",
        mode,
      ),
    );
  }

  cursor = eventCursor(adapter);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install next launch");
  await adapter.waitForText("Update installed. Close and reopen the app.");
  const bDeltaLogs = adapter.readNativeLogs();

  await stopServer();
  const originProbe = await assertOriginUnused();
  cursor = eventCursor(adapter);
  const processBActivation = adapter.launch(framework, channel);
  await adapter.waitForText("Bundle B ready");
  const bActivationEvents = await exerciseDetailPage(
    adapter,
    cursor,
    B,
    processBActivation,
    "B",
    "back",
  );
  await adapter.screenshot(`${cellId}-offline-B-activation`);
  await assertOriginUnused();

  cursor = eventCursor(adapter);
  const processBRetain = adapter.launch(framework, channel);
  await adapter.waitForText("Bundle B ready");
  let bRetainEvents = await leaveDetailPageOpen(
    adapter,
    cursor,
    B,
    processBRetain,
    "B",
  );
  await adapter.screenshot(`${cellId}-offline-B-retain`);
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
  adapter.clickText("Close detail page");
  await adapter.waitForText("Bundle B ready");
  const cRejections = [];
  for (const mode of ["missing", "corrupt"] as const) {
    cRejections.push(
      await rejectRawDetailTarget(
        adapter,
        platform,
        cDeployment,
        C,
        B,
        "B",
        mode,
      ),
    );
  }
  cursor = eventCursor(adapter);
  await leaveDetailPageOpen(adapter, cursor, B, processBRetain, "B");
  cursor = eventCursor(adapter);
  const reloadProcess = adapter.processId();
  assert.equal(reloadProcess, processBRetain);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install and reload");
  const cEvents = await closeReconstructedDetailPage(
    adapter,
    cursor,
    C,
    reloadProcess,
    "C",
  );
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: B to C`,
  );
  assert.equal(
    adapter.processId(),
    reloadProcess,
    "HotUpdater.reload() restarted the OS process",
  );
  adapter.clickText("Verify stale after reload");
  await waitForStaleContextRejections(adapter, cursor, B.bundleId);
  const deltaLogs = adapter.readNativeLogs();
  await adapter.screenshot(`${cellId}-delta-C-reload`);

  const incompatibleDeployment = await deploy({
    framework,
    platform,
    fixture: incompatibleSource.fixture,
    channel,
    runtimeIdOverride: LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS[platform],
    allowIncompatibleRuntime: true,
  });
  const incompatibleBuild = normalizeBuild({
    role: "INCOMPATIBLE",
    compilerReceipt: incompatibleSource.compilerReceipt,
    deploymentReceipt: incompatibleDeployment,
    runtimeId: LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS[platform],
  });
  const crossProvenanceRejection = await rejectCrossProvenanceTarget(
    adapter,
    incompatibleDeployment,
    C,
    "C",
  );
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: cross-provenance rejection`,
  );

  cursor = eventCursor(adapter);
  adapter.clickText("Replace primary");
  await adapter.waitForText("Bundle C ready");
  adapter.clickText("Open detail page");
  await adapter.waitForText("Detail bundle C ready");
  await waitForReadyEvents(adapter, cursor, C, reloadProcess);
  adapter.clickText("Verify stale after reload");
  await waitForStaleContextRejections(adapter, cursor, C.bundleId);
  adapter.clickText("Close detail page");
  await adapter.waitForText("Bundle C ready");
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      ["pageClosed", "routeClosed"].includes(event.event) &&
      event.pageEntry === "detail.lynx.bundle" &&
      event.topPageEntry === "main.lynx.bundle",
    "primary-replacement detail close",
  );
  const primaryReplacementEvents = eventsSince(adapter, cursor);
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: primary replacement`,
  );
  await adapter.screenshot(`${cellId}-primary-replacement`);

  const pendingManagedTransitionEvents = await exercisePendingManagedTransition(
    adapter,
    C,
    reloadProcess,
  );
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: pending managed transition`,
  );

  cursor = eventCursor(adapter);
  adapter.clickText("Fail secondary");
  adapter.clickText("Open detail page");
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      event.event === "runtimeFailed" &&
      String(event.bundleId) === C.bundleId &&
      event.pageEntry === "detail.lynx.bundle",
    "fatal detail after primary confirmation",
  );
  await waitForEvent(
    adapter,
    cursor,
    (event) =>
      event.event === "generationStarted" &&
      event.reason === "recovery" &&
      String(event.bundleId) === C.bundleId,
    "confirmed C detail recovery",
  );
  await adapter.waitForText("Bundle C ready");
  await exerciseDetailPage(adapter, cursor, C, reloadProcess, "C", "close");
  const confirmedDetailFatalEvents = eventsSince(adapter, cursor);
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: confirmed detail fatal`,
  );

  const confirmedInterruptionDeployment = await deploy({
    framework,
    platform,
    fixture: confirmedInterruptionSource.fixture,
    channel,
  });
  const confirmedInterruption = normalizeBuild({
    role: "CONFIRMED_INTERRUPTION",
    compilerReceipt: confirmedInterruptionSource.compilerReceipt,
    deploymentReceipt: confirmedInterruptionDeployment,
    runtimeId: runtimeId(platform),
  });
  cursor = eventCursor(adapter);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install and reload");
  await adapter.waitForText("Bundle B ready");
  await openUnconfirmedDetailPage(
    adapter,
    cursor,
    confirmedInterruption,
    reloadProcess,
    "B",
    true,
  );
  const confirmedInterruptionAttemptEvents = eventsSince(adapter, cursor);
  const interruptedProcess = adapter.processId();
  cursor = eventCursor(adapter);
  const confirmedInterruptionRecoveryProcess = adapter.launch(
    framework,
    channel,
  );
  assert.notEqual(
    confirmedInterruptionRecoveryProcess,
    interruptedProcess,
    "Pending-detail process interruption did not replace the OS process",
  );
  await adapter.waitForText("Detail bundle C ready");
  await waitForReadyEvents(
    adapter,
    cursor,
    C,
    confirmedInterruptionRecoveryProcess,
  );
  adapter.clickText("Close detail page");
  await adapter.waitForText("Bundle C ready");
  const confirmedInterruptionRecoveryEvents = eventsSince(adapter, cursor);
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: confirmed interruption recovery`,
  );
  const confirmedInterruptionState = stateForChannel(adapter, channel);
  const postInterruptionProcess = adapter.processId();

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
  adapter.clickText("Fail secondary");
  adapter.clickText("Open detail page");
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
  await exerciseDetailPage(
    adapter,
    cursor,
    C,
    postInterruptionProcess,
    "C",
    "back",
  );
  const fatalEvents = eventsSince(adapter, cursor);
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: pre-confirm detail fatal`,
  );
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
  await openUnconfirmedDetailPage(
    adapter,
    cursor,
    unconfirmed,
    processUnconfirmedAttempt,
    "A",
    false,
  );
  const unconfirmedAttemptEvents = eventsSince(adapter, cursor);
  cursor = eventCursor(adapter);
  const unconfirmedRecoveryProcess = adapter.launch(framework, channel);
  await adapter.waitForText("Detail bundle C ready");
  await waitForReadyEvents(adapter, cursor, C, unconfirmedRecoveryProcess);
  adapter.clickText("Close detail page");
  await adapter.waitForText("Bundle C ready");
  const unconfirmedRecoveryEvents = eventsSince(adapter, cursor);
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: pre-confirm process recovery`,
  );
  const unconfirmedState = stateForChannel(adapter, channel);

  const cToBDeployment = await createPublicMatrixBundleDiff({
    baseBundleId: C.bundleId,
    releaseId: B.releaseId,
    targetBundleId: B.bundleId,
  });
  const bToADeployment = await createPublicMatrixBundleDiff({
    baseBundleId: B.bundleId,
    releaseId: serverA.releaseId,
    targetBundleId: serverA.bundleId,
  });
  await setReleaseEnabled(C.releaseId, false);
  const cToBRejections = [];
  for (const mode of ["missing", "corrupt"] as const) {
    cToBRejections.push(
      await rejectRawDetailTarget(
        adapter,
        platform,
        cToBDeployment,
        B,
        C,
        "C",
        mode,
      ),
    );
  }
  cursor = eventCursor(adapter);
  const rollbackProcess = adapter.processId();
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install and reload");
  await adapter.waitForText("Bundle B ready");
  const rollbackBEvents = await exerciseDetailPage(
    adapter,
    cursor,
    B,
    rollbackProcess,
    "B",
    "back",
  );
  const cToBLogs = adapter.readNativeLogs();
  assert.equal(adapter.processId(), rollbackProcess);
  await setReleaseEnabled(B.releaseId, false);
  const bToARejections = [];
  for (const mode of ["missing", "corrupt"] as const) {
    bToARejections.push(
      await rejectRawDetailTarget(
        adapter,
        platform,
        bToADeployment,
        serverA,
        B,
        "B",
        mode,
      ),
    );
  }
  cursor = eventCursor(adapter);
  adapter.clickText("Check update");
  await adapter.waitForText("Update verified and ready to install.");
  adapter.clickText("Install and reload");
  await adapter.waitForText("Bundle A ready");
  const rollbackAEvents = await exerciseDetailPage(
    adapter,
    cursor,
    serverA,
    rollbackProcess,
    "A",
    "close",
  );
  const bToALogs = adapter.readNativeLogs();
  await checkpointRuntimeEvents(
    adapter,
    runtimeEventLedger,
    `${cellId}: reverse rollbacks`,
  );
  assert.equal(adapter.processId(), rollbackProcess);

  const allEvents = adapter.readEvents();
  validateAttributedDiagnostics(allEvents);
  const allLogs = adapter.readNativeLogs();
  assertNoManagedResourceEngineErrors(allLogs);
  const managedResourceEngineErrorCodes =
    findManagedResourceEngineErrorCodes(allLogs);
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
  const afterPendingManagedTransition = collectReadyLaunch({
    phaseEvents: pendingManagedTransitionEvents,
    allEvents,
    build: C,
    processId: reloadProcess,
  });
  const primaryGenerationRetirement = collectInvalidatedContexts(
    allEvents,
    afterReload,
    { reason: "primaryRemoved" },
  );
  const confirmedDetailFatalPending = collectFatalPendingDetailLaunch({
    phaseEvents: confirmedDetailFatalEvents,
    allEvents,
    build: C,
    processId: reloadProcess,
    primaryReady: true,
    existingLaunch: afterPendingManagedTransition,
  });
  const confirmedDetailFatalFailure = collectSecondaryFatalFailure(
    confirmedDetailFatalEvents,
    confirmedDetailFatalPending,
  );
  const confirmedDetailFatalRetirement = collectInvalidatedContexts(
    allEvents,
    confirmedDetailFatalPending,
    { reason: "recovery", requireStaleAuthorities: false },
  );
  const confirmedDetailFatalRecovered = collectReadyLaunch({
    phaseEvents: confirmedDetailFatalEvents,
    allEvents,
    build: C,
    processId: reloadProcess,
  });
  const confirmedInterruptionLaunch = collectPendingDetailLaunch({
    phaseEvents: confirmedInterruptionAttemptEvents,
    allEvents,
    build: confirmedInterruption,
    processId: interruptedProcess,
    primaryReady: true,
  });
  const confirmedInterruptionFailure = collectProcessInterruption(
    allEvents,
    confirmedInterruptionLaunch,
  );
  const confirmedInterruptionRecovered = collectReadyLaunch({
    phaseEvents: confirmedInterruptionRecoveryEvents,
    allEvents,
    build: C,
    processId: confirmedInterruptionRecoveryProcess,
  });
  const fatalCandidateLaunch = collectFatalPendingDetailLaunch({
    phaseEvents: fatalEvents,
    allEvents,
    build: fatal,
    processId: postInterruptionProcess,
    primaryReady: false,
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
  const unconfirmedCandidateLaunch = collectPendingDetailLaunch({
    phaseEvents: unconfirmedAttemptEvents,
    allEvents,
    build: unconfirmed,
    processId: processUnconfirmedAttempt,
    primaryReady: false,
  });
  const unconfirmedFailure = collectProcessInterruption(
    allEvents,
    unconfirmedCandidateLaunch,
  );
  const unconfirmedRecovered = collectReadyLaunch({
    phaseEvents: unconfirmedRecoveryEvents,
    allEvents,
    build: C,
    processId: unconfirmedRecoveryProcess,
  });
  const rollbackB = collectReadyLaunch({
    phaseEvents: rollbackBEvents,
    allEvents,
    build: B,
    processId: rollbackProcess,
  });
  const rollbackA = collectReadyLaunch({
    phaseEvents: rollbackAEvents,
    allEvents,
    build: serverA,
    processId: rollbackProcess,
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
  assert.equal(countCandidateAttempts(confirmedInterruption), 1);
  assert.equal(countCandidateAttempts(unconfirmed), 1);

  const receipt = {
    schemaVersion: "lynx-public-matrix-v2",
    cellId,
    framework,
    platform,
    commit,
    binary: {
      path: adapter.binaryPath,
      installedSha256: binaryInstalled,
      finalSha256: await adapter.installedBinaryHash(),
    },
    nativeArtifacts,
    builds: {
      A,
      serverA,
      B,
      C,
      confirmedInterruption,
      fatal,
      unconfirmed,
    },
    diagnostics: {
      managedResourceEngineErrorCodes,
      ...nativeDiagnostics,
      runtimeEventLedger: runtimeEventLedger.receipt(),
    },
    phases: {
      embeddedA,
      navigationBoundaries,
      crossProvenance: {
        build: incompatibleBuild,
        rejection: crossProvenanceRejection,
      },
      deltaB: {
        delivery: collectDeltaDelivery(bDeployment, bDeltaLogs),
        rawDetailRejections: bRejections,
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
        rawDetailRejections: cRejections,
        beforeReload,
        afterReload,
        generationRetirement,
      },
      primaryLifecycle: {
        beforeRemoval: afterReload,
        generationRetirement: primaryGenerationRetirement,
        afterReplacement: afterPrimaryReplacement,
      },
      pendingManagedTransition: {
        before: afterPrimaryReplacement,
        after: afterPendingManagedTransition,
        receipt: pendingManagedTransitionReceipt(
          pendingManagedTransitionEvents,
          afterPrimaryReplacement,
          afterPendingManagedTransition,
        ),
      },
      confirmedDetailFatal: {
        beforeFailure: confirmedDetailFatalPending,
        failureEvent: confirmedDetailFatalFailure,
        generationRetirement: confirmedDetailFatalRetirement,
        recovered: confirmedDetailFatalRecovered,
      },
      confirmedInterruptionRecovery: {
        kind: "confirmed-interruption",
        candidate: {
          bundleId: confirmedInterruption.bundleId,
          releaseId: confirmedInterruption.releaseId,
        },
        failedAttemptId: confirmedInterruptionFailure.attemptId,
        failureEvent: confirmedInterruptionFailure,
        candidateLaunch: confirmedInterruptionLaunch,
        recovered: confirmedInterruptionRecovered,
        persistedExclusions: exclusions(
          confirmedInterruptionState,
          "unconfirmed",
        ),
        crashedBundleIds: exclusions(confirmedInterruptionState, "fatal"),
        candidateRetried: false,
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
      reverseRollback: {
        cToB: {
          delivery: collectDeltaDelivery(cToBDeployment, cToBLogs),
          rawDetailRejections: cToBRejections,
          launch: rollbackB,
        },
        bToA: {
          delivery: collectDeltaDelivery(bToADeployment, bToALogs),
          rawDetailRejections: bToARejections,
          launch: rollbackA,
        },
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
      appBaseURL: sdkBaseURL("ios"),
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
      appBaseURL: sdkBaseURL("android"),
      deviceId: requiredString("android-serial"),
      binaryPath: binaryPath("android"),
      resultsDir,
    }),
  );
}

const receipts = [];
try {
  for (const platform of platforms) {
    const adapter = adapters.get(platform);
    const sourceHash = await adapter.sourceBinaryHash();
    assert.equal(
      sourceHash,
      nativeArtifacts.artifacts[platform].binarySha256,
      "Supplied native artifact differs from its full-artifact receipt",
    );
    adapter.install();
    assert.equal(
      await adapter.installedBinaryHash(),
      sourceHash,
      "Installed native binary differs from the supplied artifact",
    );
    for (const framework of frameworks) {
      await resetServerState();
      receipts.push(await runCell(adapter, framework, platform));
    }
  }
} finally {
  await stopServer();
}

const summary = {
  schemaVersion: "lynx-public-matrix-summary-v2",
  commit,
  nativeArtifacts,
  cells: receipts,
  passed: true,
};
validateLynxMatrixSummary(summary, cellIds);
await fsp.writeFile(
  path.join(resultsDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(`[lynx-matrix:passed] ${receipts.length} cells`);
