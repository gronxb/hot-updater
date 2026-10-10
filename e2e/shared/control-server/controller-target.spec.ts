import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lynxE2eRuntimeId } from "../../lynx/embedded-bundle.ts";

const jobs = vi.hoisted(() => ({
  start: vi.fn(() => "bootstrap-job"),
  get: vi.fn(() => ({ status: "running" })),
}));

// Import the production controller without loading a provider or executing a job.
vi.mock("../published.ts", () => ({
  importPublished: async () => ({}),
  publishedBin: () => "/unused/hot-updater",
}));
vi.mock("./control-jobs.ts", () => ({ createControlJobs: () => jobs }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("control-server target ownership", () => {
  it.each(["ios", "android"] as const)(
    "preserves the %s incompatible runtime vector only for the requested deploy",
    async (platform) => {
      vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", platform);
      vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.lynxexample");
      vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "leased-device");
      vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", "/unused/results");
      vi.stubEnv("HOT_UPDATER_E2E_BUILD_MODE", undefined);
      vi.stubEnv("HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE", undefined);
      vi.stubEnv(
        "HOT_UPDATER_E2E_APP_BASE_URL",
        "http://127.0.0.1:3009/hot-updater",
      );
      const { getHotUpdaterControlEnv } = await import("./controller.ts");
      const runtimeId = `${lynxE2eRuntimeId(platform)}-cross-provenance-rejected`;
      const childEnv = getHotUpdaterControlEnv({
        NODE_ENV: "development",
        BABEL_ENV: "development",
        HOT_UPDATER_CONTROL_BASE_URL: "http://wrong-target.invalid",
        HOT_UPDATER_E2E_BUILD_MODE: "cross-provenance",
        HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE: runtimeId,
      });

      const received = execFileSync(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({ mode: process.env.HOT_UPDATER_E2E_BUILD_MODE, runtimeId: process.env.HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE }))",
        ],
        { env: { ...process.env, ...childEnv }, encoding: "utf8" },
      );
      expect(JSON.parse(received)).toEqual({
        mode: "cross-provenance",
        runtimeId,
      });
      expect(childEnv).toMatchObject({
        NODE_ENV: "production",
        BABEL_ENV: "production",
        HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3009/hot-updater",
      });
      const ordinaryEnv = getHotUpdaterControlEnv();
      expect(ordinaryEnv.HOT_UPDATER_E2E_BUILD_MODE).toBeUndefined();
      expect(ordinaryEnv.HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE).toBeUndefined();
      expect(process.env.HOT_UPDATER_E2E_BUILD_MODE).toBeUndefined();
      expect(process.env.HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE).toBeUndefined();
    },
  );

  it("builds OTA artifacts for the production React runtime despite inherited development settings", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BABEL_ENV", "development");
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "app.example");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "leased-device");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", "/unused/results");
    vi.stubEnv(
      "HOT_UPDATER_E2E_APP_BASE_URL",
      "http://127.0.0.1:3009/hot-updater",
    );
    const { getHotUpdaterControlEnv } = await import("./controller.ts");

    const childEnv = { ...process.env, ...getHotUpdaterControlEnv() };

    expect(childEnv).toMatchObject({
      NODE_ENV: "production",
      BABEL_ENV: "production",
      HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3009/hot-updater",
    });
    expect(process.env.NODE_ENV).toBe("development");
    expect(process.env.BABEL_ENV).toBe("development");
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("rejects another device before bootstrap and after the configured target owns a job", async () => {
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "app.example");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "leased-device");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", "/unused/results");
    const { startBootstrapJob } = await import("./controller.ts");

    expect(() => startBootstrapJob({ deviceId: "another-device" })).toThrow(
      "Bootstrap device must match the configured target",
    );
    expect(jobs.start).not.toHaveBeenCalled();
    expect(startBootstrapJob({ deviceId: "leased-device" })).toBe(
      "bootstrap-job",
    );
    expect(() => startBootstrapJob({ deviceId: "another-device" })).toThrow(
      "Bootstrap device must match the configured target",
    );
    expect(startBootstrapJob({ deviceId: "leased-device" })).toBe(
      "bootstrap-job",
    );
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });
});
