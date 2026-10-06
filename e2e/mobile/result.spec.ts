import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FinishedRun } from "e2e";
import { describe, expect, it } from "vitest";

import type { MobileContext } from "./context.ts";
import { createHotUpdaterReporter } from "./report.ts";
import {
  type MobileResultInput,
  mobileResultIdentity,
  normalizeMobileResult,
  writeMobileResult,
} from "./result.ts";

const context: MobileContext = {
  runtime: "react-native",
  platform: "ios",
  deviceId: "dedicated-simulator",
  session: "job-profile-ios",
  runId: "job-123",
  headSha: "a".repeat(40),
  profile: "dedicated-test-profile",
  resultsDir: "/unused/results",
  appPath: "/unused/example.app",
  appId: "example.app",
  scenarioNames: ["production-update", "crash-recovery"],
  controlBaseUrl: "http://127.0.0.1:3107",
  scenarioTimeoutMs: 100,
  setupTimeoutMs: 100,
  cleanupTimeoutMs: 100,
};

function reportFixture() {
  return {
    schemaVersion: "report-1",
    run: {
      status: "passed",
      exitCode: 0,
      vcs: { commit: context.headSha },
      runner: { name: "e2e", version: "0.16.0" },
      targets: [
        {
          id: "ios",
          platform: "ios",
          engine: { name: "mobile", version: "0.9.1" },
        },
      ],
      serialGroups: [],
      results: context.scenarioNames.map((name) => ({
        kind: "test",
        titlePath: [name],
        targetId: "ios",
        platform: "ios",
        selected: true,
        status: "passed",
        repeat: 0,
        attempts: [
          {
            index: 0,
            status: "passed",
            durationMs: 20,
            cleanup: "complete",
            secondaryErrors: [] as Record<string, unknown>[],
            steps: [] as Record<string, unknown>[],
          },
        ],
      })),
      errors: [] as Record<string, unknown>[],
      summary: {
        discovered: 2,
        selected: 2,
        executed: 2,
        passed: 2,
        failed: 0,
        flaky: 0,
        skipped: 0,
      },
      usage: { modelTokens: 0, maxModelCallsInStep: 0 },
    },
  };
}

function inputFixture(report = reportFixture()): MobileResultInput {
  return {
    report,
    receipt: {
      schemaVersion: 1,
      identity: mobileResultIdentity(context),
      report: structuredClone(report),
    },
    evidence: {
      schemaVersion: 1,
      scenarios: context.scenarioNames.map((name) => ({
        name,
        consoleInsights: {
          installId: "device-install-id",
          reportingInstallations: 1,
        },
        bodyCompleted: true,
        cleanupCompleted: true,
        expectedLaunchFailures: 0,
      })),
    },
    cleanupEvidence: {
      schemaVersion: 1,
      attempts: context.scenarioNames.map((name) => ({
        name,
        cleanupCompleted: true,
      })),
    },
    exitCode: 0,
    cleanupStatus: "passed",
  };
}

