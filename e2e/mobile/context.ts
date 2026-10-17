import { readFileSync } from "node:fs";

import type { E2eTrack } from "../shared/tracks.ts";

export interface MobileContext {
  platform: "ios" | "android";
  /** The app shell: the example app, or the brownfield host apps. */
  track: E2eTrack;
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
