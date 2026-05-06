import { describe, expect, it, vi } from "vitest";

import {
  createFullStoragePlugin,
  createNodeStoragePlugin,
  createRuntimeStoragePlugin,
  createStoragePlugin,
} from "./createStoragePlugin";
import {
  assertNodeStoragePlugin,
  assertRuntimeStoragePlugin,
  isNodeStoragePlugin,
  isRuntimeStoragePlugin,
} from "./storageProfile";

describe("createStoragePlugin", () => {
  it("creates a node storage profile and calls upload hooks", async () => {
    const upload = vi.fn(async (key: string, filePath: string) => ({
      storageUri: `s3://bucket/${key}/${filePath}`,
    }));
    const onStorageUploaded = vi.fn(async () => undefined);

    const plugin = createNodeStoragePlugin({
      name: "testNodeStorage",
      supportedProtocol: "s3",
      factory: () => ({
        delete: vi.fn(),
        downloadFile: vi.fn(),
        upload,
      }),
    })({}, { onStorageUploaded })();

    await expect(
      plugin.profiles.node.upload("bundle-id", "bundle.zip"),
    ).resolves.toEqual({
      storageUri: "s3://bucket/bundle-id/bundle.zip",
    });

    expect(plugin.profiles.runtime).toBeUndefined();
    expect(upload).toHaveBeenCalledWith("bundle-id", "bundle.zip");
    expect(onStorageUploaded).toHaveBeenCalledOnce();
  });

  it("does not initialize provider profiles before a profile is accessed", async () => {
    const factory = vi.fn(() => ({
      delete: vi.fn(),
      downloadFile: vi.fn(),
      upload: vi.fn(async () => ({ storageUri: "s3://bucket/bundle.zip" })),
    }));

    const plugin = createNodeStoragePlugin({
      name: "testNodeStorage",
      supportedProtocol: "s3",
      factory,
    })({})();

    expect(factory).not.toHaveBeenCalled();
    assertNodeStoragePlugin(plugin);
    expect(factory).not.toHaveBeenCalled();

    await plugin.profiles.node.upload("bundle-id", "bundle.zip");

    expect(factory).toHaveBeenCalledOnce();
  });

  it("creates a runtime storage profile with required direct text reads", async () => {
    const getDownloadUrl = vi.fn(
      async (
        _storageUri: string,
        _context: unknown,
        _config: { publicHost: string },
      ) => ({
        fileUrl: "https://assets.example.com/bundle.zip",
      }),
    );
    const readText = vi.fn(
      async (
        _storageUri: string,
        _context: unknown,
        _config: { publicHost: string },
      ) => '{"id":"bundle-id"}',
    );
    const context = {
      env: {
        bucketName: "assets",
      },
    };

    const plugin = createRuntimeStoragePlugin<
      { publicHost: string },
      typeof context
    >({
      name: "testRuntimeStorage",
      supportedProtocol: "r2",
      factory: (config) => ({
        getDownloadUrl: async (storageUri, runtimeContext) =>
          getDownloadUrl(storageUri, runtimeContext, config),
        readText: async (storageUri, runtimeContext) =>
          readText(storageUri, runtimeContext, config),
      }),
    })({ publicHost: "https://assets.example.com" })();

    await expect(
      plugin.profiles.runtime.getDownloadUrl("r2://bucket/bundle.zip", context),
    ).resolves.toEqual({
      fileUrl: "https://assets.example.com/bundle.zip",
    });
    await expect(
      plugin.profiles.runtime.readText("r2://bucket/manifest.json", context),
    ).resolves.toBe('{"id":"bundle-id"}');

    expect(plugin.profiles.node).toBeUndefined();
    expect(getDownloadUrl).toHaveBeenCalledWith(
      "r2://bucket/bundle.zip",
      context,
      { publicHost: "https://assets.example.com" },
    );
    expect(readText).toHaveBeenCalledWith(
      "r2://bucket/manifest.json",
      context,
      { publicHost: "https://assets.example.com" },
    );
  });

  it("creates a full storage profile for plugins shared by deploy and runtime", async () => {
    const plugin = createFullStoragePlugin({
      name: "testFullStorage",
      supportedProtocol: "supabase-storage",
      factory: () => ({
        node: {
          delete: vi.fn(),
          downloadFile: vi.fn(),
          upload: vi.fn(async () => ({
            storageUri: "supabase-storage://bucket/bundle.zip",
          })),
        },
        runtime: {
          getDownloadUrl: vi.fn(async () => ({
            fileUrl: "https://assets.example.com/bundle.zip",
          })),
          readText: vi.fn(async () => null),
        },
      }),
    })({})();

    expect(isNodeStoragePlugin(plugin)).toBe(true);
    expect(isRuntimeStoragePlugin(plugin)).toBe(true);
    await expect(
      plugin.profiles.node.upload("bundle-id", "bundle.zip"),
    ).resolves.toEqual({
      storageUri: "supabase-storage://bucket/bundle.zip",
    });
    await expect(
      plugin.profiles.runtime.readText(
        "supabase-storage://bucket/manifest.json",
      ),
    ).resolves.toBeNull();
  });

  it("supports custom profile combinations through the low-level factory", () => {
    const plugin = createStoragePlugin({
      name: "customStorage",
      supportedProtocol: "custom",
      factory: () => ({
        runtime: {
          getDownloadUrl: vi.fn(async () => ({
            fileUrl: "https://assets.example.com/file",
          })),
          readText: vi.fn(async () => "{}"),
        },
      }),
    })({})();

    assertRuntimeStoragePlugin(plugin);
    expect(plugin.profiles.runtime).toBeDefined();
  });

  it("throws clear errors when the required profile is missing", () => {
    const nodeOnlyPlugin = createNodeStoragePlugin({
      name: "nodeOnlyStorage",
      supportedProtocol: "s3",
      factory: () => ({
        delete: vi.fn(),
        downloadFile: vi.fn(),
        upload: vi.fn(),
      }),
    })({})();
    const runtimeOnlyPlugin = createRuntimeStoragePlugin({
      name: "runtimeOnlyStorage",
      supportedProtocol: "r2",
      factory: () => ({
        getDownloadUrl: vi.fn(),
        readText: vi.fn(),
      }),
    })({})();

    expect(() => assertRuntimeStoragePlugin(nodeOnlyPlugin)).toThrow(
      'nodeOnlyStorage does not implement the runtime storage profile for protocol "s3".',
    );
    expect(() => assertNodeStoragePlugin(runtimeOnlyPlugin)).toThrow(
      'runtimeOnlyStorage does not implement the node storage profile for protocol "r2".',
    );
  });
});
