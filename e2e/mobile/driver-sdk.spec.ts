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
import { resolveE2eCli } from "./run.ts";

const execFileAsync = promisify(execFile);

describe("mobile scenario driver in the installed SDK", () => {
  it("asserts through the SDK's matchers and accounts for verified launch disconnects", async () => {
    const root = process.cwd();
    const resultsRoot = path.join(root, "e2e/results");
    mkdirSync(resultsRoot, { recursive: true });
    const temporary = mkdtempSync(path.join(resultsRoot, "mobile-sdk-test-"));
    try {
      writeFileSync(
        path.join(temporary, "fixture.e2e.ts"),
        `
import { test as base, expect } from "e2e";
import { MobileAppDriver } from ${JSON.stringify(path.join(root, "e2e/mobile/driver.ts"))};
const test = base.extend<{ device: any }>();
const client = {postJson:async()=>({}),runJob:async()=>({}),waitForScreenStateField:async()=>({})};
const iosAlert = {get:async()=>null};
test("result text", async ({device, screen}) => {
  const app = new MobileAppDriver({
    appId:"org.example", platform:"ios", device, screen, client, iosAlert, signal:new AbortController().signal,
  });
  // toHaveText compares normalized text: the renderer's whitespace is not part of the result.
  await app.assertText("exact", "update-action-result", "current-channel -> installed ID r1", {exactText:true});
  await app.assertText("any of", "update-action-result", ["no-update", "installed ID r1"]);
  const wrong = await app.assertText("wrong", "update-action-result", "no-update", {ensureForeground:false})
    .then(() => "passed", (error) => error.code);
  expect(wrong).toBe("ASSERTION_FAILED");
});
test("verified expected launch disconnect", async ({device, screen}) => {
  const controls = [];
  const app = new MobileAppDriver({
    appId:"org.example", platform:"ios", device, screen, iosAlert, signal:new AbortController().signal,
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
      writeFileSync(
        path.join(temporary, "e2e.config.ts"),
        `
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
`,
      );
      await execFileAsync(
        process.execPath,
        [
          resolveE2eCli(),
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
      const assertions = report.run.results[0].attempts[0].steps.map(
        (step: { api: string; status: string }) => `${step.api}:${step.status}`,
      );
      expect(assertions).toContain("expect.toHaveText:passed");
      expect(assertions).toContain("expect.toContainText:passed");
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
        scenarioNames: ["verified expected launch disconnect"],
        controlBaseUrl: "http://127.0.0.1:1",
        testTimeoutMs: 30_000,
        cleanupTimeoutMs: 30_000,
      };
      const disconnect = {
        ...report,
        run: {
          ...report.run,
          results: [report.run.results[1]],
          summary: {
            ...report.run.summary,
            discovered: 1,
            selected: 1,
            executed: 1,
            passed: 1,
          },
        },
      };
      const result = normalizeMobileResult(context, {
        report: disconnect,
        receipt: {
          schemaVersion: 1,
          identity: mobileResultIdentity(context),
          report: disconnect,
        },
        evidence: {
          schemaVersion: 1,
          scenarios: [
            {
              name: "verified expected launch disconnect",
              consoleInsights: { verified: true },
              bodyCompleted: true,
              cleanupCompleted: true,
              expectedLaunchFailures: 1,
            },
          ],
        },
        cleanupEvidence: {
          schemaVersion: 1,
          attempts: [
            {
              name: "verified expected launch disconnect",
              cleanupCompleted: true,
            },
          ],
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
