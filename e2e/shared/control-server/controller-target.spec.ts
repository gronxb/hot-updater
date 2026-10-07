import { afterEach, describe, expect, it, vi } from "vitest";

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
