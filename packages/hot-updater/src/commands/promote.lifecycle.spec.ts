import type {
  Bundle,
  NodeStoragePlugin,
  StorageOperationContext,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCli,
  mockDisposeStorage,
  mockStorage,
  mockStoragePlugin,
  mockPromoteBundle,
} = vi.hoisted(() => {
  const mockStoragePlugin = {
    name: "mock-storage",
    supportedProtocol: "s3",
    profiles: {
      node: {
        delete: vi.fn(),
        downloadFile: vi.fn(),
        exists: vi.fn(async () => false),
        upload: vi.fn(),
      },
    },
  };
  return {
    mockCli: {
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
    },
    mockDisposeStorage: vi.fn(),
    mockStorage: vi.fn(),
    mockStoragePlugin,
    mockPromoteBundle: vi.fn(),
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
  printBanner: vi.fn(),
}));

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";

const databaseHarness = createDatabasePluginHarness();
const bundle: Bundle = {
  id: "promote-lifecycle-source",
  channel: "internal",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "source-hash",
  storageUri: "s3://bucket/source.zip",
  gitCommitHash: "source-commit",
  message: null,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

describe("handlePromote storage lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    databaseHarness.reset();
    databaseHarness.setBundles([bundle]);
    mockDisposeStorage.mockResolvedValue(undefined);
    mockStorage.mockResolvedValue(mockStoragePlugin);
    mockPromoteBundle.mockResolvedValue({ ...bundle, channel: "beta" });
    mockCli.loadConfig.mockResolvedValue({
      database: databaseHarness.plugin,
      disposeStorage: mockDisposeStorage,
      storage: mockStorage,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("binds every borrowed-facade operation to one frozen Node context", async () => {
    let commandContext: StorageOperationContext | undefined;
    const operationContexts: StorageOperationContext[] = [];
    let boundStoragePlugin: NodeStoragePlugin = mockStoragePlugin;
    mockStorage.mockImplementationOnce((context: StorageOperationContext) => {
      commandContext = context;
      boundStoragePlugin = {
        name: "bound-storage",
        supportedProtocol: "s3",
        profiles: {
          node: {
            delete: vi.fn(async () => {
              operationContexts.push(context);
            }),
            downloadFile: vi.fn(async () => {
              operationContexts.push(context);
            }),
            exists: vi.fn(async () => {
              operationContexts.push(context);
              return false;
            }),
            upload: vi.fn(async () => {
              operationContexts.push(context);
              return { storageUri: "s3://bucket/copied.zip" };
            }),
          },
        },
      };
      return Promise.resolve(boundStoragePlugin);
    });
    mockPromoteBundle.mockImplementationOnce(async (_input, dependencies) => {
      const storage = dependencies.storagePlugin;
      expect(storage).toBe(boundStoragePlugin);
      if (storage === null) {
        throw new Error("Copy lifecycle requires bound storage.");
      }
      await storage.profiles.node.downloadFile(bundle.storageUri, "/tmp/copy");
      await storage.profiles.node.exists(bundle.storageUri);
      await storage.profiles.node.upload(bundle.id, "/tmp/copy");
      await storage.profiles.node.delete(bundle.storageUri);
      return { ...bundle, channel: "beta" };
    });

    const { handlePromote } = await import("./promote");
    await handlePromote(bundle.id, {
      target: "beta",
      action: "copy",
      yes: true,
    });

    expect(mockStorage).toHaveBeenCalledTimes(1);
    expect(commandContext).toEqual({
      target: "node",
      environment: expect.any(Object),
      bindings: {},
    });
    expect(Object.isFrozen(commandContext)).toBe(true);
    expect(Object.isFrozen(commandContext?.environment)).toBe(true);
    expect(Object.isFrozen(commandContext?.bindings)).toBe(true);
    expect(
      Object.values(commandContext?.environment ?? {}).every(
        (value) => typeof value === "string",
      ),
    ).toBe(true);
    expect(operationContexts).toHaveLength(4);
    for (const operationContext of operationContexts) {
      expect(operationContext).toBe(commandContext);
    }
    expect(mockDisposeStorage).toHaveBeenCalledTimes(1);
    expect(mockDisposeStorage.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockPromoteBundle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    ["missing", new Error("storage is missing")],
    [
      "unsupported",
      {
        name: "worker-only",
        profiles: {},
        supportedProtocol: "worker",
      },
    ],
  ])(
    "keeps %s storage optional for move and closes its owner",
    async (_case, value) => {
      if (value instanceof Error) {
        mockStorage.mockRejectedValueOnce(value);
      } else {
        mockStorage.mockResolvedValueOnce(value);
      }
      mockPromoteBundle.mockImplementationOnce((_input, dependencies) => {
        expect(dependencies.storagePlugin).toBeNull();
        return Promise.resolve({ ...bundle, channel: "beta" });
      });

      const { handlePromote } = await import("./promote");
      await handlePromote(bundle.id, {
        target: "beta",
        action: "move",
        yes: true,
      });

      expect(mockDisposeStorage).toHaveBeenCalledTimes(1);
      expect(databaseHarness.onUnmount).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves promotion failure identity when both cleanups fail", async () => {
    const promotionError = new Error("promotion failed");
    mockPromoteBundle.mockRejectedValueOnce(promotionError);
    mockDisposeStorage.mockRejectedValueOnce(new Error("storage close failed"));
    databaseHarness.onUnmount.mockRejectedValueOnce(
      new Error("database close failed"),
    );

    const { handlePromote } = await import("./promote");
    await expect(
      handlePromote(bundle.id, { target: "beta", yes: true }),
    ).rejects.toBe(promotionError);

    expect(mockCli.p.log.warn).toHaveBeenCalledTimes(2);
  });

  it("uses the first cleanup failure and still closes the database", async () => {
    const storageCleanupError = new Error("storage close failed");
    mockDisposeStorage.mockRejectedValueOnce(storageCleanupError);
    databaseHarness.onUnmount.mockRejectedValueOnce(
      new Error("database close failed"),
    );

    const { handlePromote } = await import("./promote");
    await expect(
      handlePromote(bundle.id, { target: "beta", yes: true }),
    ).rejects.toBe(storageCleanupError);

    expect(mockDisposeStorage.mock.invocationCallOrder[0]).toBeLessThan(
      databaseHarness.onUnmount.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockCli.p.log.warn).toHaveBeenCalledTimes(1);
  });
});