describe("mobile result contract", () => {
  it("passes only an exact selection with canonical and independent cleanup evidence", () => {
    const result = normalizeMobileResult(context, inputFixture());
    expect(result).toMatchObject({
      ...mobileResultIdentity(context),
      status: "passed",
      cleanupStatus: "passed",
      errors: [],
      runnerVersions: {
        e2e: "0.16.0",
        mobile: "0.9.1",
        agentDevice: "0.21.18",
      },
      scenarios: context.scenarioNames.map((name) => ({
        name,
        status: "passed",
        durationMs: 20,
      })),
    });
  });

  it.each<[string, (report: ReturnType<typeof reportFixture>) => void]>([
    [
      "zero results",
      (report) => {
        report.run.results = [];
      },
    ],
    [
      "missing scenario",
      (report) => {
        report.run.results.pop();
      },
    ],
    [
      "duplicate scenario",
      (report) => {
        report.run.results.push(report.run.results[0]!);
      },
    ],
    [
      "unknown scenario",
      (report) => {
        report.run.results[0]!.titlePath = ["other"];
      },
    ],
    [
      "skipped scenario",
      (report) => {
        report.run.results[0]!.status = "skipped";
      },
    ],
    [
      "unselected scenario",
      (report) => {
        report.run.results[0]!.selected = false;
      },
    ],
    [
      "repeated scenario",
      (report) => {
        report.run.results[0]!.repeat = 1;
      },
    ],
    [
      "retry",
      (report) => {
        report.run.results[0]!.attempts.push(
          report.run.results[0]!.attempts[0]!,
        );
      },
    ],
    [
      "wrong platform",
      (report) => {
        report.run.results[0]!.platform = "android";
      },
    ],
    [
      "wrong target",
      (report) => {
        report.run.targets[0]!.id = "another-device";
      },
    ],
    [
      "wrong revision",
      (report) => {
        report.run.vcs.commit = "b".repeat(40);
      },
    ],
    [
      "unknown SDK version",
      (report) => {
        report.run.runner.version = "0.17.0";
      },
    ],
    [
      "unknown mobile version",
      (report) => {
        report.run.targets[0]!.engine.version = "1.0.0";
      },
    ],
    [
      "inconsistent summary",
      (report) => {
        report.run.summary.passed = 1;
      },
    ],
    [
      "SDK run failure",
      (report) => {
        report.run.status = "failed";
      },
    ],
    [
      "SDK exit failure",
      (report) => {
        report.run.exitCode = 2;
      },
    ],
    [
      "model call",
      (report) => {
        report.run.usage.maxModelCallsInStep = 1;
      },
    ],
    [
      "hook error",
      (report) => {
        report.run.errors.push({
          phase: "afterAll",
          message: "restore failed",
        });
      },
    ],
    [
      "secondary attempt error",
      (report) => {
        report.run.results[0]!.attempts[0]!.secondaryErrors.push({
          message: "device close failed",
        });
      },
    ],
    [
      "invalid duration",
      (report) => {
        report.run.results[0]!.attempts[0]!.durationMs = -1;
      },
    ],
  ])("fails closed for %s even when the process exits zero", (_, mutate) => {
    const report = reportFixture();
    mutate(report);
    const result = normalizeMobileResult(context, inputFixture(report));
    expect(result.status).toBe("failed");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each(["runId", "headSha", "profile", "platform", "deviceId", "session"])(
    "rejects another job's %s in the reporter receipt",
    (key) => {
      const input = inputFixture();
      (input.receipt as { identity: Record<string, unknown> }).identity[key] =
        "other";
      expect(normalizeMobileResult(context, input)).toMatchObject({
        status: "failed",
        cleanupStatus: "unknown",
      });
    },
  );

  it("requires the reporter copy to agree with the canonical disk report", () => {
    const input = inputFixture();
    (input.report as ReturnType<typeof reportFixture>).run.results = [];
    const result = normalizeMobileResult(context, input);
    expect(result.errors).toContain(
      "SDK reporter receipt is missing or does not match this run",
    );
    expect(result.status).toBe("failed");
  });

  it.each([undefined, null, [], "invalid", {}])(
    "does not accept missing or malformed canonical reports: %j",
    (report) => {
      const input = { ...inputFixture(), report };
      expect(normalizeMobileResult(context, input)).toMatchObject({
        status: "failed",
        cleanupStatus: "unknown",
      });
    },
  );

  it.each(["receipt", "evidence", "cleanupEvidence"] as const)(
    "requires %s independently of SDK success",
    (key) => {
      const input = inputFixture();
      input[key] = undefined;
      expect(normalizeMobileResult(context, input).status).toBe("failed");
    },
  );

  it("quarantines a forced teardown even if scenario evidence claims success", () => {
    const report = reportFixture();
    report.run.results[0]!.attempts[0]!.cleanup = "forced";
    expect(normalizeMobileResult(context, inputFixture(report))).toMatchObject({
      status: "failed",
      cleanupStatus: "unknown",
    });
  });

  it("propagates an afterAll cleanup error after every scenario passes", () => {
    const report = reportFixture();
    report.run.errors.push({
      phase: "afterAll",
      message: "final cleanup failed",
    });
    expect(normalizeMobileResult(context, inputFixture(report))).toMatchObject({
      status: "failed",
      cleanupStatus: "failed",
    });
  });

  it("allows safe final cleanup after an assertion failure with proven drain and close", () => {
    const report = reportFixture();
    report.run.status = "failed";
    report.run.exitCode = 1;
    report.run.results[0]!.status = "failed";
    report.run.results[0]!.attempts[0]!.status = "failed";
    report.run.summary = { ...report.run.summary, passed: 1, failed: 1 };
    const input = inputFixture(report);
    input.exitCode = 1;
    (input.evidence as { scenarios: unknown[] }).scenarios.shift();
    expect(normalizeMobileResult(context, input)).toMatchObject({
      status: "failed",
      cleanupStatus: "passed",
    });
  });

  it("treats an attempt teardown error as unsafe even when engine disposal completed", () => {
    const report = reportFixture();
    report.run.results[0]!.attempts[0]!.secondaryErrors.push({
      phase: "afterEach",
      message: "control drain did not settle",
    });
    expect(normalizeMobileResult(context, inputFixture(report))).toMatchObject({
      status: "failed",
      cleanupStatus: "failed",
    });
  });

  it("accepts an expected launch disconnect after the scenario verifies recovery", () => {
    const report = reportFixture();
    report.run.results[1]!.attempts[0]!.steps.push({
      api: "device.openApp",
      status: "failed",
      label: "crashing-bundle",
      error: { message: "App disconnected" },
    });
    const input = inputFixture(report);
    (
      input.evidence as { scenarios: { expectedLaunchFailures: number }[] }
    ).scenarios[1]!.expectedLaunchFailures = 1;
    expect(normalizeMobileResult(context, input)).toMatchObject({
      status: "passed",
      cleanupStatus: "passed",
    });
  });

  it.each(["expect.toHaveText", "device.closeApp", "device.openApp"])(
    "rejects a caught %s failure without recovery evidence",
    (api) => {
      const report = reportFixture();
      report.run.results[1]!.attempts[0]!.steps.push({
        api,
        status: "failed",
        error: { message: "failed operation" },
      });
      expect(normalizeMobileResult(context, inputFixture(report)).status).toBe(
        "failed",
      );
    },
  );

  it("does not let a recovery receipt excuse a different failed operation", () => {
    const report = reportFixture();
    report.run.results[1]!.attempts[0]!.steps.push({
      api: "expect.toHaveText",
      status: "failed",
      error: { message: "UI assertion failed" },
    });
    const input = inputFixture(report);
    (
      input.evidence as { scenarios: { expectedLaunchFailures: number }[] }
    ).scenarios[1]!.expectedLaunchFailures = 1;
    expect(normalizeMobileResult(context, input).status).toBe("failed");
  });

  it("does not accept duplicate cleanup receipts or another scenario's proof", () => {
    const input = inputFixture();
    input.cleanupEvidence = {
      schemaVersion: 1,
      attempts: [
        { name: context.scenarioNames[0], cleanupCompleted: true },
        { name: context.scenarioNames[0], cleanupCompleted: true },
      ],
    };
    expect(normalizeMobileResult(context, input)).toMatchObject({
      status: "failed",
      cleanupStatus: "unknown",
    });
  });

  it("keeps cancellation and unknown remote mutation distinct from a passing run", () => {
    const input = inputFixture();
    input.cancelled = true;
    input.quarantine = {
      quarantineRequired: true,
      reason: "deploy may still be mutating",
    };
    expect(normalizeMobileResult(context, input)).toMatchObject({
      status: "cancelled",
      cleanupStatus: "unknown",
    });
  });

  it("includes final wrapper cleanup failures after the SDK reporter completes", () => {
    const input = inputFixture();
    input.cleanupStatus = "failed";
    input.errors = ["control server cleanup failed"];
    expect(normalizeMobileResult(context, input)).toMatchObject({
      status: "failed",
      cleanupStatus: "failed",
      errors: expect.arrayContaining(["control server cleanup failed"]),
    });
  });

  it("writes an identity-bound reporter receipt and the final normalized artifact", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mobile-result-"));
    const localContext = {
      ...context,
      resultsDir: path.join(temporary, "result"),
    };
    try {
      const reporter = createHotUpdaterReporter(localContext);
      await expect(stat(localContext.resultsDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await reporter.onRunFinished!(
        { report: reportFixture() } as unknown as FinishedRun,
        new AbortController().signal,
      );
      const receipt = JSON.parse(
        await readFile(
          path.join(localContext.resultsDir, "sdk-report.json"),
          "utf8",
        ),
      );
      const result = normalizeMobileResult(localContext, {
        ...inputFixture(),
        receipt,
      });
      expect(result.status).toBe("passed");
      await writeMobileResult(localContext, result);
      expect(
        JSON.parse(
          await readFile(
            path.join(localContext.resultsDir, "hot-updater-result.json"),
            "utf8",
          ),
        ),
      ).toEqual(result);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
