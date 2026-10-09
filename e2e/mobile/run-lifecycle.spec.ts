import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordAttempt } from "./attempt.ts";
import { createNativeBuildPlan } from "./build.ts";
import type { MobileContext } from "./context.ts";
import { mobileResultIdentity } from "./result.ts";

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
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
vi.mock("./agent-device-daemon.ts", () => ({
  startOwnedAgentDeviceDaemon: mocked.startDaemon,
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
      runner: { name: "e2e", version: "0.18.0" },
      targets: [
        {
          id: context.platform,
          platform: context.platform,
          engine: { name: "mobile", version: "0.10.0" },
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
    mocked.stopDaemon.mockResolvedValue(undefined);
    mocked.startDaemon.mockImplementation(async (input: NodeJS.ProcessEnv) => ({
      stop: mocked.stopDaemon,
      env: {
        ...input,
        AGENT_DEVICE_DAEMON_BASE_URL: "http://owned-daemon.invalid",
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-private-token",
      },
    }));
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
            // Each attempt's teardown files its own record, as the workers do.
            if (!omitCleanupEvidence) {
              for (const name of context.scenarioNames)
                recordAttempt(context.resultsDir, name, {
                  schemaVersion: 1,
                  name,
                  cleanupCompleted: true,
                  consoleInsights: { installId: "fixture-installation" },
                  expectedLaunchFailures: 0,
                });
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

  it.each([
    ["default", undefined],
    ["empty", ""],
    ["relative", "../../../e2e/results/native-build-fixture"],
    ["absolute", "/isolated/native-build-fixture"],
  ])(
    "installs the iOS app produced by the native build with %s derived data",
    async (_label, derivedDataPath) => {
      args[args.indexOf("--platform") + 1] = "ios";
      args[args.indexOf("--device") + 1] =
        "12345678-1234-1234-1234-1234567890AB";
      env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH = derivedDataPath;
      const root = path.resolve(import.meta.dirname, "../..");
      const xcode = createNativeBuildPlan(
        { platform: "ios", dryRun: true },
        root,
        env,
      ).find((command) => command.command === "xcodebuild")!;
      const expectedApp = path.resolve(
        xcode.cwd,
        xcode.args[xcode.args.indexOf("-derivedDataPath") + 1]!,
        "Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
      );
      const access = fs.access.bind(fs);
      vi.spyOn(fs, "access").mockImplementation((file, mode) =>
        file === expectedApp ? Promise.resolve() : access(file, mode),
      );

      expect(await runMobile(args, env)).toBe(0);

      const contextPath =
        mocked.spawn.mock.calls[0]![2].env.HOT_UPDATER_E2E_MOBILE_CONTEXT;
      const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
      expect(context.appPath).toBe(expectedApp);
    },
  );

  it("prefers an explicit iOS binary over the derived-data output", async () => {
    args[args.indexOf("--platform") + 1] = "ios";
    args[args.indexOf("--device") + 1] = "12345678-1234-1234-1234-1234567890AB";
    env.HOT_UPDATER_E2E_IOS_BINARY_PATH =
      env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH;
    env.HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH = "other-build";

    expect(await runMobile(args, env)).toBe(0);

    const contextPath =
      mocked.spawn.mock.calls[0]![2].env.HOT_UPDATER_E2E_MOBILE_CONTEXT;
    const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
    expect(context.appPath).toBe(env.HOT_UPDATER_E2E_IOS_BINARY_PATH);
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
    expect(mocked.stopDaemon).toHaveBeenCalledExactlyOnceWith();
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

      expect(mocked.stopDaemon).toHaveBeenCalledExactlyOnceWith();
      expect(mocked.releaseReverse).toHaveBeenCalledExactlyOnceWith();
      expect(mocked.stop).toHaveBeenCalledExactlyOnceWith({ cleanup: false });
      expect(process.listenerCount("SIGTERM")).toBe(listeners);
      if (omitCleanupEvidence) expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("passes the owned remote transport to the SDK and stops it before publishing success", async () => {
    mocked.stopDaemon.mockImplementation(async () => {
      await expect(
        fs.access(path.join(temporary, "results/hot-updater-result.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(await runMobile(args, env)).toBe(0);
    expect(mocked.spawn.mock.calls[0]![2].env).toMatchObject({
      AGENT_DEVICE_DAEMON_BASE_URL: "http://owned-daemon.invalid",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-private-token",
    });
    expect(mocked.stopDaemon).toHaveBeenCalledExactlyOnceWith();
    const report = await fs.readFile(
      path.join(temporary, "results/hot-updater-result.json"),
      "utf8",
    );
    expect(report).not.toContain("fixture-private-token");
  });

  it("quarantines uncertain daemon shutdown while still releasing its other owned resources", async () => {
    mocked.stopDaemon.mockRejectedValue(
      new Error("Owned daemon cleanup is uncertain"),
    );
    expect(await runMobile(args, env)).toBe(1);
    const result = JSON.parse(
      await fs.readFile(
        path.join(temporary, "results/hot-updater-result.json"),
        "utf8",
      ),
    );
    expect(result).toMatchObject({ status: "failed", cleanupStatus: "failed" });
    const quarantine = JSON.parse(
      await fs.readFile(
        path.join(temporary, "results/quarantine.json"),
        "utf8",
      ),
    );
    expect(quarantine.quarantineRequired).toBe(true);
    expect(mocked.stopDaemon).toHaveBeenCalledExactlyOnceWith();
    expect(mocked.releaseReverse).toHaveBeenCalledExactlyOnceWith();
    expect(mocked.stop).toHaveBeenCalledExactlyOnceWith({ cleanup: false });
  });
});
