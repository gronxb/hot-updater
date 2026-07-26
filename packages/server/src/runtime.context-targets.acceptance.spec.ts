import { NIL_UUID } from "@hot-updater/core";
import {
  StorageConfigurationError,
  type DatabasePlugin,
  type RuntimeStorageProfile,
  type StorageOperationContext,
  type StoragePluginV2,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./createHotUpdaterCore";
import {
  createRuntimeDatabase,
  createRuntimeStorage,
  runtimeBundle,
  type TestContext,
} from "./runtime.testFixtures";

const updateArgs = {
  _updateStrategy: "appVersion" as const,
  appVersion: "1.0.0",
  bundleId: NIL_UUID,
  channel: "production",
  platform: "ios" as const,
};

const createUpdateDatabase = (): DatabasePlugin => ({
  ...createRuntimeDatabase(),
  async getUpdateInfo() {
    return {
      fileHash: runtimeBundle.fileHash,
      id: NIL_UUID,
      message: runtimeBundle.message,
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: runtimeBundle.storageUri,
    };
  },
});

const createTargetStorage = (
  observed: StorageOperationContext[],
): StoragePluginV2 => ({
  name: "target-storage",
  protocol: "s3",
  async put() {
    throw new Error("unused");
  },
  async head() {
    return { kind: "not-found" };
  },
  async get() {
    return { kind: "not-found" };
  },
  async delete() {
    return { kind: "not-found" };
  },
  async issueDownload({ context }) {
    observed.push(context);
    return {
      kind: "issued",
      downloadUrl: `https://${context.target}.example.com/bundle.zip`,
    };
  },
});

describe.each(["node", "worker", "functions", "edge"] as const)(
  "%s storageContext integration acceptance",
  (target) => {
    it("copies and freezes fresh mixed maps while preserving live binding identity", async () => {
      // Given
      const liveBinding = { state: 0 };
      const environment = { OPTIONAL: undefined, REGION: "test-region" };
      const bindings = { label: "binding", liveBinding };
      const source: StorageOperationContext = {
        target,
        environment,
        bindings,
      };
      const observed: StorageOperationContext[] = [];
      const platformContext: TestContext = {
        env: { assetHost: `${target}.platform.example.com` },
      };
      const resolverContexts: Array<TestContext | undefined> = [];
      const hotUpdater = createHotUpdater<TestContext>({
        database: createUpdateDatabase(),
        storages: [createTargetStorage(observed)],
        storageContext(input) {
          resolverContexts.push(input.context);
          return source;
        },
      });

      // When
      const first = await hotUpdater.getAppUpdateInfo(
        updateArgs,
        platformContext,
      );
      liveBinding.state = 1;
      const second = await hotUpdater.getAppUpdateInfo(
        updateArgs,
        platformContext,
      );

      // Then
      expect(first?.fileUrl).toBe(`https://${target}.example.com/bundle.zip`);
      expect(second?.fileUrl).toBe(first?.fileUrl);
      expect(resolverContexts).toEqual([platformContext, platformContext]);
      expect(observed).toHaveLength(2);
      expect(observed[0]).not.toBe(source);
      expect(observed[1]).not.toBe(source);
      expect(observed[0]).not.toBe(observed[1]);
      expect(observed[0]?.environment).not.toBe(environment);
      expect(observed[0]?.bindings).not.toBe(bindings);
      expect(observed[0]?.bindings.liveBinding).toBe(liveBinding);
      expect(observed[1]?.bindings.liveBinding).toBe(liveBinding);
      expect(liveBinding.state).toBe(1);
      for (const context of observed) {
        expect(context.target).toBe(target);
        expect(context.environment).toEqual(environment);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.environment)).toBe(true);
        expect(Object.isFrozen(context.bindings)).toBe(true);
      }
    });
  },
);

describe("storageContext target boundary acceptance", () => {
  it("keeps the opaque context identity at the database API boundary", async () => {
    // Given
    const database = createRuntimeDatabase();
    const findOne = vi.spyOn(database, "findOne");
    const platformContext: TestContext = {
      env: { assetHost: "database.platform.example.com" },
    };
    const resolverContexts: Array<TestContext | undefined> = [];
    const hotUpdater = createHotUpdater<TestContext>({
      database,
      storages: [createTargetStorage([])],
      storageContext(input) {
        resolverContexts.push(input.context);
        return {
          target: "node",
          environment: {},
          bindings: {},
        };
      },
    });

    // When
    const result = await hotUpdater.getBundleById(
      "00000000-0000-0000-0000-000000000099",
      platformContext,
    );

    // Then
    expect(result).toBeNull();
    expect(resolverContexts).toEqual([platformContext]);
    expect(resolverContexts[0]).toBe(platformContext);
    expect(findOne).toHaveBeenCalledOnce();
  });

  it("rejects a target mismatch before provider I/O", async () => {
    // Given
    let providerIo = 0;
    const storage: StoragePluginV2 = {
      ...createTargetStorage([]),
      async issueDownload({ context }) {
        if (context.target !== "edge") {
          throw new StorageConfigurationError(
            "invalid-storage-input",
            "Expected edge storage context.",
          );
        }
        providerIo += 1;
        return {
          kind: "issued",
          downloadUrl: "https://edge.example.com/bundle.zip",
        };
      },
    };
    const hotUpdater = createHotUpdater<TestContext>({
      database: createUpdateDatabase(),
      storages: [storage],
      storageContext: () => ({
        target: "worker",
        environment: {},
        bindings: {},
      }),
    });

    // When
    const result = hotUpdater.getAppUpdateInfo(updateArgs, {
      env: { assetHost: "platform.example.com" },
    });

    // Then
    await expect(result).rejects.toMatchObject({
      code: "invalid-storage-input",
    });
    expect(providerIo).toBe(0);
  });

  it("passes the original opaque context unchanged to legacy delivery", async () => {
    // Given
    const getDownloadUrl = vi.fn<
      RuntimeStorageProfile<TestContext>["getDownloadUrl"]
    >(async () => ({
      fileUrl: "https://legacy.example.com/bundle.zip",
    }));
    const platformContext: TestContext = {
      env: { assetHost: "legacy.platform.example.com" },
    };
    const hotUpdater = createHotUpdater<TestContext>({
      database: createUpdateDatabase(),
      storages: [createRuntimeStorage(getDownloadUrl)],
    });

    // When
    const result = await hotUpdater.getAppUpdateInfo(
      updateArgs,
      platformContext,
    );

    // Then
    expect(result?.fileUrl).toBe("https://legacy.example.com/bundle.zip");
    expect(getDownloadUrl).toHaveBeenCalledOnce();
    expect(getDownloadUrl.mock.calls[0]?.[1]).toBe(platformContext);
  });
});
