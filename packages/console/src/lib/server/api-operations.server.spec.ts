// @vitest-environment node

import type {
  Bundle,
  DatabasePlugin,
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
    bundles: {
      getBundleById: vi.fn(async (bundleId) => {
        return bundles.find((bundle) => bundle.id === bundleId) ?? null;
      }),
      getBundles: vi.fn(async () => ({
        data: [...bundles],
        pagination: {
          currentPage: 1,
          hasNextPage: false,
          hasPreviousPage: false,
          total: bundles.length,
          totalPages: 1,
        },
      })),
      updateBundle: vi.fn(),
      appendBundle: vi.fn(),
      deleteBundle: vi.fn(),
      commitBundle: vi.fn(),
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
    expect(firstDatabase.bundles.getBundles).toHaveBeenCalledOnce();
    expect(secondDatabase.bundles.getBundles).toHaveBeenCalledOnce();
    expect(firstResult.data).toEqual([baseBundle]);
    expect(secondResult.data).toEqual([secondBundle]);
  });

  it("reports telemetry capability from optional database methods", async () => {
    const unsupportedDatabase = createDatabasePlugin("unsupported-db", []);
    const supportedDatabase = {
      ...createDatabasePlugin("supported-db", []),
      analytics: {
        getTelemetryKeyCredential: vi.fn(async () => ({
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
          keyHash: "hash",
          telemetryKeySuffix: "abcd1234",
        })),
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

    expect(result.state).toEqual({ telemetryKeySuffix: "abcd1234" });
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
