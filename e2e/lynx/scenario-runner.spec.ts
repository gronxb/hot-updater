import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runScenarioBatch } from "./scenario-runner";

describe("Lynx E2E scenario runner", () => {
  it("runs every scenario once in order with isolated servers and results", async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const starts: Array<{ resultsDir: string; scenario: string }> = [];
    let currentScenario = "";
    const stop = new Map<string, ReturnType<typeof vi.fn>>();
    const failures = new Set(["first", "third"]);

    const status = await runScenarioBatch(
      {
        env: {
          CONTROL_URL: "http://stale-control.test",
          FIXTURE: "preserved",
          HOT_UPDATER_E2E_CONTROL_BASE_URL: "http://stale-base.test",
        },
        platform: "android",
        resultsRoot: "/repo/e2e/results/detox",
        scenarios: ["first", "second", "third"],
      },
      {
        error: (message) => errors.push(message),
        executeScenario: async ({ env, scenarioName }) => {
          events.push(`execute:${scenarioName}`);
          expect(currentScenario).toBe(scenarioName);
          expect(env.FIXTURE).toBe("preserved");
          expect(env.HOT_UPDATER_E2E_SCENARIO_NAME).toBe(scenarioName);
          expect(env.HOT_UPDATER_E2E_RESULTS_DIR).toBe(
            path.join("/repo/e2e/results/detox", "android", scenarioName),
          );
          if (failures.has(scenarioName)) {
            throw new Error(`${scenarioName} failed`);
          }
        },
        log: (message) => logs.push(message),
        startControlServer: async (_platform, env) => {
          expect(env.CONTROL_URL).toBeUndefined();
          expect(env.HOT_UPDATER_E2E_CONTROL_BASE_URL).toBeUndefined();
          const resultsDir = env.HOT_UPDATER_E2E_RESULTS_DIR;
          expect(resultsDir).toBeTypeOf("string");
          const scenario = path.basename(resultsDir!);
          expect(env.HOT_UPDATER_E2E_SCENARIO_NAME).toBe(scenario);
          currentScenario = scenario;
          starts.push({ resultsDir: resultsDir!, scenario });
          events.push(`start:${scenario}`);
          const stopServer = vi.fn(async () => {
            events.push(`stop:${scenario}`);
          });
          stop.set(scenario, stopServer);
          return {
            baseUrl: `http://${scenario}.test`,
            stop: stopServer,
          };
        },
      },
    );

    expect(status).toBe(1);
    expect(starts).toEqual([
      {
        resultsDir: "/repo/e2e/results/detox/android/first",
        scenario: "first",
      },
      {
        resultsDir: "/repo/e2e/results/detox/android/second",
        scenario: "second",
      },
      {
        resultsDir: "/repo/e2e/results/detox/android/third",
        scenario: "third",
      },
    ]);
    expect(events).toEqual([
      "start:first",
      "execute:first",
      "stop:first",
      "start:second",
      "execute:second",
      "stop:second",
      "start:third",
      "execute:third",
      "stop:third",
    ]);
    expect([...stop.values()]).toHaveLength(3);
    for (const stopServer of stop.values()) {
      expect(stopServer).toHaveBeenCalledOnce();
    }
    expect(logs).toEqual([
      "Start android/first",
      "Start android/second",
      "Scenario passed: android/second",
      "Start android/third",
    ]);
    expect(errors).toEqual([
      "Scenario failed: android/first",
      "first failed",
      "Scenario failed: android/third",
      "third failed",
    ]);
  });

  it("stops the batch when failed scenario cleanup also fails", async () => {
    const events: string[] = [];
    const executeScenario = vi.fn(async ({ scenarioName }) => {
      events.push(`execute:${scenarioName}`);
      throw new Error("scenario failed");
    });
    const startControlServer = vi.fn(async () => ({
      baseUrl: "http://control.test",
      stop: async () => {
        events.push("stop:first");
        throw new Error("cleanup failed");
      },
    }));

    await expect(
      runScenarioBatch(
        {
          env: {},
          platform: "ios",
          resultsRoot: "/repo/e2e/results/detox",
          scenarios: ["first", "second"],
        },
        {
          error: vi.fn(),
          executeScenario,
          log: vi.fn(),
          startControlServer,
        },
      ),
    ).rejects.toThrow("cleanup failed");
    expect(events).toEqual(["execute:first", "stop:first"]);
    expect(executeScenario).toHaveBeenCalledOnce();
    expect(startControlServer).toHaveBeenCalledOnce();
  });
});
