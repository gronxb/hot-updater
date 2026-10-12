import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createControlClient,
  type ControlClient,
  type JsonObject,
} from "../shared/control-client.ts";
import type { MobileContext } from "./context.ts";

// Workers run attempts in parallel, so each attempt files its own records and
// the runner gathers them once the SDK has exited.
const ATTEMPTS_DIR = "attempts";

/** What one attempt's teardown proved: cleanup always, Console Insights when the body finished. */
export interface AttemptRecord {
  schemaVersion: 1;
  name: string | null;
  cleanupCompleted: true;
  consoleInsights?: JsonObject;
  expectedLaunchFailures?: number;
}

export interface QuarantineRecord {
  schemaVersion: 1;
  scenarioName: string | null;
  reason: string;
  quarantineRequired: true;
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

export function recordAttempt(
  resultsDir: string,
  key: string,
  record: AttemptRecord,
) {
  writeAttemptRecord(
    path.join(resultsDir, ATTEMPTS_DIR),
    `${key}.json`,
    record,
  );
}

export function recordQuarantine(
  resultsDir: string,
  key: string,
  record: QuarantineRecord,
) {
  writeAttemptRecord(
    path.join(resultsDir, ATTEMPTS_DIR),
    `${key}.quarantine.json`,
    record,
  );
}

/**
 * Every attempt's records, in the shapes result.ts reads: undefined when no
 * attempt filed one, so a run that never reached a teardown still lacks proof.
 */
export function collectAttemptEvidence(resultsDir: string) {
  const dir = path.join(resultsDir, ATTEMPTS_DIR);
  if (!existsSync(dir)) return {};
  const records: AttemptRecord[] = [];
  let quarantine: QuarantineRecord | undefined;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    if (file.endsWith(".quarantine.json")) quarantine ??= value;
    else records.push(value);
  }
  return {
    cleanupEvidence: {
      schemaVersion: 1,
      attempts: records.map(({ name }) => ({ name, cleanupCompleted: true })),
    },
    evidence: {
      schemaVersion: 1,
      scenarios: records.flatMap(
        ({ name, consoleInsights, expectedLaunchFailures }) =>
          name && consoleInsights
            ? [
                {
                  name,
                  consoleInsights,
                  expectedLaunchFailures: expectedLaunchFailures ?? 0,
                  bodyCompleted: true,
                  cleanupCompleted: true,
                },
              ]
            : [],
      ),
    },
    quarantine,
  };
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

export interface HotUpdaterAttempt {
  readonly client: ControlClient;
  readonly signal: AbortSignal;
  name?: string;
  bootstrap: JsonObject;
  consoleInsights?: JsonObject;
  expectedLaunchFailures?: number;
}

export async function finishAttempt(
  attempt: HotUpdaterAttempt,
  context: Pick<
    MobileContext,
    "resultsDir" | "controlBaseUrl" | "cleanupTimeoutMs"
  >,
) {
  const key = attempt.name ?? randomUUID();
  try {
    // Leave room inside the SDK teardown budget for device/session shutdown.
    await attempt.client.cancelAndDrain({
      timeoutMs: Math.floor(context.cleanupTimeoutMs / 2),
    });
    // The attempt client is fenced after draining. Terminate through the
    // owned controller's explicit device; SDK disposal closes its session.
    const cleanupClient = createControlClient({
      baseUrl: context.controlBaseUrl,
      httpTimeoutMs: Math.floor(context.cleanupTimeoutMs / 2),
    });
    await cleanupClient.postJson(
      "release Remote Config lock after attempt",
      "/e2e/release-remote-config-lock",
      {},
    );
    await cleanupClient.postJson(
      "terminate app after attempt",
      "/e2e/terminate-app",
      {},
    );
  } catch (error) {
    recordQuarantine(context.resultsDir, key, {
      schemaVersion: 1,
      scenarioName: attempt.name ?? null,
      reason: String(error),
      quarantineRequired: true,
    });
    throw error;
  }
  recordAttempt(context.resultsDir, key, {
    schemaVersion: 1,
    name: attempt.name ?? null,
    cleanupCompleted: true,
    ...(attempt.consoleInsights
      ? {
          consoleInsights: attempt.consoleInsights,
          expectedLaunchFailures: attempt.expectedLaunchFailures ?? 0,
        }
      : {}),
  });
}
