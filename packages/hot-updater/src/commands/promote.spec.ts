import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCli,
  mockDatabasePlugin,
  mockStoragePlugin,
  mockPrintBanner,
  mockPromoteBundle,
} = vi.hoisted(() => {
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
  const mockStoragePlugin = {
    name: "mock-storage",
    supportedProtocol: "s3",
    profiles: {
      node: {
        delete: vi.fn(),
        downloadFile: vi.fn(),
        upload: vi.fn(),
      },
    },
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
  const mockPromoteBundle = vi.fn();
  return {
    mockCli,
    mockDatabasePlugin,
    mockStoragePlugin,
    mockPrintBanner,
    mockPromoteBundle,
  };
});

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    loadConfig: mockCli.loadConfig,
    p: mockCli.p,
    promoteBundle: mockPromoteBundle,
  };
});

vi.mock("@/utils/printBanner", () => ({
  printBanner: mockPrintBanner,
}));

const buildBundle = (overrides: Partial<Bundle> = {}): Bundle => ({
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "internal",
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
    storage: vi.fn().mockResolvedValue(mockStoragePlugin),
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

describe("handlePromote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubLoadedConfig();
    setupConsoleSpies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the named bundle to the target channel", async () => {
    const bundle = buildBundle({ id: "src-1", channel: "internal" });
    const promoted = buildBundle({ id: "new-1", channel: "beta" });
    mockDatabasePlugin.getBundleById.mockResolvedValue(bundle);
    mockPromoteBundle.mockResolvedValue(promoted);

    const { handlePromote } = await import("./promote");
    await handlePromote("src-1", {
      target: "beta",
      action: "copy",
      yes: true,
    });

    expect(mockDatabasePlugin.getBundleById).toHaveBeenCalledWith("src-1");
    expect(mockPromoteBundle).toHaveBeenCalledWith(
      {
        action: "copy",
        bundleId: "src-1",
        targetChannel: "beta",
      },
      expect.objectContaining({
        databasePlugin: mockDatabasePlugin,
        storagePlugin: mockStoragePlugin,
      }),
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Copied bundle to beta"),
    );
  });

  it("moves the named bundle to the target channel", async () => {
    const bundle = buildBundle({ id: "src-1", channel: "internal" });
    mockDatabasePlugin.getBundleById.mockResolvedValue(bundle);
    mockPromoteBundle.mockResolvedValue({ ...bundle, channel: "beta" });

    const { handlePromote } = await import("./promote");
    await handlePromote("src-1", {
      target: "beta",
      action: "move",
      yes: true,
    });

    expect(mockPromoteBundle).toHaveBeenCalledWith(
      expect.objectContaining({ action: "move", bundleId: "src-1" }),
      expect.anything(),
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Moved bundle to beta"),
    );
  });

  it("defaults --action to copy when omitted", async () => {
    const bundle = buildBundle({ id: "src-1" });
    mockDatabasePlugin.getBundleById.mockResolvedValue(bundle);
    mockPromoteBundle.mockResolvedValue({
      ...bundle,
      id: "new-1",
      channel: "beta",
    });

    const { handlePromote } = await import("./promote");
    await handlePromote("src-1", { target: "beta", yes: true });

    expect(mockPromoteBundle).toHaveBeenCalledWith(
      expect.objectContaining({ action: "copy" }),
      expect.anything(),
    );
  });

  it("rejects when the bundle's channel equals --target", async () => {
    mockDatabasePlugin.getBundleById.mockResolvedValue(
      buildBundle({ id: "src-1", channel: "beta" }),
    );
    const { exitSpy } = expectExit(1);
    const { handlePromote } = await import("./promote");
    await expect(
      handlePromote("src-1", { target: "beta", yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockPromoteBundle).not.toHaveBeenCalled();
    expect(mockCli.p.log.error).toHaveBeenCalledWith(
      expect.stringContaining('already on channel "beta"'),
    );
  });

  it("exits 1 when the bundle id does not exist", async () => {
    mockDatabasePlugin.getBundleById.mockResolvedValue(null);
    const { exitSpy } = expectExit(1);
    const { handlePromote } = await import("./promote");
    await expect(
      handlePromote("missing", { target: "beta", yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockPromoteBundle).not.toHaveBeenCalled();
  });

  it("exits 1 when --target is empty/whitespace", async () => {
    const { exitSpy } = expectExit(1);
    const { handlePromote } = await import("./promote");
    await expect(
      handlePromote("src-1", { target: "  ", yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDatabasePlugin.getBundleById).not.toHaveBeenCalled();
    expect(mockPromoteBundle).not.toHaveBeenCalled();
  });

  it("aborts with exit code 2 when interactive confirmation declines", async () => {
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    mockDatabasePlugin.getBundleById.mockResolvedValue(
      buildBundle({ id: "src-1" }),
    );
    mockCli.p.confirm.mockResolvedValueOnce(false);

    const { exitSpy } = expectExit(2);
    const { handlePromote } = await import("./promote");
    await expect(handlePromote("src-1", { target: "beta" })).rejects.toThrow(
      "process.exit(2)",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockPromoteBundle).not.toHaveBeenCalled();

    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("refuses to mutate without -y in a non-TTY shell", async () => {
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    mockDatabasePlugin.getBundleById.mockResolvedValue(
      buildBundle({ id: "src-1" }),
    );

    const { exitSpy } = expectExit(1);
    const { handlePromote } = await import("./promote");
    await expect(handlePromote("src-1", { target: "beta" })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("propagates promoteBundle errors and calls onUnmount", async () => {
    mockDatabasePlugin.getBundleById.mockResolvedValue(
      buildBundle({ id: "src-1" }),
    );
    mockPromoteBundle.mockRejectedValue(new Error("storage plugin failed"));

    const { handlePromote } = await import("./promote");
    await expect(
      handlePromote("src-1", { target: "beta", yes: true }),
    ).rejects.toThrow("storage plugin failed");
    expect(mockDatabasePlugin.onUnmount).toHaveBeenCalled();
  });
});
