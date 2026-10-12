import { isDeepStrictEqual } from "node:util";

import { lynxAndroidInstalledManifestPaths } from "./lynx-store.ts";

export function assertLynxHeadlessProcessStopped(
  output: string,
  appId: string,
): void {
  const names = output
    .trim()
    .split(/\r?\n/)
    .map((name) => name.trim());
  if (names.shift() !== "NAME" || names.length === 0) {
    throw new Error(
      "Missing checked Android process list for Lynx headless proof",
    );
  }
  if (names.some((name) => name === appId || name.startsWith(`${appId}:`))) {
    throw new Error(
      "Lynx headless proof requires a stopped application process",
    );
  }
}

export function readLynxHeadlessManifest(options: {
  appId: string;
  scope: string;
  bundleId: string;
  read: (file: string) => Buffer | null;
}): Buffer {
  for (const file of lynxAndroidInstalledManifestPaths(
    options.appId,
    options.scope,
    options.bundleId,
  )) {
    const bytes = options.read(file);
    if (bytes) return bytes;
  }
  throw new Error("Missing staged Lynx manifest in the selected native scope");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Missing Lynx headless native evidence");
  }
  return value as Record<string, unknown>;
}

export function assertLynxHeadlessTask(options: {
  bundleId: string;
  before: Buffer;
  after: Buffer;
  eventsBefore: Buffer;
  eventsAfter: Buffer;
  manifest: Buffer;
  manifestHash: string;
  result: unknown;
}): void {
  const journal = record(JSON.parse(options.before.toString("utf8")));
  const next = record(journal.next);
  const confirmed = record(journal.confirmed);
  const result = record(options.result);
  if (result.success !== true) {
    throw new Error(
      `Lynx background execution failed: ${String(result.error)}`,
    );
  }
  const output = record(JSON.parse(String(result.value)));
  const manifest = record(JSON.parse(options.manifest.toString("utf8")));
  if (
    !options.before.equals(options.after) ||
    !options.eventsBefore.equals(options.eventsAfter) ||
    next.bundleId !== options.bundleId ||
    typeof confirmed.bundleId !== "string" ||
    !confirmed.bundleId ||
    confirmed.bundleId === options.bundleId ||
    journal.pending ||
    journal.pageAttempt ||
    journal.generationFailure ||
    !Number.isInteger(result.processId) ||
    Number(result.processId) <= 0 ||
    result.activitiesCreated !== 0 ||
    result.activitiesStarted !== 0 ||
    result.activitiesResumed !== 0 ||
    typeof result.taskId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result.taskId,
    ) ||
    !isDeepStrictEqual(result.selection, next) ||
    result.bundleId !== next.bundleId ||
    result.releaseId !== next.releaseId ||
    result.manifestHash !== options.manifestHash ||
    result.entry !== "background-task.js" ||
    manifest.bundleId !== options.bundleId ||
    !record(manifest.assets)["background-task.js"] ||
    output.bundleId !== options.bundleId ||
    output.marker !== "headless-staged-detox"
  ) {
    throw new Error(
      "Lynx headless task must execute staged bytes without UI or foreground journal mutation",
    );
  }
}
