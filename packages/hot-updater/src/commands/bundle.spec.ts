import type { Bundle } from "@hot-updater/plugin-core";
import { BLOB_DATABASE_SNAPSHOT_KEY } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockPrintBanner } = vi.hoisted(() => {
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
  return { mockCli, mockPrintBanner };
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

import { createDatabaseAdapterHarness } from "./databaseAdapter.testFixtures";

const databaseHarness = createDatabaseAdapterHarness();

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
  mockCli.loadConfig.mockResolvedValue({ database: databaseHarness.adapter });
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
    databaseHarness.reset();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a tabulated row per bundle from getBundles result data", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([
      buildBundle({ id: "B1" }),
      buildBundle({ id: "B2" }),
    ]);

    const { handleBundleList } = await import("./bundle");
    await handleBundleList({});

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
    const { handleBundleList } = await import("./bundle");
    await handleBundleList({});
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("(no bundles)"),
    );
  });

  it("prints raw paginated JSON and skips the banner when --json is passed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([buildBundle({ id: "B1" })]);

    const { handleBundleList } = await import("./bundle");
    await handleBundleList({ json: true });

    expect(mockPrintBanner).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"id": "B1"'));
  });

  it("forwards channel/platform/limit options to getBundles", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([
      buildBundle({ id: "B1", channel: "beta", platform: "android" }),
      buildBundle({ id: "B2", channel: "other", platform: "android" }),
    ]);
    const { handleBundleList } = await import("./bundle");
    await handleBundleList({ channel: "beta", platform: "android", limit: 5 });
    const output = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("B1");
    expect(output).not.toContain("B2");
  });

  it("calls onUnmount even when getBundles throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.loadObject.mockRejectedValueOnce(new Error("DB down"));
    const { handleBundleList } = await import("./bundle");
    await expect(handleBundleList({})).rejects.toThrow("DB down");
    expect(databaseHarness.onUnmount).toHaveBeenCalled();
  });
});

describe("handleBundleSetEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables an enabled bundle when -y is passed and verifies the result", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([buildBundle({ id: "B1", enabled: true })]);

    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", false, { yes: true });

    expect((await databaseHarness.bundles())[0]?.enabled).toBe(false);
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
    databaseHarness.setBundles([buildBundle({ id: "B1", enabled: false })]);
    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", true, { yes: true });
    expect((await databaseHarness.bundles())[0]?.enabled).toBe(true);
    expect(mockCli.p.log.success).toHaveBeenCalledWith("Enabled bundle.");
  });

  it("short-circuits with info log when bundle is already in target state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([buildBundle({ id: "B1", enabled: false })]);
    const { handleBundleSetEnabled } = await import("./bundle");
    await handleBundleSetEnabled("B1", false, { yes: true });
    expect(databaseHarness.uploadObject).not.toHaveBeenCalled();
    expect(mockCli.p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("already disable"),
    );
  });

  it("exits 1 when bundle id does not exist", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
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

    databaseHarness.setBundles([buildBundle({ id: "B1", enabled: true })]);
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

    databaseHarness.setBundles([buildBundle({ id: "B1", enabled: true })]);
    mockCli.p.confirm.mockResolvedValueOnce(false);

    const { exitSpy } = expectExit(2);
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(handleBundleSetEnabled("B1", false, {})).rejects.toThrow(
      "process.exit(2)",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(databaseHarness.uploadObject).not.toHaveBeenCalled();

    if (isTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTtyDescriptor);
    }
  });

  it("exits 1 when verification reads a state mismatch after commit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([buildBundle({ id: "B1", enabled: true })]);
    databaseHarness.compareAndSwapObject.mockResolvedValue(true);

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
    databaseHarness.loadObject.mockRejectedValueOnce(new Error("DB error"));
    const { handleBundleSetEnabled } = await import("./bundle");
    await expect(
      handleBundleSetEnabled("B1", false, { yes: true }),
    ).rejects.toThrow("DB error");
    expect(databaseHarness.onUnmount).toHaveBeenCalled();
  });
});

describe("handleBundleShow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints raw bundle JSON and skips the banner when --json is passed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bundle = buildBundle({ id: "B1" });
    databaseHarness.setBundles([bundle]);

    const { handleBundleShow } = await import("./bundle");
    await handleBundleShow("B1", { json: true });

    expect(mockPrintBanner).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"id": "B1"'));
  });
});

describe("handleBundleUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates rollout and target cohorts with -y and prints updated JSON", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    databaseHarness.setBundles([buildBundle({ id: "B1" })]);

    const { handleBundleUpdate } = await import("./bundle");
    await handleBundleUpdate("B1", {
      json: true,
      rolloutCohortCount: 500,
      targetCohorts: "qa",
      yes: true,
    });

    expect((await databaseHarness.bundles())[0]).toMatchObject({
      id: "B1",
      rolloutCohortCount: 500,
      targetCohorts: ["qa"],
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"rolloutCohortCount": 500'),
    );
  });

  it("exits 1 when no update fields are provided", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { exitSpy } = expectExit(1);
    const { handleBundleUpdate } = await import("./bundle");

    await expect(handleBundleUpdate("B1", { yes: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(databaseHarness.uploadObject).not.toHaveBeenCalled();
  });
});

describe("handleBundleDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    stubLoadedConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes an existing bundle record with -y and verifies it is gone", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bundle = buildBundle({ id: "B1" });
    databaseHarness.setBundles([bundle]);

    const { handleBundleDelete } = await import("./bundle");
    await handleBundleDelete(["B1"], { yes: true });

    expect(await databaseHarness.bundles()).toEqual([]);
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "Deleted bundle record.",
    );
  });

  it("waits for delete verification to become visible", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bundle = buildBundle({ id: "B1" });
    databaseHarness.setBundles([bundle]);
    databaseHarness.delayNextSnapshotVisibility(2);

    try {
      const { handleBundleDelete } = await import("./bundle");
      const deletePromise = handleBundleDelete(["B1"], { yes: true });
      await vi.advanceTimersByTimeAsync(1000);
      await deletePromise;

      expect(await databaseHarness.bundles()).toEqual([]);
      expect(mockCli.p.log.success).toHaveBeenCalledWith(
        "Deleted bundle record.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes multiple ids with a single commit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const b1 = buildBundle({ id: "B1" });
    const b2 = buildBundle({ id: "B2" });
    databaseHarness.setBundles([b1, b2]);

    const { handleBundleDelete } = await import("./bundle");
    await handleBundleDelete(["B1", "B2"], { yes: true });

    expect(await databaseHarness.bundles()).toEqual([]);
    expect(
      databaseHarness.compareAndSwapObject.mock.calls.filter(
        ([key]) => key === BLOB_DATABASE_SNAPSHOT_KEY,
      ),
    ).toHaveLength(1);
    expect(mockCli.p.log.success).toHaveBeenCalledWith(
      "Deleted 2 bundle records.",
    );
  });

  it("exits 1 when no ids are provided", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { exitSpy } = expectExit(1);
    const { handleBundleDelete } = await import("./bundle");
    await expect(handleBundleDelete([], {})).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockCli.loadConfig).not.toHaveBeenCalled();
  });
});
