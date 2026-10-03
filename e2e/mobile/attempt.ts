import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonObject } from "../detox/control-client.ts";

export interface ScenarioEvidence {
  name: string;
  consoleInsights: JsonObject;
  expectedLaunchFailures: number;
  bodyCompleted: true;
  cleanupCompleted: true;
}

export function writeAttemptRecord(
  resultsDir: string,
  name: string,
  record: unknown,
) {
  mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, name);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2));
  renameSync(temporary, file);
}

// The runner may abandon a timed-out body. Fence its later continuations with
// the same abort signal the control client and app driver use.
export async function runAttemptPhase<T>(
  phase: "setup" | "scenario",
  timeoutMs: number,
  controller: AbortController,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timeout = setTimeout(() => {
    controller.abort(new Error(`E2E ${phase} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", rejectAbort);
  }
}

export function runtimeLaunchArguments(
  platform: "ios" | "android",
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = {
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL: env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    HOT_UPDATER_APP_BASE_URL:
      env.HOT_UPDATER_E2E_APP_BASE_URL || env.HOT_UPDATER_APP_BASE_URL,
  };
  return Object.entries(values).flatMap(([key, value]) =>
    value
      ? platform === "ios"
        ? [`-${key}`, value]
        : ["--es", key, value]
      : [],
  );
}
