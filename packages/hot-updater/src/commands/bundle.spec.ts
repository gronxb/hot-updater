import type {
  Bundle,
  CursorPage,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginRuntime,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockDatabasePlugin, mockPrintBanner } = vi.hoisted(() => {
  type LegacyBundlePage = {
    readonly data: readonly Bundle[];
    readonly pagination?: Partial<CursorPage<Bundle>["pagination"]>;
  };
  type LegacyGetBundles = (
    options: Parameters<DatabasePluginRuntime["bundles"]["list"]>[0],
  ) => Promise<LegacyBundlePage>;
  const createPage = <TData>(
    data: readonly TData[] = [],
    pagination: Partial<CursorPage<TData>["pagination"]> = {},
  ): CursorPage<TData> => ({
    data,
    pagination: {
      currentPage: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      nextCursor: null,
      previousCursor: null,
      total: data.length,
      totalPages: data.length === 0 ? 0 : 1,
      ...pagination,
    },
  });
  const toRecord = (bundle: Bundle): DatabaseBundleRecord => {
    const {
      patches: _patches,
      patchBaseBundleId: _patchBaseBundleId,
      patchBaseFileHash: _patchBaseFileHash,
      patchFileHash: _patchFileHash,
      patchStorageUri: _patchStorageUri,
      ...record
    } = bundle;
    return record;
  };
  const mockDatabasePlugin = {
    appendBundle: vi.fn<(bundle: Bundle) => Promise<void>>(),
    commitBundle: vi.fn<() => Promise<void>>(),
    deleteBundle: vi.fn<(bundle: { readonly id: string }) => Promise<void>>(),
    getBundleById: vi.fn<(bundleId: string) => Promise<Bundle | null>>(),
    getBundles: vi.fn<LegacyGetBundles>(),
    getChannels: vi.fn<() => Promise<string[]>>(),
    name: "mock-database",
    onUnmount: vi.fn<() => Promise<void>>(),
    updateBundle:
      vi.fn<(bundleId: string, patch: Partial<Bundle>) => Promise<void>>(),
    bundles: {
      getById: vi.fn<DatabasePluginRuntime["bundles"]["getById"]>(),
      list: vi.fn<DatabasePluginRuntime["bundles"]["list"]>(),
      update: vi.fn<DatabasePluginRuntime["bundles"]["update"]>(),
      delete: vi.fn<DatabasePluginRuntime["bundles"]["delete"]>(),
      insert: vi.fn<DatabasePluginRuntime["bundles"]["insert"]>(),
    },
    bundlePatches: {
      getById: vi.fn<DatabasePluginRuntime["bundlePatches"]["getById"]>(),
      list: vi.fn<DatabasePluginRuntime["bundlePatches"]["list"]>(),
      insert: vi.fn<DatabasePluginRuntime["bundlePatches"]["insert"]>(),
      update: vi.fn<DatabasePluginRuntime["bundlePatches"]["update"]>(),
      delete: vi.fn<DatabasePluginRuntime["bundlePatches"]["delete"]>(),
    },
    commit: vi.fn<DatabasePluginRuntime["commit"]>(),
    close: vi.fn<NonNullable<DatabasePluginRuntime["close"]>>(),
  };
  mockDatabasePlugin.bundles.getById.mockImplementation(
    async ({ bundleId }) => {
      const bundle = await mockDatabasePlugin.getBundleById(bundleId);
      return bundle ? toRecord(bundle) : null;
    },
  );
  mockDatabasePlugin.bundles.list.mockImplementation(async (options) => {
    const result = await mockDatabasePlugin.getBundles(options);
    return createPage(result.data.map(toRecord), result.pagination);
  });
  mockDatabasePlugin.bundles.update.mockImplementation(
    async ({ bundleId, patch }) => {
      await mockDatabasePlugin.updateBundle(bundleId, patch);
    },
  );
  mockDatabasePlugin.bundles.delete.mockImplementation(async ({ bundleId }) => {
    await mockDatabasePlugin.deleteBundle({ id: bundleId });
  });
  mockDatabasePlugin.bundles.insert.mockImplementation(async ({ bundle }) => {
    await mockDatabasePlugin.appendBundle(bundle as Bundle);
  });
  mockDatabasePlugin.bundlePatches.list.mockResolvedValue(
    createPage<DatabaseBundlePatch>(),
  );
  mockDatabasePlugin.commit.mockImplementation(async () => {
    await mockDatabasePlugin.commitBundle();
  });
  mockDatabasePlugin.close.mockImplementation(async () => {
    await mockDatabasePlugin.onUnmount();
  });
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

const resetDatabaseMocks = () => {
  mockDatabasePlugin.appendBundle.mockReset();
  mockDatabasePlugin.commitBundle.mockReset();
  mockDatabasePlugin.deleteBundle.mockReset();
  mockDatabasePlugin.getBundleById.mockReset();
  mockDatabasePlugin.getBundles.mockReset();
  mockDatabasePlugin.getChannels.mockReset();
  mockDatabasePlugin.onUnmount.mockReset();
  mockDatabasePlugin.updateBundle.mockReset();
};

describe("handleBundleList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseMocks();
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
      orderBy: { direction: "desc", field: "id" },
    });
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("B1");
    expect(output).toContain("B2");
    expect(output).toContain("┌");
    expect(output).toContain("│ ID");
    expect(output).toContain("Channel");
    expect(output).toContain("Platform");
  });

  it("prints empty-state marker when no bundles exist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundles.mockResolvedValue({
      data: [],
      pagination: { total: 0 },
    });
    const { handleBundleList } = await import("./bundle");
    await handleBundleList({});
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("(no bundles)"),
    );
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
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject(result.data.at(0)!);
    expect(payload.data[0].patches).toEqual([]);
    expect(payload.pagination).toMatchObject({ total: 1 });
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
      orderBy: { direction: "desc", field: "id" },
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
    resetDatabaseMocks();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables an enabled bundle when -y is passed and verifies the result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: false }));

    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", false, { yes: true });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith(
      "B1",
      expect.objectContaining({ enabled: false }),
    );
    expect(mockDatabasePlugin.commitBundle).toHaveBeenCalled();
    expect(mockCli.p.log.message).toHaveBeenCalledWith(
      expect.stringContaining("Status:"),
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith("Disabled bundle.");
    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("B1"),
    );
  });

  it("enables a disabled bundle when -y is passed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: false }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: false }))
      .mockResolvedValueOnce(buildBundle({ id: "B1", enabled: true }));
    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", true, { yes: true });
    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith(
      "B1",
      expect.objectContaining({ enabled: true }),
    );
    expect(mockCli.p.log.success).toHaveBeenCalledWith("Enabled bundle.");
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

describe("handleBundleShow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseMocks();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints raw bundle JSON and skips the banner when --json is passed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bundle = buildBundle({ id: "B1" });
    mockDatabasePlugin.getBundleById.mockResolvedValueOnce(bundle);

    const { handleBundleShow } = await import("./bundle");
    await handleBundleShow("B1", { json: true });

    expect(mockPrintBanner).not.toHaveBeenCalled();
    expect(mockDatabasePlugin.getBundleById).toHaveBeenCalledWith("B1");
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject(bundle);
    expect(payload.patches).toEqual([]);
  });
});

