import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MobileContext } from "./context.ts";
import { mobileResultIdentity } from "./result.ts";

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn(),
  releaseReverse: vi.fn(),
  startServer: vi.fn(),
  acquireReverse: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => `${"a".repeat(40)}\n`),
  spawn: mocked.spawn,
}));
vi.mock("../shared/scripts/control-server.ts", () => ({
  buildControlServerEnv: (_platform: string, env: NodeJS.ProcessEnv) => ({
    ...env,
    HOT_UPDATER_E2E_SERVER_HOST: "127.0.0.1",
    HOT_UPDATER_E2E_APP_ID: "org.example",
  }),
  startControlServer: mocked.startServer,
}));
vi.mock("./android-reverse.ts", () => ({
  acquireAndroidReverses: mocked.acquireReverse,
}));

import { runMobile } from "./run.ts";

function successfulReport(context: MobileContext) {
  return {
    schemaVersion: "report-1",
    run: {
      status: "passed",
      exitCode: 0,
      vcs: { commit: context.headSha },
      runner: { name: "e2e", version: "0.16.0" },
      targets: [
        {
          id: context.platform,
          platform: context.platform,
          engine: { name: "mobile", version: "0.9.1" },
        },
      ],
      serialGroups: [],
      results: context.scenarioNames.map((name) => ({
        kind: "test",
        titlePath: [name],
        targetId: context.platform,
        platform: context.platform,
        selected: true,
        status: "passed",
        repeat: 0,
        attempts: [
          {
            index: 0,
            status: "passed",
            durationMs: 20,
            cleanup: "complete",
            secondaryErrors: [],
            steps: [],
          },
        ],
      })),
      errors: [],
      summary: {
        discovered: context.scenarioNames.length,
        selected: context.scenarioNames.length,
        executed: context.scenarioNames.length,
        passed: context.scenarioNames.length,
        failed: 0,
        flaky: 0,
        skipped: 0,
      },
      usage: { modelTokens: 0, maxModelCallsInStep: 0 },
    },
  };
}

describe("mobile wrapper resource lifecycle", () => {
  let temporary: string;
  let internalDirectories: string[];
  let omitCleanupEvidence: boolean;
  let args: string[];
  let env: NodeJS.ProcessEnv;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-lifecycle-"));
    internalDirectories = [];
    omitCleanupEvidence = false;
    const appPath = path.join(temporary, "example.apk");
    await fs.writeFile(appPath, "fixture-only; never installed");
    args = [
      "--platform",
      "android",
      "--device",
      "fake-dedicated-device",
      "--run-id",
      "lifecycle-job",
      "--session",
      "lifecycle-session",
      "--profile",
      "isolated-fixture",
      "--scenario",
      "startup-hang-recovery",
      "--results-dir",
      path.join(temporary, "results"),
    ];
    env = {
      HOT_UPDATER_E2E_CONTROL_PORT: "39999",
      HOT_UPDATER_E2E_ANDROID_BINARY_PATH: appPath,
    };
    mocked.stop.mockResolvedValue(undefined);
    mocked.releaseReverse.mockResolvedValue(undefined);
    mocked.acquireReverse.mockResolvedValue(mocked.releaseReverse);
    mocked.startServer.mockResolvedValue({
      baseUrl: "http://owned-control.invalid",
      stop: mocked.stop,
    });
    fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocked.spawn.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
        queueMicrotask(() => {
          void (async () => {
            const contextPath = options.env.HOT_UPDATER_E2E_MOBILE_CONTEXT!;
            const context = JSON.parse(
              await fs.readFile(contextPath, "utf8"),
            ) as MobileContext;
            const internalDir = path.dirname(contextPath);
            internalDirectories.push(internalDir);
            const report = successfulReport(context);
            await fs.mkdir(path.join(internalDir, "runner"));
            await fs.writeFile(
              path.join(internalDir, "runner/report.json"),
              JSON.stringify(report),
            );
            await fs.writeFile(
              path.join(context.resultsDir, "sdk-report.json"),
              JSON.stringify({
                schemaVersion: 1,
                identity: mobileResultIdentity(context),
                report,
              }),
            );
            await fs.writeFile(
              path.join(context.resultsDir, "scenario-evidence.json"),
              JSON.stringify({
                schemaVersion: 1,
                scenarios: context.scenarioNames.map((name) => ({
                  name,
                  bodyCompleted: true,
                  cleanupCompleted: true,
                  expectedLaunchFailures: 0,
                  consoleInsights: { installId: "fixture-installation" },
                })),
              }),
            );
            if (!omitCleanupEvidence) {
              await fs.writeFile(
                path.join(context.resultsDir, "cleanup-evidence.json"),
                JSON.stringify({
                  schemaVersion: 1,
                  attempts: context.scenarioNames.map((name) => ({
                    name,
                    cleanupCompleted: true,
                  })),
                }),
              );
            }
            child.emit("exit", 0);
          })().catch((error) => child.emit("error", error));
        });
        return child;
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all([
      fs.rm(temporary, { recursive: true, force: true }),
      ...internalDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    ]);
  });

  it("records cancellation arriving during final control cleanup after SDK success", async () => {
    const listeners = process.listenerCount("SIGTERM");
    fetchMock.mockImplementation(async () => {
      process.emit("SIGTERM", "SIGTERM");
      return new Response("{}");
    });

    expect(await runMobile(args, env)).toBe(130);

    const result = JSON.parse(
      await fs.readFile(
        path.join(temporary, "results/hot-updater-result.json"),
        "utf8",
      ),
    );
    expect(result).toMatchObject({
      status: "cancelled",
      cleanupStatus: "passed",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://owned-control.invalid/e2e/cleanup",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocked.releaseReverse).toHaveBeenCalledExactlyOnceWith();
    expect(mocked.stop).toHaveBeenCalledExactlyOnceWith({ cleanup: false });
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });

  it.each(["quarantine.json", "runner-report.json", "hot-updater-result.json"])(
    "releases owned resources even when writing %s fails",
    async (artifact) => {
      omitCleanupEvidence = artifact === "quarantine.json";
      await fs.mkdir(path.join(temporary, "results", artifact), {
        recursive: true,
      });
      const listeners = process.listenerCount("SIGTERM");

      await expect(runMobile(args, env)).rejects.toMatchObject({
        code: "EISDIR",
      });

      expect(mocked.releaseReverse).toHaveBeenCalledExactlyOnceWith();
      expect(mocked.stop).toHaveBeenCalledExactlyOnceWith({ cleanup: false });
      expect(process.listenerCount("SIGTERM")).toBe(listeners);
      if (omitCleanupEvidence) expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
