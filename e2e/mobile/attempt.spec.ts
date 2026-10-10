import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { createControlClient } from "../shared/control-client.ts";
import {
  collectAttemptEvidence,
  finishAttempt,
  recordAttempt,
  recordQuarantine,
  runtimeLaunchArguments,
} from "./attempt.ts";

it("gathers every parallel attempt's records into the evidence result.ts reads", () => {
  const resultsDir = mkdtempSync(path.join(os.tmpdir(), "attempt-records-"));
  try {
    expect(collectAttemptEvidence(resultsDir)).toEqual({});
    recordAttempt(resultsDir, "passed-scenario", {
      schemaVersion: 1,
      name: "passed-scenario",
      cleanupCompleted: true,
      consoleInsights: { verified: true },
      expectedLaunchFailures: 1,
    });
    // A failed body still proves its cleanup, without Console Insights.
    recordAttempt(resultsDir, "failed-scenario", {
      schemaVersion: 1,
      name: "failed-scenario",
      cleanupCompleted: true,
    });
    expect(collectAttemptEvidence(resultsDir)).toEqual({
      cleanupEvidence: {
        schemaVersion: 1,
        attempts: [
          { name: "failed-scenario", cleanupCompleted: true },
          { name: "passed-scenario", cleanupCompleted: true },
        ],
      },
      evidence: {
        schemaVersion: 1,
        scenarios: [
          {
            name: "passed-scenario",
            consoleInsights: { verified: true },
            expectedLaunchFailures: 1,
            bodyCompleted: true,
            cleanupCompleted: true,
          },
        ],
      },
      quarantine: undefined,
    });
    recordQuarantine(resultsDir, "stuck-scenario", {
      schemaVersion: 1,
      scenarioName: "stuck-scenario",
      reason: "drain timed out",
      quarantineRequired: true,
    });
    expect(collectAttemptEvidence(resultsDir).quarantine).toMatchObject({
      scenarioName: "stuck-scenario",
      quarantineRequired: true,
    });
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
  }
});

it("encodes runtime URLs in native launch arguments without breaking URL punctuation", () => {
  const env = {
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
      "http://127.0.0.1:3107/e2e/runtime-config?profile=a=b",
    HOT_UPDATER_E2E_APP_BASE_URL: "http://127.0.0.1:3007/hot-updater",
  };
  expect(runtimeLaunchArguments("ios", env)).toEqual([
    "-HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    "-HOT_UPDATER_APP_BASE_URL",
    env.HOT_UPDATER_E2E_APP_BASE_URL,
  ]);
  expect(runtimeLaunchArguments("android", env)).toEqual([
    "--es",
    "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL,
    "--es",
    "HOT_UPDATER_APP_BASE_URL",
    env.HOT_UPDATER_E2E_APP_BASE_URL,
  ]);
});

it("releases the Remote Config lock after an aborted attempt drains, before recording cleanup", async () => {
  const resultsDir = mkdtempSync(path.join(os.tmpdir(), "attempt-lock-"));
  const controller = new AbortController();
  const requests: string[] = [];
  let locked = true;
  const fetch = vi.fn(async (url: string) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname === "/e2e/release-remote-config-lock") locked = false;
    if (pathname === "/e2e/terminate-app") expect(locked).toBe(false);
    return new Response(JSON.stringify({ released: true }));
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const client = createControlClient({
      baseUrl: "http://control.test",
      signal: controller.signal,
    });
    controller.abort(new Error("Scenario timed out"));
    await expect(
      client.postJson(
        "scenario finally",
        "/e2e/release-remote-config-lock",
        {},
      ),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
    await finishAttempt(
      {
        client,
        signal: controller.signal,
        name: "remote-config",
        bootstrap: {},
      },
      {
        resultsDir,
        controlBaseUrl: "http://control.test",
        cleanupTimeoutMs: 1000,
      },
    );
    expect(requests).toEqual([
      "/e2e/release-remote-config-lock",
      "/e2e/terminate-app",
    ]);
    expect(locked).toBe(false);
    expect(
      collectAttemptEvidence(resultsDir).cleanupEvidence?.attempts,
    ).toEqual([{ name: "remote-config", cleanupCompleted: true }]);
  } finally {
    vi.unstubAllGlobals();
    rmSync(resultsDir, { recursive: true, force: true });
  }
});