describe("handleBundleUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseMocks();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates rollout and target cohorts with -y and prints updated JSON", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const updated = buildBundle({
      id: "B1",
      rolloutCohortCount: 500,
      targetCohorts: ["qa"],
    });
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(buildBundle({ id: "B1" }))
      .mockResolvedValueOnce(buildBundle({ id: "B1" }))
      .mockResolvedValueOnce(updated);

    const { handleBundleUpdate } = await import("./bundle");
    await handleBundleUpdate("B1", {
      json: true,
      rolloutCohortCount: 500,
      targetCohorts: "qa",
      yes: true,
    });

    expect(mockDatabasePlugin.updateBundle).toHaveBeenCalledWith(
      "B1",
      expect.objectContaining({
        rolloutCohortCount: 500,
        targetCohorts: ["qa"],
      }),
    );
    expect(mockDatabasePlugin.commitBundle).toHaveBeenCalled();
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject(updated);
    expect(payload.patches).toEqual([]);
  });

  it("exits 1 when no update fields are provided", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { exitSpy } = expectExit(1);
    const { handleBundleUpdate } = await import("./bundle");

    await expect(handleBundleUpdate("B1", { yes: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDatabasePlugin.updateBundle).not.toHaveBeenCalled();
  });
});

describe("handleBundleDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDatabaseMocks();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes an existing bundle record with -y and verifies it is gone", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bundle = buildBundle({ id: "B1" });
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(bundle)
      .mockResolvedValueOnce(null);

    const { handleBundleDelete } = await import("./bundle");
    await handleBundleDelete("B1", { yes: true });

    expect(mockDatabasePlugin.deleteBundle).toHaveBeenCalledWith({ id: "B1" });
    expect(mockDatabasePlugin.commitBundle).toHaveBeenCalled();
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "Deleted bundle record.",
    );
  });

  it("waits for delete verification to become visible", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bundle = buildBundle({ id: "B1" });
    mockDatabasePlugin.getBundleById
      .mockResolvedValueOnce(bundle)
      .mockResolvedValueOnce(bundle)
      .mockResolvedValueOnce(null);

    try {
      const { handleBundleDelete } = await import("./bundle");
      const deletePromise = handleBundleDelete("B1", { yes: true });
      await vi.advanceTimersByTimeAsync(1000);
      await deletePromise;

      expect(mockDatabasePlugin.deleteBundle).toHaveBeenCalledWith({
        id: "B1",
      });
      expect(mockDatabasePlugin.commitBundle).toHaveBeenCalled();
      expect(mockCli.p.log.success).toHaveBeenCalledWith(
        "Deleted bundle record.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
