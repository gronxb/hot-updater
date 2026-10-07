import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { MobileContext } from "./context.ts";
import { mobileResultIdentity, normalizeMobileResult } from "./result.ts";
import { resolveE2eCli } from "./run.ts";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const temporaryDirs: string[] = [];

// A fake device engine: enough of the mobile engine's surface for the driver.
const fakeEngineConfig = `
import { defineEngine } from "e2e/engine";
export default {
  tests: ["fixture.e2e.ts"],
  output: "output",
  workers: 1, retries: 0, trace: "off", cache: "off", assertionTimeout: 1000,
  targets: [{name: "ios", engine: defineEngine({
    name: "mobile", version: "0.10.0", spiVersion: 1, platform: "ios",
    fixtures:{device:(context)=>context.fixture("device", {
      openApp:async()=>{throw new Error("expected process disconnect");},
      openLink:async()=>{},
    }, {openApp:{kind:"resource",label:(app)=>app},openLink:{kind:"resource"}})},
    observe: async () => ({root:{ref:{id:"root",revision:""},children:[]},viewport:{width:100,height:100}}),
    locate: async () => [{ref:{id:"result",revision:""},role:"text",testId:"update-action-result",text:" current-channel ->  installed ID r1\\n"}],
  })}],
};
`;

const driverPreamble = `
import { test as base, expect } from "e2e";
import { MobileAppDriver } from ${JSON.stringify(path.join(root, "e2e/mobile/driver.ts"))};
const test = base.extend<{ device: any }>();
const client = {postJson:async()=>({}),runJob:async()=>({}),readScreenStateField:async()=>"idle",waitForScreenStateField:async()=>({})};
const iosAlert = {get:async()=>null};
const driver = (device, screen, overrides = {}) => new MobileAppDriver({
  appId:"org.example", platform:"ios", device, screen, client, iosAlert, signal:new AbortController().signal, ...overrides,
});
`;

// Runs one fixture file through the installed e2e CLI on the fake engine.
async function runFixture(name: string, testSource: string) {
  const resultsRoot = path.join(root, "e2e/results");
  mkdirSync(resultsRoot, { recursive: true });
  const dir = mkdtempSync(path.join(resultsRoot, `mobile-sdk-${name}-`));
  temporaryDirs.push(dir);
  writeFileSync(path.join(dir, "fixture.e2e.ts"), testSource);
  writeFileSync(path.join(dir, "e2e.config.ts"), fakeEngineConfig);
  const exitCode = await execFileAsync(
    process.execPath,
    [resolveE2eCli(), "run", "--config", path.join(dir, "e2e.config.ts")],
    {
      cwd: root,
      env: { ...process.env, E2E_TELEMETRY_DISABLED: "1" },
      timeout: 30_000,
    },
  ).then(
    () => 0,
    (error: { code?: number }) => error.code ?? 1,
  );
  const report = JSON.parse(
    readFileSync(path.join(dir, "output/report.json"), "utf8"),
  );
  return { dir, exitCode, report };
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("mobile scenario driver in the installed SDK", () => {
  it("asserts through the SDK's matchers and accounts for verified launch disconnects", async () => {
    const { dir, exitCode, report } = await runFixture(
      "pass",
      `${driverPreamble}
test("result text", async ({device, screen}) => {
  const app = driver(device, screen);
  // toHaveText compares normalized text: the renderer's whitespace is not part of the result.
  await app.assertText("exact", "update-action-result", "current-channel -> installed ID r1", {exactText:true});
  await app.assertText("any of", "update-action-result", ["no-update", "installed ID r1"]);
});
test("verified expected launch disconnect", async ({device, screen}) => {
  const controls = [];
  const app = driver(device, screen, {
    client:{...client, postJson:async(_stage,path)=>{controls.push(path);return {verified:true};}},
  });
  await app.terminate("stop before external launch");
  await app.control("external hang launch", "/e2e/launch-startup-hang", {bundleId:"hung"});
  await app.terminate("stop external hang");
  expect(controls).toEqual(["/e2e/terminate-app", "/e2e/launch-startup-hang", "/e2e/terminate-app"]);
  await app.launch("crash", {expectCrash:true});
  expect(app.expectedLaunchFailures).toBe(0);
  await app.control("native recovery", "/e2e/wait-for-crash-recovery", {});
  expect(app.expectedLaunchFailures).toBe(1);
  await app.verifyConsoleInsights(0);
});
`,
    );
    expect(exitCode).toBe(0);
    const steps = report.run.results[0].attempts[0].steps.map(
      (step: { api: string; status: string }) => `${step.api}:${step.status}`,
    );
    expect(steps).toContain("expect.toHaveText:passed");
    expect(steps).toContain("expect.toContainText:passed");
    const failedSteps = report.run.results[1].attempts[0].steps.filter(
      (step: { status: string }) => step.status === "failed",
    );
    expect(failedSteps.map((step: { api: string }) => step.api)).toEqual([
      "device.openApp",
    ]);
    const context: MobileContext = {
      runId: "fixture",
      headSha: report.run.vcs.commit,
      profile: "fixture",
      platform: "ios",
      deviceId: "fixture-device",
      session: "fixture-session",
      resultsDir: dir,
      appPath: "fixture.app",
      appId: "org.example",
      scenarioNames: ["result text", "verified expected launch disconnect"],
      controlBaseUrl: "http://127.0.0.1:1",
      testTimeoutMs: 30_000,
      cleanupTimeoutMs: 30_000,
    };
    // The SDK's report as written: both scenarios, one verified disconnect.
    const result = normalizeMobileResult(context, {
      report,
      receipt: {
        schemaVersion: 1,
        identity: mobileResultIdentity(context),
        report,
      },
      evidence: {
        schemaVersion: 1,
        scenarios: context.scenarioNames.map((name, index) => ({
          name,
          consoleInsights: { verified: true },
          bodyCompleted: true,
          cleanupCompleted: true,
          expectedLaunchFailures: index,
        })),
      },
      cleanupEvidence: {
        schemaVersion: 1,
        attempts: context.scenarioNames.map((name) => ({
          name,
          cleanupCompleted: true,
        })),
      },
      cleanupStatus: "passed",
      exitCode: 0,
    });
    expect(result.errors).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("fails a mismatched result as an SDK assertion", async () => {
    const { exitCode, report } = await runFixture(
      "fail",
      `${driverPreamble}
test("wrong result", async ({device, screen}) => {
  await driver(device, screen).assertText("wrong", "update-action-result", "no-update", {ensureForeground:false});
});
`,
    );
    expect(exitCode).toBe(1);
    expect(report.run.results[0].status).toBe("failed");
    expect(report.run.results[0].attempts[0].error.code).toBe(
      "ASSERTION_FAILED",
    );
  });
});
