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

import { describe, expect, it } from "vitest";

import { mobileResultIdentity, normalizeMobileResult } from "./result.ts";

const execFileAsync = promisify(execFile);

describe("mobile scenario engine", () => {
  it("preserves raw text through the installed SDK's public locator pipeline", async () => {
    const root = process.cwd();
    const resultsRoot = path.join(root, "e2e/results");
    mkdirSync(resultsRoot, { recursive: true });
    const temporary = mkdtempSync(
      path.join(resultsRoot, "mobile-engine-test-"),
    );
    try {
      writeFileSync(
        path.join(temporary, "fixture.e2e.ts"),
        `
import { test as base, expect } from "e2e";
import { MobileAppDriver } from ${JSON.stringify(path.join(root, "e2e/mobile/driver.ts"))};
const test = base.extend<{ hotUpdaterAttemptSignal: { signal: AbortSignal }, device: any }>();
test("raw mobile result", async ({screen, hotUpdaterAttemptSignal}) => {
  const locator = screen.getByTestId("result");
  expect(await locator.textContent()).toBe("installed ID r1");
  expect(await locator.getAttribute("hot-updater-raw-text")).toBe("installed  ID r1\\n");
  expect(hotUpdaterAttemptSignal.signal.aborted).toBe(false);
});
test("verified expected launch disconnect", async ({device, screen, hotUpdaterAttemptSignal}) => {
  const controls = [];
  const app = new MobileAppDriver({
    appId:"org.example", platform:"ios", device, screen, signal:hotUpdaterAttemptSignal.signal,
    iosAlert:{get:async()=>null},
    client:{postJson:async(_stage,path)=>{controls.push(path);return {verified:true};},runJob:async()=>({}),waitForScreenStateField:async()=>({})},
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
      writeFileSync(
        path.join(temporary, "e2e.config.ts"),
        `
import { defineEngine } from "e2e/engine";
import { scenarioEngine } from ${JSON.stringify(path.join(root, "e2e/mobile/engine.ts"))};
export default {
  tests: ["fixture.e2e.ts"],
  output: "output",
  workers: 1, retries: 0, trace: "off", cache: "off",
  targets: [{name: "ios", engine: scenarioEngine(defineEngine({
    name: "mobile", version: "0.10.0", spiVersion: 1, platform: "ios",
    fixtures:{device:(context)=>context.fixture("device", {
      openApp:async()=>{throw new Error("expected process disconnect");},
      closeApp:async()=>{throw new Error("SDK close cannot select a device after its session ended");},openLink:async()=>{},
    }, {openApp:{kind:"resource",label:(app)=>app},closeApp:{kind:"resource"},openLink:{kind:"resource"}})},
    observe: async () => ({root:{ref:{id:"root",revision:""},children:[]},viewport:{width:100,height:100}}),
    locate: async () => [{ref:{id:"result",revision:""},role:"text",testId:"result",text:"installed  ID r1\\n"}],
  }))}],
};
`,
      );
      await execFileAsync(
        process.execPath,
        [
          path.join(root, "node_modules/e2e/dist/cli/bin.js"),
          "run",
          "--config",
          path.join(temporary, "e2e.config.ts"),
        ],
        {
          cwd: root,
          env: { ...process.env, E2E_TELEMETRY_DISABLED: "1" },
          timeout: 30_000,
        },
      ).catch((error) => {
        throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`);
      });
      const report = JSON.parse(
        readFileSync(path.join(temporary, "output/report.json"), "utf8"),
      );
      expect(report.run.results).toHaveLength(2);
      expect(report.run.results[0].status).toBe("passed");
      const failedSteps = report.run.results[1].attempts[0].steps.filter(
        (step: { status: string }) => step.status === "failed",
      );
      expect(failedSteps).toHaveLength(1);
      expect(failedSteps[0].api).toBe("device.openApp");
      expect(report.run.results[1].status).toBe("passed");
      const context = {
        runId: "fixture",
        headSha: report.run.vcs.commit,
        profile: "fixture",
        platform: "ios" as const,
        deviceId: "fixture-device",
        session: "fixture-session",
        resultsDir: temporary,
        appPath: "fixture.app",
        appId: "org.example",
        scenarioNames: [
          "raw mobile result",
          "verified expected launch disconnect",
        ],
        controlBaseUrl: "http://127.0.0.1:1",
        scenarioTimeoutMs: 30_000,
        setupTimeoutMs: 30_000,
        cleanupTimeoutMs: 30_000,
      };
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
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
