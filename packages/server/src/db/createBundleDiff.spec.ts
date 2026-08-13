import { brotliCompressSync } from "node:zlib";

import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import {
  createDatabaseClient,
  createStoragePlugin as createCoreStoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";

vi.mock("@hot-updater/bsdiff", () => ({
  hdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

import { createBundleDiff } from "./createBundleDiff";

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  fileHash: `${id}-file-hash`,
  gitCommitHash: null,
  id,
  assetBaseStorageUri: `s3://test-bucket/releases/${id}/files`,
  manifestStorageUri: `s3://test-bucket/releases/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
  storageUri: `s3://test-bucket/releases/${id}/bundle.zip`,
  ...overrides,
});

const createDatabasePlugin = async (
  bundles: readonly Bundle[],
): Promise<DatabasePlugin> => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  for (const bundle of bundles) await client.insertBundle(bundle);
  return plugin;
};

const createStoragePlugin = (
  put: NonNullable<StoragePlugin["put"]>,
  options: {
    get?: NonNullable<StoragePlugin["get"]>;
    protocol?: string;
  } = {},
): StoragePluginWith<"get" | "put" | "delete"> =>
  createCoreStoragePlugin({
    name: "mockStorage",
    protocol: options.protocol ?? "s3",
    async delete({ storageUri }) {
      void storageUri;
      return { deleted: true };
    },
    get:
      options.get ??
      (async ({ storageUri }) => {
        const storageUrl = new URL(storageUri);
        const response = await fetch(
          `https://assets.example.com${storageUrl.pathname}`,
        );
        return { response: response.ok ? response : null };
      }),
    put,
  });

describe("createBundleDiff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a Hermes patch and stores patch metadata on the target bundle", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const plugin = await createDatabasePlugin([baseBundle, targetBundle]);
    const databasePlugin: DatabasePlugin = plugin;
    const commit = vi.spyOn(databasePlugin, "commit");
    const upload = vi.fn<NonNullable<StoragePlugin["put"]>>(
      async ({ key, body, contentLength }) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(contentLength).toBe(bytes.byteLength);
        return { storageUri: `s3://test-bucket/${key}` };
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string) => {
        const url = String(input);

        if (url.endsWith(`${baseBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-old",
                },
              },
              bundleId: baseBundle.id,
            }),
          );
        }

        if (url.endsWith(`${targetBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        if (url.endsWith(`${baseBundle.id}/files/index.ios.bundle.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 2, 3])));
        }

        if (url.endsWith(`${baseBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 9, 3])));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 9, 3]));
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      const updatedBundle = await createBundleDiff(
        {
          baseBundleId: baseBundle.id,
          bundleId: targetBundle.id,
        },
        {
          databasePlugin,
          storagePlugin: createStoragePlugin(upload),
        },
      );

      expect(upload).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledOnce();
      expect(updatedBundle).toMatchObject({
        patchBaseBundleId: baseBundle.id,
        patchBaseFileHash: "hash-old",
      });
      expect(updatedBundle.patchFileHash).toMatch(/[a-f0-9]{64}/);
      expect(updatedBundle.patchStorageUri).toContain(
        `${targetBundle.id}/patches/${baseBundle.id}`,
      );
      expect(updatedBundle.patches).toEqual([
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "hash-old",
          patchFileHash: updatedBundle.patchFileHash,
          patchStorageUri: updatedBundle.patchStorageUri,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects ambiguous Hermes bundle assets in manifests", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const databasePlugin = await createDatabasePlugin([
      baseBundle,
      targetBundle,
    ]);
    const upload = vi.fn<NonNullable<StoragePlugin["put"]>>(
      async ({ key }) => ({
        storageUri: `s3://test-bucket/${key}`,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string) => {
        const url = String(input);

        if (url.endsWith(`${baseBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-old",
                },
                "secondary.ios.bundle": {
                  fileHash: "hash-secondary-old",
                },
              },
              bundleId: baseBundle.id,
            }),
          );
        }

        if (url.endsWith(`${targetBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-new",
                },
                "secondary.ios.bundle": {
                  fileHash: "hash-secondary-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      await expect(
        createBundleDiff(
          {
            baseBundleId: baseBundle.id,
            bundleId: targetBundle.id,
          },
          {
            databasePlugin,
            storagePlugin: createStoragePlugin(upload),
          },
        ),
      ).rejects.toThrow("Expected exactly one Hermes bundle asset in manifest");
      expect(upload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a matching HTTPS storage plugin before direct fetch", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001", {
      assetBaseStorageUri: "https://storage.example.com/releases/base/files",
      manifestStorageUri:
        "https://storage.example.com/releases/base/manifest.json",
    });
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002", {
      assetBaseStorageUri: "https://storage.example.com/releases/target/files",
      manifestStorageUri:
        "https://storage.example.com/releases/target/manifest.json",
    });
    const databasePlugin = await createDatabasePlugin([
      baseBundle,
      targetBundle,
    ]);
    const responses = new Map<string, string | Uint8Array>([
      [
        baseBundle.manifestStorageUri!,
        JSON.stringify({
          assets: { "index.ios.bundle": { fileHash: "hash-old" } },
          bundleId: baseBundle.id,
        }),
      ],
      [
        targetBundle.manifestStorageUri!,
        JSON.stringify({
          assets: { "index.ios.bundle": { fileHash: "hash-new" } },
          bundleId: targetBundle.id,
        }),
      ],
      [
        `${baseBundle.assetBaseStorageUri}/index.ios.bundle`,
        new Uint8Array([1, 2, 3]),
      ],
      [
        `${targetBundle.assetBaseStorageUri}/index.ios.bundle`,
        new Uint8Array([1, 9, 3]),
      ],
    ]);
    const get = vi.fn<NonNullable<StoragePlugin["get"]>>(
      async ({ storageUri }) => ({
        response: responses.has(storageUri)
          ? new Response(responses.get(storageUri))
          : null,
      }),
    );
    const directFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", directFetch);
    const upload = vi.fn<NonNullable<StoragePlugin["put"]>>(
      async ({ key }) => ({
        storageUri: `https://storage.example.com/${key}`,
      }),
    );

    try {
      await createBundleDiff(
        { baseBundleId: baseBundle.id, bundleId: targetBundle.id },
        {
          databasePlugin,
          storagePlugin: createStoragePlugin(upload, {
            get,
            protocol: "https",
          }),
        },
      );

      expect(get).toHaveBeenCalledWith({
        storageUri: baseBundle.manifestStorageUri,
      });
      expect(get).toHaveBeenCalledWith({
        storageUri: targetBundle.manifestStorageUri,
      });
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("appends additional patch bases without replacing the primary patch when requested", async () => {
    const primaryBaseBundle = createBundle(
      "00000000-0000-0000-0000-000000000001",
    );
    const secondaryBaseBundle = createBundle(
      "00000000-0000-0000-0000-000000000002",
    );
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000003", {
      patches: [
        {
          baseBundleId: primaryBaseBundle.id,
          baseFileHash: "hash-primary-old",
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
      ],
      patchBaseBundleId: primaryBaseBundle.id,
      patchBaseFileHash: "hash-primary-old",
      patchFileHash: "hash-primary-patch",
      patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
    });
    const databasePlugin = await createDatabasePlugin([
      primaryBaseBundle,
      secondaryBaseBundle,
      targetBundle,
    ]);
    const upload = vi.fn<NonNullable<StoragePlugin["put"]>>(
      async ({ key }) => ({
        storageUri: `s3://test-bucket/${key}`,
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string) => {
        const url = String(input);

        if (url.endsWith(`${secondaryBaseBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-secondary-old",
                },
              },
              bundleId: secondaryBaseBundle.id,
            }),
          );
        }

        if (url.endsWith(`${targetBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "index.ios.bundle": {
                  fileHash: "hash-target-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        if (
          url.endsWith(`${secondaryBaseBundle.id}/files/index.ios.bundle.br`)
        ) {
          return new Response(brotliCompressSync(new Uint8Array([1, 2, 3])));
        }

        if (url.endsWith(`${secondaryBaseBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 4, 3])));
        }

        if (url.endsWith(`${targetBundle.id}/files/index.ios.bundle`)) {
          return new Response(new Uint8Array([1, 4, 3]));
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      const updatedBundle = await createBundleDiff(
        {
          baseBundleId: secondaryBaseBundle.id,
          bundleId: targetBundle.id,
        },
        {
          databasePlugin,
          storagePlugin: createStoragePlugin(upload),
        },
        {
          makePrimary: false,
        },
      );

      expect(updatedBundle.patchBaseBundleId).toBe(primaryBaseBundle.id);
      expect(updatedBundle.patches).toMatchObject([
        {
          baseBundleId: primaryBaseBundle.id,
          baseFileHash: "hash-primary-old",
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
        {
          baseBundleId: secondaryBaseBundle.id,
          baseFileHash: "hash-secondary-old",
          patchFileHash: expect.any(String),
          patchStorageUri: expect.stringContaining(
            `${targetBundle.id}/patches/${secondaryBaseBundle.id}`,
          ),
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
