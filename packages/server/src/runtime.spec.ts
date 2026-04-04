import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  DatabasePlugin,
  RequestEnvContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createHotUpdater } from "./runtime";

const bundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash123",
  gitCommitHash: null,
  message: "Test bundle",
  channel: "production",
  storageUri: "s3://test-bucket/bundles/bundle.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

type TestEnv = {
  assetHost: string;
};

type TestContext = RequestEnvContext<TestEnv>;

describe("runtime createHotUpdater", () => {
  it("passes the handler context to database and storage resolution", async () => {
    const request = new Request(
      "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
        `${NIL_UUID}/${NIL_UUID}`,
    );
    const getBundles = vi.fn<DatabasePlugin<TestContext>["getBundles"]>(
      async () => {
        return {
          data: [bundle],
          pagination: {
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
            total: 1,
          },
        };
      },
    );
    const getDownloadUrl = vi.fn<StoragePlugin<TestContext>["getDownloadUrl"]>(
      async (_storageUri, context) => {
        return {
          fileUrl: new URL("/bundle.zip", context?.env?.assetHost).toString(),
        };
      },
    );

    const database: DatabasePlugin<TestContext> = {
      name: "testDatabase",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(id) {
        return id === bundle.id ? bundle : null;
      },
      getBundles,
      async getChannels() {
        return ["production"];
      },
      async onUnmount() {},
      async updateBundle() {},
    };
    const storage: StoragePlugin<TestContext> = {
      name: "testStorage",
      supportedProtocol: "s3",
      async upload(key) {
        return { storageUri: `s3://test-bucket/${key}` };
      },
      async delete() {},
      getDownloadUrl,
    };

    const hotUpdater = createHotUpdater({
      database,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    expectTypeOf(hotUpdater.handler)
      .parameter(1)
      .toEqualTypeOf<TestContext | undefined>();

    const response = await hotUpdater.handler(request, {
      env: {
        assetHost: "https://assets.example.com",
      },
      request,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fileHash: "hash123",
      fileUrl: "https://assets.example.com/bundle.zip",
      id: "00000000-0000-0000-0000-000000000001",
      message: "Test bundle",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
    expect(getBundles).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        env: {
          assetHost: "https://assets.example.com",
        },
        request: expect.any(Request),
      }),
    );
    expect(getDownloadUrl).toHaveBeenCalledWith(
      "s3://test-bucket/bundles/bundle.zip",
      expect.objectContaining({
        env: {
          assetHost: "https://assets.example.com",
        },
        request: expect.any(Request),
      }),
    );
  });

  it("does not inject the request into context unless explicitly provided", async () => {
    const getBundles = vi.fn<DatabasePlugin<TestContext>["getBundles"]>(
      async () => {
        return {
          data: [bundle],
          pagination: {
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
            total: 1,
          },
        };
      },
    );

    const database: DatabasePlugin<TestContext> = {
      name: "testDatabase",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(id) {
        return id === bundle.id ? bundle : null;
      },
      getBundles,
      async getChannels() {
        return ["production"];
      },
      async onUnmount() {},
      async updateBundle() {},
    };
    const storage: StoragePlugin<TestContext> = {
      name: "testStorage",
      supportedProtocol: "s3",
      async upload(key) {
        return { storageUri: `s3://test-bucket/${key}` };
      },
      async delete() {},
      async getDownloadUrl() {
        return { fileUrl: "https://assets.example.com/bundle.zip" };
      },
    };

    const hotUpdater = createHotUpdater({
      database,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const response = await hotUpdater.handler(
      new Request(
        "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
          `${NIL_UUID}/${NIL_UUID}`,
      ),
      {
        env: {
          assetHost: "https://assets.example.com",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(getBundles).toHaveBeenCalledWith(expect.any(Object), {
      env: {
        assetHost: "https://assets.example.com",
      },
    });
  });

  it("supports stripped base-path requests and ignores extra framework args", async () => {
    const getBundles = vi.fn<DatabasePlugin<TestContext>["getBundles"]>(
      async () => {
        return {
          data: [bundle],
          pagination: {
            hasNextPage: false,
            hasPreviousPage: false,
            currentPage: 1,
            totalPages: 1,
            total: 1,
          },
        };
      },
    );

    const database: DatabasePlugin<TestContext> = {
      name: "testDatabase",
      async appendBundle() {},
      async commitBundle() {},
      async deleteBundle() {},
      async getBundleById(id) {
        return id === bundle.id ? bundle : null;
      },
      getBundles,
      async getChannels() {
        return ["production"];
      },
      async onUnmount() {},
      async updateBundle() {},
    };
    const storage: StoragePlugin<TestContext> = {
      name: "testStorage",
      supportedProtocol: "s3",
      async upload(key) {
        return { storageUri: `s3://test-bucket/${key}` };
      },
      async delete() {},
      async getDownloadUrl() {
        return { fileUrl: "https://assets.example.com/bundle.zip" };
      },
    };

    const hotUpdater = createHotUpdater({
      database,
      storages: [storage],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    const mountStyleHandler = hotUpdater.handler as (
      request: Request,
      context?: unknown,
      executionCtx?: unknown,
    ) => Promise<Response>;
    const response = await mountStyleHandler(
      new Request(
        "https://updates.example.com/app-version/ios/1.0.0/production/" +
          `${NIL_UUID}/${NIL_UUID}`,
      ),
      { someBinding: "ignored" },
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(200);
    expect(getBundles).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it("clears pending plugin changes after a failed mutation commit", async () => {
    const committedBundles = new Map<string, Bundle>();
    let commitAttempt = 0;

    const database = createDatabasePlugin({
      name: "failingPlugin",
      factory: () => ({
        async getBundleById(bundleId) {
          return committedBundles.get(bundleId) ?? null;
        },
        async getBundles() {
          return {
            data: Array.from(committedBundles.values()),
            pagination: {
              hasNextPage: false,
              hasPreviousPage: false,
              currentPage: 1,
              totalPages: 1,
              total: committedBundles.size,
            },
          };
        },
        async getChannels() {
          return [];
        },
        async commitBundle({ changedSets }) {
          commitAttempt += 1;

          if (commitAttempt === 1) {
            throw new Error("commit failed");
          }

          for (const change of changedSets) {
            if (change.operation === "delete") {
              committedBundles.delete(change.data.id);
              continue;
            }

            committedBundles.set(change.data.id, change.data);
          }
        },
      }),
    })({});

    const hotUpdater = createHotUpdater({
      database,
      basePath: "/api/check-update",
      routes: {
        updateCheck: false,
        bundles: false,
      },
    });

    const failedBundle: Bundle = {
      ...bundle,
      id: "00000000-0000-0000-0000-000000000010",
      message: "failed bundle",
    };
    const succeedingBundle: Bundle = {
      ...bundle,
      id: "00000000-0000-0000-0000-000000000011",
      message: "succeeding bundle",
    };

    await expect(hotUpdater.insertBundle(failedBundle)).rejects.toThrow(
      "commit failed",
    );
    await hotUpdater.insertBundle(succeedingBundle);

    expect(await hotUpdater.getBundleById(failedBundle.id)).toBeNull();
    await expect(
      hotUpdater.getBundleById(succeedingBundle.id),
    ).resolves.toEqual(succeedingBundle);
  });
});
