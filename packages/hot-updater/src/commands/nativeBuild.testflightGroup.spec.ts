import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyStoreTestFlightGroup,
  getNativeBuild,
  loadConfig,
  loadServer,
  log,
} = vi.hoisted(() => ({
  applyStoreTestFlightGroup: vi.fn(),
  getNativeBuild: vi.fn(),
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
  log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: { log },
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/native/storeStatus", () => ({ applyStoreTestFlightGroup }));

import { handleNativeBuildTestFlightGroup } from "./nativeBuild";

const failing = async (run: () => Promise<unknown>) => {
  const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  await expect(run()).rejects.toThrow("exit 1");
  exit.mockRestore();
};

const applied = (group: string) => ({
  destination: "testflight",
  url: "https://asc.test",
  version: "1.7.0 (66)",
  state: "ready",
  expiresAtMs: null,
  reusable: true,
  group,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  loadConfig.mockResolvedValue({
    nativeBuild: {
      ios: {
        sandbox: { bundleIdentifier: "com.example.app", sandbox: true },
        release: { bundleIdentifier: "com.example.app" },
      },
    },
  });
  loadServer.mockResolvedValue({
    core: { getNativeBuild },
    dispose: vi.fn(async () => {}),
  });
  getNativeBuild.mockResolvedValue({
    id: "build-1",
    submitted_to: "testflight",
    submitted_version: "1.7.0 (66)",
  });
  applyStoreTestFlightGroup.mockResolvedValue(applied("added"));
});

describe("native-build testflight-group", () => {
  it("applies the group to the tracked build and prints the store's word", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleNativeBuildTestFlightGroup("build-1", "QA", {
      scheme: "sandbox",
      json: true,
    });
    expect(JSON.parse(String(print.mock.calls.at(-1)?.[0]))).toEqual(
      applied("added"),
    );
    print.mockRestore();
    expect(applyStoreTestFlightGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scheme: "sandbox", group: "QA" }),
    );
  });

  it("refuses a normal scheme, reading nothing", async () => {
    await failing(() =>
      handleNativeBuildTestFlightGroup("build-1", "QA", { scheme: "release" }),
    );
    expect(log.error).toHaveBeenCalledWith(
      "testflight-group takes a sandbox scheme, and release isn't one.\nSet sandbox: true on it, or add the build to QA in TestFlight.",
    );
    expect(getNativeBuild).not.toHaveBeenCalled();
    expect(applyStoreTestFlightGroup).not.toHaveBeenCalled();
  });

  it("refuses a build that isn't on TestFlight, asking the store nothing", async () => {
    getNativeBuild.mockResolvedValue({ id: "build-1", submitted_to: null });
    await failing(() =>
      handleNativeBuildTestFlightGroup("build-1", "QA", { scheme: "sandbox" }),
    );
    expect(log.error).toHaveBeenCalledWith(
      "Native build build-1 isn't on TestFlight.\nUpload one: npx hot-updater native-build ios --scheme sandbox --submit testflight",
    );
    expect(applyStoreTestFlightGroup).not.toHaveBeenCalled();
  });

  it("fails on a group the store refuses", async () => {
    applyStoreTestFlightGroup.mockRejectedValue(
      new Error("TestFlight group QA is external"),
    );
    await failing(() =>
      handleNativeBuildTestFlightGroup("build-1", "QA", { scheme: "sandbox" }),
    );
    expect(log.error).toHaveBeenCalledWith("TestFlight group QA is external");
  });

  it.each([
    ["added", "success", 0],
    ["takes-every-build", "success", 0],
    ["pending", "warn", 1],
    ["not-offered", "warn", 1],
  ] as const)(
    "at a terminal, says %s and exits as it should",
    async (group, level, code) => {
      applyStoreTestFlightGroup.mockResolvedValue(applied(group));
      await handleNativeBuildTestFlightGroup("build-1", "QA", {
        scheme: "sandbox",
      });
      expect(log[level]).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(code);
    },
  );
});
