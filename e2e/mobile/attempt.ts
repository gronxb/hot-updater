import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonObject } from "../shared/control-client.ts";

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
