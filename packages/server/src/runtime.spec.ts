import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type { DatabasePlugin, StoragePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";
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

describe("runtime createHotUpdater", () => {
  it("passes the handler context to database and storage resolution", async () => {
    const request = new Request(
      "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
        `${NIL_UUID}/${NIL_UUID}`,
    );
    const getBundles = vi.fn<DatabasePlugin<TestEnv>["getBundles"]>(
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
    const getDownloadUrl = vi.fn<StoragePlugin<TestEnv>["getDownloadUrl"]>(
      async (_storageUri, context) => {
        return {
          fileUrl: new URL("/bundle.zip", context?.env?.assetHost).toString(),
        };
      },
    );

    const hotUpdater = createHotUpdater<TestEnv>({
      database: {
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
      },
      storages: [
        {
          name: "testStorage",
          supportedProtocol: "s3",
          async upload(key) {
            return { storageUri: `s3://test-bucket/${key}` };
          },
          async delete() {},
          getDownloadUrl,
        },
      ],
      basePath: "/api/check-update",
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

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
    const getBundles = vi.fn<DatabasePlugin<TestEnv>["getBundles"]>(
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

    const hotUpdater = createHotUpdater<TestEnv>({
      database: {
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
      },
      storages: [
        {
          name: "testStorage",
          supportedProtocol: "s3",
          async upload(key) {
            return { storageUri: `s3://test-bucket/${key}` };
          },
          async delete() {},
          async getDownloadUrl() {
            return { fileUrl: "https://assets.example.com/bundle.zip" };
          },
        },
      ],
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
});
