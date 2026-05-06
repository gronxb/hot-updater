import type { Bundle, Platform } from "@hot-updater/plugin-core";
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
  message: "msg",
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

const setupConsoleSpies = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
};

const stubGetBundlesByPlatform = (
  byPlatform: Partial<Record<Platform, Bundle[]>>,
) => {
  mockDatabasePlugin.getBundles.mockImplementation((options) => {
    const platform = options.where?.platform as Platform | undefined;
    const bundles = (platform && byPlatform[platform]) ?? [];
    return Promise.resolve({
      data: bundles.slice(0, options.limit ?? bundles.length),
      pagination: { total: bundles.length },
    });
  });
};

describe("handleRollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubLoadedConfig();
    setupConsoleSpies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls back both platforms when each has >=2 enabled bundles", async () => {
    stubGetBundlesByPlatform({
      ios: [
        buildBundle({ id: "ios-2", platform: "ios" }),
        buildBundle({ id: "ios-1", platform: "ios" }),
      ],
      android: [
        buildBundle({ id: "and-2", platform: "android" }),
        buildBundle({ id: "and-1", platform: "android" }),
      ],
    });
    mockDatabasePlugin.getBundleById.mockImplementation((id: string) =>
      Promise.resolve(buildBundle({ id, enabled: false })),
    );

    const { handleRollback } = await import("./rollback");
    await handleRollback("dev", { yes: true });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("ios-2", {
      enabled: false,
    });
    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("and-2", {
      enabled: false,
    });
    expect(mockDatabasePlugin.commitBundle).toHaveBeenCalledTimes(1);
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("ios-2"),
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("and-2"),
    );
  });

  it("only mutates the specified platform when -p is passed", async () => {
    stubGetBundlesByPlatform({
      ios: [
        buildBundle({ id: "ios-2", platform: "ios" }),
        buildBundle({ id: "ios-1", platform: "ios" }),
      ],
    });
    mockDatabasePlugin.getBundleById.mockImplementation((id: string) =>
      Promise.resolve(buildBundle({ id, enabled: false })),
    );

    const { handleRollback } = await import("./rollback");
    await handleRollback("dev", { platform: "ios", yes: true });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("ios-2", {
      enabled: false,
    });
    expect(mockDatabasePlugin.updateBundle).not.toHaveBeenCalledWith(
      expect.stringMatching(/^and-/),
      expect.anything(),
    );
  });

  it("rolls back to binary-shipped JS when a platform has one enabled bundle", async () => {
    stubGetBundlesByPlatform({
      ios: [buildBundle({ id: "ios-1", platform: "ios" })],
      android: [
        buildBundle({ id: "and-2", platform: "android" }),
        buildBundle({ id: "and-1", platform: "android" }),
      ],
    });
    mockDatabasePlugin.getBundleById.mockImplementation((id: string) =>
      Promise.resolve(buildBundle({ id, enabled: false })),
    );

    const { handleRollback } = await import("./rollback");
    await handleRollback("dev", { yes: true });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("ios-1", {
      enabled: false,
    });
    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("and-2", {
      enabled: false,
    });
    expect(mockCli.p.log.message).toHaveBeenCalledWith(
      expect.stringContaining("would revert to binary-shipped JS"),
    );
  });

  it("rolls back a specified platform to binary-shipped JS", async () => {
    stubGetBundlesByPlatform({
      ios: [buildBundle({ id: "ios-1", platform: "ios" })],
    });
    mockDatabasePlugin.getBundleById.mockResolvedValue(
      buildBundle({ id: "ios-1", enabled: false }),
    );
    const { handleRollback } = await import("./rollback");
    await handleRollback("dev", {
      platform: "ios",
      yes: true,
    });
    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("ios-1", {
      enabled: false,
    });
    expect(mockCli.p.log.success).toHaveBeenCalled();
  });

  it("skips a platform with no enabled bundle and proceeds on the rest", async () => {
    stubGetBundlesByPlatform({
      ios: [
        buildBundle({ id: "ios-2", platform: "ios" }),
        buildBundle({ id: "ios-1", platform: "ios" }),
      ],
      android: [],
    });
    mockDatabasePlugin.getBundleById.mockResolvedValue(
      buildBundle({ id: "ios-2", enabled: false }),
    );
    const { handleRollback } = await import("./rollback");
    await handleRollback("dev", { yes: true });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledTimes(1);
    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith("ios-2", {
      enabled: false,
    });
    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("No enabled bundle on dev/android"),
    );
  });

  it("exits 1 when no platform has any enabled bundle on the channel", async () => {
    stubGetBundlesByPlatform({ ios: [], android: [] });
    const { exitSpy } = expectExit(1);
    const { handleRollback } = await import("./rollback");
    await expect(handleRollback("dev", { yes: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCli.p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to roll back"),
    );
  });

  it("aborts with exit code 2 when interactive confirmation declines", async () => {
    stubGetBundlesByPlatform({
      ios: [
        buildBundle({ id: "ios-2", platform: "ios" }),
        buildBundle({ id: "ios-1", platform: "ios" }),
      ],
      android: [
        buildBundle({ id: "and-2", platform: "android" }),
        buildBundle({ id: "and-1", platform: "android" }),
      ],
    });
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    mockCli.p.confirm.mockResolvedValueOnce(false);
    const { exitSpy } = expectExit(2);
    const { handleRollback } = await import("./rollback");
    await expect(handleRollback("dev", {})).rejects.toThrow("process.exit(2)");
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockDatabasePlugin.updateBundle).not.toHaveBeenCalled();
    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("refuses to mutate without -y in a non-TTY shell", async () => {
    stubGetBundlesByPlatform({
      ios: [
        buildBundle({ id: "ios-2", platform: "ios" }),
        buildBundle({ id: "ios-1", platform: "ios" }),
      ],
      android: [
        buildBundle({ id: "and-2", platform: "android" }),
        buildBundle({ id: "and-1", platform: "android" }),
      ],
    });
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    const { exitSpy } = expectExit(1);
    const { handleRollback } = await import("./rollback");
    await expect(handleRollback("dev", {})).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDatabasePlugin.updateBundle).not.toHaveBeenCalled();
    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("verify phase: exits 1 when a target is still enabled after commit", async () => {
    stubGetBundlesByPlatform({
      ios: [
        buildBundle({ id: "ios-2", platform: "ios" }),
        buildBundle({ id: "ios-1", platform: "ios" }),
      ],
      android: [
        buildBundle({ id: "and-2", platform: "android" }),
        buildBundle({ id: "and-1", platform: "android" }),
      ],
    });
    // ios commit "succeeds" (returns disabled), android commit appears to
    // have not taken effect (still enabled).
    mockDatabasePlugin.getBundleById.mockImplementation((id: string) => {
      if (id === "ios-2")
        return Promise.resolve(buildBundle({ id, enabled: false }));
      if (id === "and-2")
        return Promise.resolve(buildBundle({ id, enabled: true }));
      return Promise.resolve(null);
    });
    const { exitSpy } = expectExit(1);
    const { handleRollback } = await import("./rollback");
    await expect(handleRollback("dev", { yes: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCli.p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("FAILED: android and-2 is still enabled"),
    );
  });

  it("calls onUnmount even when getBundles throws", async () => {
    mockDatabasePlugin.getBundles.mockRejectedValue(new Error("DB down"));
    const { handleRollback } = await import("./rollback");
    await expect(handleRollback("dev", { yes: true })).rejects.toThrow(
      "DB down",
    );
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalled();
  });
});
