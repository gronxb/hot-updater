// @vitest-environment node

import type {
  Bundle,
  DatabasePlugin,
  TelemetryLifecycleMetrics,
  NodeStoragePlugin,
  RuntimeStorageProfile,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...original,
    loadConfig: loadConfigMock,
  };
});

const baseBundle: Bundle = {
  id: "bundle-001",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  storageUri: "huc://project-001/bundles/bundle.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

function createDatabasePlugin(
  name: string,
  bundles: readonly Bundle[],
): DatabasePlugin {
  return {
    name,
    commit: vi.fn(),
    bundles: {
      get: vi.fn(async (_context, { id }) => {
        return bundles.find((bundle) => bundle.id === id) ?? null;
      }),
      list: vi.fn(async () => ({
        data: [...bundles],
        pagination: {
          currentPage: 1,
          hasNextPage: false,
          hasPreviousPage: false,
          total: bundles.length,
          totalPages: 1,
        },
      })),
      update: vi.fn(),
      append: vi.fn(),
    },
    channels: {
      getChannels: vi.fn(async () => ["production"]),
    },
  };
}

function createStoragePlugin(
  getDownloadUrl: RuntimeStorageProfile["getDownloadUrl"],
): NodeStoragePlugin {
  return {
    name: "hostedStorage",
    supportedProtocol: "huc",
    profiles: {
      node: {
        upload: vi.fn(),
        exists: vi.fn(async () => true),
        delete: vi.fn(),
        downloadFile: vi.fn(),
      },
      runtime: {
        getDownloadUrl,
        readText: vi.fn(async () => null),
      },
    },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  loadConfigMock.mockReset();
});

describe("console api operations", () => {
  it("uses hosted context for each operation invocation", async () => {
    const firstDatabase = createDatabasePlugin("first-db", [baseBundle]);
    const secondBundle = {
      ...baseBundle,
      id: "bundle-002",
      channel: "staging",
    };
    const secondDatabase = createDatabasePlugin("second-db", [secondBundle]);
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const { getBundlesOperation } = await import("./api-operations.server");

    const firstResult = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => firstDatabase,
        storage: () => storagePlugin,
      },
      () => getBundlesOperation(),
    );
    const secondResult = await runWithHostedConsoleContext(
      {
        project: { id: "project-002", workspaceId: "workspace-001" },
        database: () => secondDatabase,
        storage: () => storagePlugin,
      },
      () => getBundlesOperation(),
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(firstDatabase.bundles.list).toHaveBeenCalledOnce();
    expect(secondDatabase.bundles.list).toHaveBeenCalledOnce();
    expect(firstResult.data).toEqual([baseBundle]);
    expect(secondResult.data).toEqual([secondBundle]);
  });

  it("reports telemetry capability from optional database methods", async () => {
    const unsupportedDatabase = createDatabasePlugin("unsupported-db", []);
    const supportedDatabase = {
      ...createDatabasePlugin("supported-db", []),
      analytics: {
        getTelemetryKeyCredential: vi.fn(async () => ({
          active: true,
          keyHash: "hash",
          telemetryKeySuffix: "abcd1234",
        })),
        insertLifecycleEvent: vi.fn(
          async () =>
            ({
              accepted: true,
              deduped: false,
            }) as const,
        ),
        setTelemetryKeyActive: vi.fn(async () => {}),
        upsertTelemetryKeyCredential: vi.fn(async () => {}),
      },
    } satisfies DatabasePlugin;
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const { getConfigOperation } = await import("./api-operations.server");

    const unsupportedConfig = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => unsupportedDatabase,
        storage: () => storagePlugin,
      },
      () => getConfigOperation(),
    );
    const supportedConfig = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => supportedDatabase,
        storage: () => storagePlugin,
      },
      () => getConfigOperation(),
    );

    expect(unsupportedConfig.capabilities.telemetry).toBe(false);
    expect(unsupportedConfig.capabilities.telemetryKey).toBe(false);
    expect(supportedConfig.capabilities.telemetry).toBe(true);
    expect(supportedConfig.capabilities.telemetryKey).toBe(true);
  });

  it("does not report telemetry key capability for runtime-only telemetry", async () => {
    const runtimeOnlyDatabase = {
      ...createDatabasePlugin("runtime-only-db", []),
      analytics: {
        getTelemetryKeyCredential: vi.fn(async () => ({
          active: true,
          keyHash: "hash",
          telemetryKeySuffix: "abcd1234",
        })),
        insertLifecycleEvent: vi.fn(
          async () =>
            ({
              accepted: true,
              deduped: false,
            }) as const,
        ),
      },
    } satisfies DatabasePlugin;
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const { getConfigOperation, issueTelemetryKeyOperation } =
      await import("./api-operations.server");

    const result = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => runtimeOnlyDatabase,
        storage: () => storagePlugin,
      },
      async () => ({
        config: await getConfigOperation(),
        issue: issueTelemetryKeyOperation(),
      }),
    );

    expect(result.config.capabilities.telemetry).toBe(true);
    expect(result.config.capabilities.telemetryKey).toBe(false);
    await expect(result.issue).rejects.toThrow(
      "Telemetry key is not supported by this provider.",
    );
  });

  it("uses provider telemetry key operations", async () => {
    const databasePlugin = {
      ...createDatabasePlugin("telemetry-db", []),
      analytics: {
        getTelemetryKeyCredential: vi.fn(async () => ({
          active: true,
          keyHash: "hash",
          telemetryKeySuffix: "abcd1234",
        })),
        setTelemetryKeyActive: vi.fn(async () => {}),
        upsertTelemetryKeyCredential: vi.fn(async () => {}),
      },
    } satisfies DatabasePlugin;
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const {
      getTelemetryKeyStateOperation,
      issueTelemetryKeyOperation,
      rotateTelemetryKeyOperation,
    } = await import("./api-operations.server");

    const result = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => databasePlugin,
        storage: () => storagePlugin,
      },
      async () => ({
        state: await getTelemetryKeyStateOperation(),
        issued: await issueTelemetryKeyOperation(),
        rotated: await rotateTelemetryKeyOperation(),
      }),
    );

    expect(result.state).toEqual({
      active: true,
      telemetryKeySuffix: "abcd1234",
    });
    expect(result.issued.telemetryKey).toMatch(/^hutk_/);
    expect(result.issued.telemetryKeySuffix).toHaveLength(8);
    expect(result.rotated.telemetryKey).toMatch(/^hutk_/);
    expect(result.rotated.telemetryKeySuffix).toHaveLength(8);
    expect(
      databasePlugin.analytics.getTelemetryKeyCredential,
    ).toHaveBeenCalledOnce();
    expect(
      databasePlugin.analytics.upsertTelemetryKeyCredential,
    ).toHaveBeenCalledTimes(2);
  });

  it("enables and disables provider ingest keys", async () => {
    const setTelemetryKeyActive = vi.fn(async () => {});
    const databasePlugin = {
      ...createDatabasePlugin("ingest-key-db", []),
      analytics: {
        getTelemetryKeyCredential: vi.fn(async () => ({
          active: true,
          keyHash: "hash",
          telemetryKeySuffix: "abcd1234",
        })),
        setTelemetryKeyActive,
        upsertTelemetryKeyCredential: vi.fn(async () => {}),
      },
    } satisfies DatabasePlugin & {
      readonly analytics: NonNullable<DatabasePlugin["analytics"]> & {
        readonly setTelemetryKeyActive: (active: boolean) => Promise<void>;
      };
    };
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const apiOperations =
      (await import("./api-operations.server")) as typeof import("./api-operations.server") & {
        readonly setTelemetryKeyActiveOperation: (input: {
          readonly active: boolean;
        }) => Promise<{ readonly active: boolean }>;
      };

    const result = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => databasePlugin,
        storage: () => storagePlugin,
      },
      async () => ({
        disabled: await apiOperations.setTelemetryKeyActiveOperation({
          active: false,
        }),
        enabled: await apiOperations.setTelemetryKeyActiveOperation({
          active: true,
        }),
      }),
    );

    expect(result).toEqual({
      disabled: { active: false },
      enabled: { active: true },
    });
    expect(setTelemetryKeyActive).toHaveBeenNthCalledWith(1, false, undefined);
    expect(setTelemetryKeyActive).toHaveBeenNthCalledWith(2, true, undefined);
  });

  it("returns event-sourced bundle metrics from the database analytics runtime", async () => {
    const lifecycleMetrics = {
      bundles: [
        {
          active: 7,
          bundleId: baseBundle.id,
          channel: "production",
          lastSeenAt: "2026-06-28T12:00:00.000Z",
          platform: "ios",
          recovered: 2,
        },
      ],
      series: [
        {
          active: 7,
          bucketStart: "2026-06-28T12:00:00.000Z",
          bundleId: baseBundle.id,
          recovered: 2,
        },
        {
          active: 4,
          bucketStart: "2026-06-28T13:00:00.000Z",
          bundleId: "other-bundle",
          recovered: 0,
        },
      ],
      totals: { active: 7, recovered: 2 },
    } satisfies TelemetryLifecycleMetrics;
    const databasePlugin = {
      ...createDatabasePlugin("metrics-db", [baseBundle]),
      analytics: {
        getLifecycleMetrics: vi.fn(async () => lifecycleMetrics),
      },
    } satisfies DatabasePlugin;
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const apiOperations =
      (await import("./api-operations.server")) as typeof import("./api-operations.server") & {
        readonly getBundleMetricsOperation: (input: {
          readonly bundleId: string;
        }) => Promise<unknown>;
      };

    const result = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => databasePlugin,
        storage: () => storagePlugin,
      },
      () =>
        apiOperations.getBundleMetricsOperation({ bundleId: baseBundle.id }),
    );

    expect(result).toEqual({
      active: 7,
      lastSeenAt: "2026-06-28T12:00:00.000Z",
      recovered: 2,
      series: [
        {
          active: 7,
          bucketStart: "2026-06-28T12:00:00.000Z",
          recovered: 2,
        },
      ],
    });
  });

  it("returns zero bundle metrics when analytics has no events for the bundle", async () => {
    const databasePlugin = {
      ...createDatabasePlugin("metrics-db", [baseBundle]),
      analytics: {
        getLifecycleMetrics: vi.fn(async () => ({
          bundles: [],
          series: [],
          totals: { active: 0, recovered: 0 },
        })),
      },
    } satisfies DatabasePlugin;
    const storagePlugin = createStoragePlugin(async () => ({
      fileUrl: "https://assets.example.com/bundle.zip",
    }));
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const apiOperations =
      (await import("./api-operations.server")) as typeof import("./api-operations.server") & {
        readonly getBundleMetricsOperation: (input: {
          readonly bundleId: string;
        }) => Promise<unknown>;
      };

    const result = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => databasePlugin,
        storage: () => storagePlugin,
      },
      () =>
        apiOperations.getBundleMetricsOperation({ bundleId: baseBundle.id }),
    );

    expect(result).toEqual({
      active: 0,
      lastSeenAt: null,
      recovered: 0,
      series: [],
    });
  });

  it("resolves runtime download URLs through the hosted storage profile", async () => {
    const databasePlugin = createDatabasePlugin("hosted-db", [baseBundle]);
    const getDownloadUrl = vi.fn<RuntimeStorageProfile["getDownloadUrl"]>(
      async () => ({ fileUrl: "https://assets.example.com/bundle.zip" }),
    );
    const storagePlugin = createStoragePlugin(getDownloadUrl);
    const { runWithHostedConsoleContext } =
      await import("./hosted-context.server");
    const { getBundleDownloadUrlOperation } =
      await import("./api-operations.server");

    const result = await runWithHostedConsoleContext(
      {
        project: { id: "project-001", workspaceId: "workspace-001" },
        database: () => databasePlugin,
        storage: () => storagePlugin,
      },
      () => getBundleDownloadUrlOperation({ bundleId: baseBundle.id }),
    );

    expect(result).toEqual({
      fileUrl: "https://assets.example.com/bundle.zip",
    });
    expect(getDownloadUrl).toHaveBeenCalledWith(baseBundle.storageUri);
  });
});
