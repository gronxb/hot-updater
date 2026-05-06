import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockDatabasePlugin, mockPrintBanner } = vi.hoisted(() => {
  const mockDatabasePlugin = {
    appendBundle: vi.fn(),
    commitBundle: vi.fn(),
    deleteBundle: vi.fn(),
    getBundleById: vi.fn(),
    getBundles: vi.fn(),
    getChannels: vi.fn(),
    name: "mock-database",
    onUnmount: vi.fn(),
    updateBundle: vi.fn(),
  };
  const mockCli = {
    loadConfig: vi.fn(),
    p: {
      confirm: vi.fn(),
      isCancel: vi.fn(() => false),
      log: {
        error: vi.fn(),
        info: vi.fn(),
        message: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
    },
  };
  const mockPrintBanner = vi.fn();
  return { mockCli, mockDatabasePlugin, mockPrintBanner };
});

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
  };
});

vi.mock("@/utils/printBanner", () => ({
  printBanner: mockPrintBanner,
}));

const buildBundle = (overrides: Partial<Bundle> = {}): Bundle => ({
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "dev",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeefcafe",
  message: "Initial bundle",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
  ...overrides,
});

const stubLoadedConfig = () => {
  mockCli.loadConfig.mockResolvedValue({
    database: vi.fn().mockResolvedValue(mockDatabasePlugin),
  } as never);
};

const expectExit = (code: number) => {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((c) => {
    throw new Error(`process.exit(${c})`);
  });
  return { exitSpy, code };
};

describe("handleBundleList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a tabulated row per bundle from getBundles result data", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [buildBundle({ id: "B1" }), buildBundle({ id: "B2" })],
      pagination: { total: 2 },
    });

    const { handleBundleList } = await import("./bundle");
    await handleBundleList({});

    expect(mockDatabasePlugin.getBundles).toHaveBeenCalledWith({
      where: { channel: undefined, platform: undefined },
      limit: 20,
    });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("B1");
    expect(output).toContain("B2");
    expect(output).toMatch(/^id\s+channel\s+platform/);
  });

  it("prints empty-state marker when no bundles exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [],
      pagination: { total: 0 },
    });
    const { handleBundleList } = await import("./bundle");
    await handleBundleList({});
    expect(logSpy).toHaveBeenCalledWith("(no bundles)");
  });

  it("prints raw paginated JSON and skips the banner when --json is passed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = {
      data: [buildBundle({ id: "B1" })],
      pagination: { total: 1 },
    };
    mockDatabasePlugin.getBundles.mockResolvedValue(result);

    const { handleBundleList } = await import("./bundle");
    await handleBundleList({ json: true });

    expect(mockPrintBanner).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
  });

  it("forwards channel/platform/limit options to getBundles", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [],
      pagination: { total: 0 },
    });
    const { handleBundleList } = await import("./bundle");
    await handleBundleList({ channel: "beta", platform: "android", limit: 5 });
    expect(mockDatabasePlugin.getBundles).toHaveBeenCalledWith({
      where: { channel: "beta", platform: "android" },
      limit: 5,
    });
  });

  it("calls onUnmount even when getBundles throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundles.mockRejectedValue(new Error("DB down"));
    const { handleBundleList } = await import("./bundle");
    await expect(handleBundleList({})).rejects.toThrow("DB down");
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalled();
  });
});

describe("handleBundleSetEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables an enabled bundle when -y is passed and verifies the result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: false }));

    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", false, { yes: true });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("B1", {
      enabled: false,
    });
    expect(mockDatabasePlugin.commitBundle).toHaveBeenCalled();
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("disabled B1"),
    );
  });

  it("enables a disabled bundle when -y is passed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: false }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }));
    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", true, { yes: true });
    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("B1", {
      enabled: true,
    });
  });

  it("short-circuits with info log when bundle is already in target state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById.mockResolvedValueOnce(
      buildBundle({ id: "B1", enabled: false }),
    );
    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", false, { yes: true });
    expect(mockDatabasePlugin.updateBundle).not.toHaveBeenCalled();
    expect(mockDatabasePlugin.commitBundle).not.toHaveBeenCalled();
    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("already disable"),
    );
  });

  it("exits 1 when bundle id does not exist", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById.mockResolvedValueOnce(null);
    const { exitSpy } = expectExit(1);
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(
      handleBundleSetEnabled("missing", true, { yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("refuses to mutate without -y in a non-TTY shell", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });

    mockDatabasePlugin.getBundleById.mockResolvedValueOnce(
      buildBundle({ id: "B1", enabled: true }),
    );
    const { exitSpy } = expectExit(1);
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(handleBundleSetEnabled("B1", false, {})).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("aborts with exit code 2 when interactive confirmation declines", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    mockDatabasePlugin.getBundleById.mockResolvedValueOnce(
      buildBundle({ id: "B1", enabled: true }),
    );
    mockCli.p.confirm.mockResolvedValueOnce(false);

    const { exitSpy } = expectExit(2);
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(handleBundleSetEnabled("B1", false, {})).rejects.toThrow(
      "process.exit(2)",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockDatabasePlugin.updateBundle).not.toHaveBeenCalled();

    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("exits 1 when verification reads a state mismatch after commit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }));

    const { exitSpy } = expectExit(1);
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(
      handleBundleSetEnabled("B1", false, { yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCli.p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Verification failed"),
    );
  });

  it("calls onUnmount even when getBundleById throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById.mockRejectedValue(new Error("DB error"));
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(
      handleBundleSetEnabled("B1", false, { yes: true }),
    ).rejects.toThrow("DB error");
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalled();
  });
});
