import { readFileSync } from "node:fs";

export interface MobileContext {
  platform: "ios" | "android";
  deviceId: string;
  session: string;
  runId: string;
  headSha: string;
  profile: string;
  resultsDir: string;
  appPath: string;
  appId: string;
  scenarioNames: string[];
  controlBaseUrl: string;
  /** The SDK `timeout`: bootstrap, reset, and the scenario body together. */
  testTimeoutMs: number;
  cleanupTimeoutMs: number;
}

// Private handoff from run.ts to the SDK child; this is not operator configuration.
export function readMobileContext(): MobileContext {
  const file = process.env.HOT_UPDATER_E2E_MOBILE_CONTEXT;
  if (!file) throw new Error("Start mobile tests through pnpm -w e2e");
  return JSON.parse(readFileSync(file, "utf8")) as MobileContext;
}
