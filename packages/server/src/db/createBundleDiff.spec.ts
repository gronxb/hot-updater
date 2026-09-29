import { brotliCompressSync } from "node:zlib";

import type {
  Bundle,
  EngineDatabase,
  StoragePlugin,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import {
  createStoragePlugin as createCoreStoragePlugin,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabaseCoreApi } from "../core/api";

vi.mock("@hot-updater/bsdiff", () => ({
  hdiff: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

import { createBundleDiff } from "./createBundleDiff";

const createBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle => ({
  gitCommitHash: null,
  id,
  assetBaseStorageUri: "s3://test-bucket/releases/assets",
  manifestStorageUri: `s3://test-bucket/releases/bundles/${id}/manifest.json`,
  metadata: {},
  platform: "ios",
  manifestFileHash: `${id}-manifest-hash`,
  ...overrides,
});

/** An in-memory database holding `bundles`, each deployed disabled. */
const createDatabase = async (
  bundles: readonly Bundle[],
): Promise<EngineDatabase> => {
  const database = { name: "memory", adapter: createMemoryAdapter() };
  const core = createDatabaseCoreApi(database);
  for (const bundle of bundles) {
    await core.deploy([
      {
        bundle,
        release: {
          channel: "production",
          enabled: false,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "*",
        },
      },
    ]);
  }
  return database;
};

/** A stored bundle with its patches, as deploys write it. */
const storedBundle = async (database: EngineDatabase, id: string) => {
  const detail = await createDatabaseCoreApi(database).getBundle(id);
  return detail === null ? null : rowToBundle(detail.bundle, detail.patches);
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
    const baseDownloadFileHash = "a".repeat(64);
    const targetDownloadFileHash = "b".repeat(64);
    const database = await createDatabase([baseBundle, targetBundle]);
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
                  downloadByteSize: 7,
                  downloadFileHash: baseDownloadFileHash,
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
                  downloadByteSize: 7,
                  downloadFileHash: targetDownloadFileHash,
                  fileHash: "hash-new",
                },
              },
              bundleId: targetBundle.id,
            }),
          );
        }

        if (url.endsWith(`/assets/sha256/aa/${baseDownloadFileHash}.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 2, 3])));
        }

        if (url.endsWith("/assets/sha256/ha/hash-old.bundle")) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith(`/assets/sha256/bb/${targetDownloadFileHash}.br`)) {
          return new Response(brotliCompressSync(new Uint8Array([1, 9, 3])));
        }

        if (url.endsWith("/assets/sha256/ha/hash-new.bundle")) {
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
          database,
          storagePlugin: createStoragePlugin(upload),
        },
      );

      expect(upload).toHaveBeenCalledOnce();
      await expect(
        storedBundle(database, targetBundle.id),
      ).resolves.toMatchObject({ patches: updatedBundle.patches });
      const [patch] = updatedBundle.patches ?? [];
      expect(patch?.baseBundleId).toBe(baseBundle.id);
      expect(patch?.baseFileHash).toBe("hash-old");
      expect(patch?.byteSize).toBe(4);
      expect(patch?.patchFileHash).toMatch(/[a-f0-9]{64}/);
      expect(patch?.patchStorageUri).toContain(
        `bundles/${targetBundle.id}/patches/${baseBundle.id}/${patch?.patchFileHash}/`,
      );
      expect(updatedBundle.patches).toEqual([
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "hash-old",
          byteSize: 4,
          patchFileHash: patch?.patchFileHash,
          patchStorageUri: patch?.patchStorageUri,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects ambiguous Hermes bundle assets in manifests", async () => {
    const baseBundle = createBundle("00000000-0000-0000-0000-000000000001");
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002");
    const database = await createDatabase([baseBundle, targetBundle]);
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
            database,
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
      assetBaseStorageUri: "https://storage.example.com/releases/assets",
      manifestStorageUri:
        "https://storage.example.com/releases/base/manifest.json",
    });
    const targetBundle = createBundle("00000000-0000-0000-0000-000000000002", {
      assetBaseStorageUri: "https://storage.example.com/releases/assets",
      manifestStorageUri:
        "https://storage.example.com/releases/target/manifest.json",
    });
    const database = await createDatabase([baseBundle, targetBundle]);
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
        `${baseBundle.assetBaseStorageUri}/sha256/ha/hash-old.bundle`,
        new Uint8Array([1, 2, 3]),
      ],
      [
        `${targetBundle.assetBaseStorageUri}/sha256/ha/hash-new.bundle`,
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
          database,
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
          byteSize: 4,
          patchFileHash: "hash-primary-patch",
          patchStorageUri: `s3://test-bucket/${primaryBaseBundle.id}/existing.bsdiff`,
        },
      ],
    });
    const database = await createDatabase([
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

        if (url.endsWith("/assets/sha256/ha/hash-secondary-old.br")) {
          return new Response(brotliCompressSync(new Uint8Array([1, 2, 3])));
        }

        if (url.endsWith("/assets/sha256/ha/hash-secondary-old.bundle")) {
          return new Response(new Uint8Array([1, 2, 3]));
        }

        if (url.endsWith("/assets/sha256/ha/hash-target-new.br")) {
          return new Response(brotliCompressSync(new Uint8Array([1, 4, 3])));
        }

        if (url.endsWith("/assets/sha256/ha/hash-target-new.bundle")) {
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
          database,
          storagePlugin: createStoragePlugin(upload),
        },
        {
          makePrimary: false,
        },
      );

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
            `bundles/${targetBundle.id}/patches/${secondaryBaseBundle.id}`,
          ),
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
