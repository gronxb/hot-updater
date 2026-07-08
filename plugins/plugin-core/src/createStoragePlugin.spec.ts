import { describe, expect, it, vi } from "vitest";

import { createStoragePlugin } from "./createStoragePlugin";
import type { ConfigInput, StoragePlugin, StorageUploadSource } from "./types";

describe("createStoragePlugin", () => {
  it("creates a storage plugin and calls upload hooks", async () => {
    const upload = vi.fn(
      async (params: {
        readonly key: string;
        readonly source: StorageUploadSource;
      }) => ({
        storageUri:
          params.source.kind === "file"
            ? `s3://bucket/${params.key}/${params.source.filePath}`
            : `s3://bucket/${params.key}/bytes`,
      }),
    );
    const readText = vi.fn(async () => '{"id":"bundle-id"}');
    const onStorageUploaded = vi.fn(async () => undefined);

    const plugin = createStoragePlugin({
      name: "testStorage",
      supportedProtocol: "s3",
      factory: () => ({
        delete: vi.fn(async () => undefined),
        exists: vi.fn(async () => false),
        getDownloadUrl: vi.fn(async () => ({
          fileUrl: "https://assets.example.com/bundle.zip",
        })),
        readText,
        upload,
      }),
    })({}, { onStorageUploaded })();

    const source = {
      kind: "file",
      filePath: "bundle.zip",
    } satisfies StorageUploadSource;

    expect("put" in plugin).toBe(false);

    if (!plugin.upload) {
      throw new Error("expected upload operation");
    }
    await expect(
      plugin.upload({
        key: "bundle-id",
        source,
      }),
    ).resolves.toEqual({
      storageUri: "s3://bucket/bundle-id/bundle.zip",
    });
    expect(upload).toHaveBeenCalledWith({
      key: "bundle-id",
      source,
    });
    expect(onStorageUploaded).toHaveBeenCalledOnce();

    if (!plugin.readText) {
      throw new Error("expected readText operation");
    }
    await expect(
      plugin.readText({ storageUri: "s3://bucket/manifest.json" }),
    ).resolves.toBe('{"id":"bundle-id"}');
    expect(readText).toHaveBeenCalledWith({
      storageUri: "s3://bucket/manifest.json",
    });
  });

  it("keeps unsupported operations absent from the plugin shape", () => {
    const plugin = createStoragePlugin({
      name: "downloadOnlyStorage",
      supportedProtocol: "r2",
      factory: () => ({
        readText: vi.fn(async () => null),
      }),
    })({})();

    expect("delete" in plugin).toBe(false);
    expect("exists" in plugin).toBe(false);
    expect("getDownloadUrl" in plugin).toBe(false);
    expect("readBytes" in plugin).toBe(false);
    expect("upload" in plugin).toBe(false);
  });

  it("passes config and object params to low-level operations", async () => {
    const getDownloadUrl = vi.fn(
      async (
        params: { readonly storageUri: string },
        config: { publicHost: string },
      ) => ({
        fileUrl: `${config.publicHost}/${params.storageUri}`,
      }),
    );

    const plugin = createStoragePlugin<{ publicHost: string }>({
      name: "contextStorage",
      supportedProtocol: "r2",
      factory: (config) => ({
        getDownloadUrl: (params) => getDownloadUrl(params, config),
        upload: vi.fn(async () => ({
          storageUri: "r2://bucket/bundle.zip",
        })),
      }),
    })({ publicHost: "https://assets.example.com" })();

    if (!plugin.getDownloadUrl) {
      throw new Error("expected getDownloadUrl operation");
    }

    await expect(
      plugin.getDownloadUrl({ storageUri: "r2://bucket/bundle.zip" }),
    ).resolves.toEqual({
      fileUrl: "https://assets.example.com/r2://bucket/bundle.zip",
    });

    expect(getDownloadUrl).toHaveBeenCalledWith(
      { storageUri: "r2://bucket/bundle.zip" },
      { publicHost: "https://assets.example.com" },
    );
  });

  it("allows ConfigInput.storage to return StoragePlugin", () => {
    const storageFactory = createStoragePlugin({
      name: "configStorage",
      supportedProtocol: "r2",
      factory: () => ({
        upload: vi.fn(async () => ({ storageUri: "r2://bucket/bundle.zip" })),
      }),
    });

    const config = {
      storage: storageFactory({}),
    } satisfies Pick<ConfigInput, "storage">;

    const plugin: StoragePlugin = config.storage();

    expect(plugin.name).toBe("configStorage");
  });
});
