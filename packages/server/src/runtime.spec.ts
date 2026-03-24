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

const createDatabasePlugin = (): DatabasePlugin => ({
  name: "testDatabase",
  async appendBundle() {},
  async commitBundle() {},
  async deleteBundle() {},
  async getBundleById(id) {
    return id === bundle.id ? bundle : null;
  },
  async getBundles() {
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
  async getChannels() {
    return ["production"];
  },
  async onUnmount() {},
  async updateBundle() {},
});

describe("runtime createHotUpdater", () => {
  it("passes the handler request to storage getDownloadUrl", async () => {
    const getDownloadUrl = vi.fn<StoragePlugin["getDownloadUrl"]>(
      async (_storageUri, context) => {
        return {
          fileUrl: new URL("/bundle.zip", context?.request?.url).toString(),
        };
      },
    );

    const hotUpdater = createHotUpdater({
      database: createDatabasePlugin(),
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

    const response = await hotUpdater.handler(
      new Request(
        "https://updates.example.com/api/check-update/app-version/ios/1.0.0/production/" +
          `${NIL_UUID}/${NIL_UUID}`,
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fileHash: "hash123",
      fileUrl: "https://updates.example.com/bundle.zip",
      id: "00000000-0000-0000-0000-000000000001",
      message: "Test bundle",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
    expect(getDownloadUrl).toHaveBeenCalledWith(
      "s3://test-bucket/bundles/bundle.zip",
      expect.objectContaining({
        request: expect.any(Request),
      }),
    );
  });
});
