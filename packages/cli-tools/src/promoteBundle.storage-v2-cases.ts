import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Bundle, StorageOperationContext } from "@hot-updater/plugin-core";
import {
  createStoragePlugin,
  StoragePluginError,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";
import { createNodeStoragePluginFacade } from "@hot-updater/plugin-core/storage/node";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigResponse } from "./loadConfig";
import { createCopiedBundleArchive } from "./promoteBundle";

const sourceBundle: Bundle = {
  channel: "stable",
  enabled: true,
  fileHash: "source-hash",
  fingerprintHash: null,
  gitCommitHash: null,
  id: "source-id",
  message: "source",
  platform: "ios",
  shouldForceUpdate: false,
  storageUri: "storage://bucket/source/bundle.zip",
  targetAppVersion: "1.0.0",
};

const config = {
  signing: { enabled: false },
} as ConfigResponse;

const createArchive = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "promote-v2-source-"),
  );
  const archivePath = path.join(directory, "bundle.zip");
  const zip = new JSZip();
  zip.file("main.ios.bundle", "hermes");
  zip.file(
    "manifest.json",
    JSON.stringify({
      assets: {
        "main.ios.bundle": { fileHash: "bundle-hash" },
      },
      bundleId: sourceBundle.id,
    }),
  );
  await fs.writeFile(
    archivePath,
    await zip.generateAsync({ compression: "DEFLATE", type: "nodebuffer" }),
  );
  return {
    archivePath,
    cleanup: () => fs.rm(directory, { force: true, recursive: true }),
  };
};

type FixtureOverrides = Readonly<{
  put?: StoragePluginImplementation["put"];
}>;

const createFacade = (
  context: StorageOperationContext,
  archiveBytes: Uint8Array,
  overrides: FixtureOverrides = {},
) => {
  const contexts: StorageOperationContext[] = [];
  const deletedUris: string[] = [];
  const putBodies: Array<Uint8Array | ReadableStream<Uint8Array>> = [];
  const putKeys: string[] = [];
  const implementation: StoragePluginImplementation = {
    async delete(input) {
      contexts.push(input.context);
      deletedUris.push(input.storageUri);
      return { kind: "deleted" };
    },
    async get(input) {
      contexts.push(input.context);
      return {
        body: new Blob([archiveBytes]).stream(),
        kind: "found",
        metadata: { contentLength: archiveBytes.byteLength },
        storageUri: input.storageUri,
      };
    },
    async head() {
      return { kind: "not-found" };
    },
    async put(input) {
      if (overrides.put) {
        return overrides.put(input);
      }
      contexts.push(input.context);
      putBodies.push(input.body);
      putKeys.push(input.key);
      await new Response(input.body).arrayBuffer();
      return {
        kind: "stored",
        storageUri: `storage://bucket/${input.key}`,
      };
    },
  };
  const plugin = createStoragePlugin({
    name: "storage-v2",
    plugin: () => implementation,
    protocol: "storage",
  });
  return {
    contexts,
    deletedUris,
    facade: createNodeStoragePluginFacade(plugin, context),
    putBodies,
    putKeys,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("promoteBundle Storage V2 bridge", () => {
  it("streams copy I/O through the exact context and preserves URI layout", async () => {
    // Given
    const archive = await createArchive();
    const context: StorageOperationContext = Object.freeze({
      bindings: Object.freeze({ request: "promote" }),
      environment: Object.freeze({ REQUEST_ID: "promote" }),
      target: "node",
    });
    const fixture = createFacade(
      context,
      await fs.readFile(archive.archivePath),
    );
    const fetchFallback = vi.fn();
    vi.stubGlobal("fetch", fetchFallback);

    try {
      // When
      const result = await createCopiedBundleArchive({
        bundle: sourceBundle,
        config,
        nextBundleId: "copy-id",
        storagePlugin: fixture.facade,
        targetChannel: "beta",
      });

      // Then
      expect(fixture.contexts.every((value) => value === context)).toBe(true);
      expect(
        fixture.putBodies.every((body) => body instanceof ReadableStream),
      ).toBe(true);
      expect(fixture.putKeys).toEqual([
        "copy-id/bundle.zip",
        "copy-id/manifest.json",
        "copy-id/files/main.ios.bundle.br",
      ]);
      expect(result.bundle).toMatchObject({
        assetBaseStorageUri: "storage://bucket/copy-id/files",
        manifestStorageUri: "storage://bucket/copy-id/manifest.json",
        storageUri: "storage://bucket/copy-id/bundle.zip",
      });
      expect(fetchFallback).not.toHaveBeenCalled();
    } finally {
      await archive.cleanup();
    }
  });

  it.each([
    [
      "unsupported upload",
      new StoragePluginError("unsupported", "Upload is unsupported."),
      "unsupported",
    ],
    ["write abort", new DOMException("cancelled", "AbortError"), "aborted"],
  ] as const)(
    "preserves %s and removes workflow temp files",
    async (_name, failure, expectedCode) => {
      // Given
      const archive = await createArchive();
      const context: StorageOperationContext = {
        bindings: {},
        environment: {},
        target: "node",
      };
      let putCount = 0;
      const fixture = createFacade(
        context,
        await fs.readFile(archive.archivePath),
        {
          put: async (input) => {
            putCount += 1;
            if (putCount === 1 && expectedCode === "aborted") {
              return {
                kind: "stored",
                storageUri: `storage://bucket/${input.key}`,
              };
            }
            throw failure;
          },
        },
      );
      const createdDirectories: string[] = [];
      const originalMkdtemp = fs.mkdtemp.bind(fs);
      vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        const directory = await originalMkdtemp(...args);
        createdDirectories.push(directory);
        return directory;
      });

      try {
        // When
        const operation = createCopiedBundleArchive({
          bundle: sourceBundle,
          config,
          nextBundleId: "copy-id",
          storagePlugin: fixture.facade,
          targetChannel: "beta",
        });

        // Then
        await expect(operation).rejects.toMatchObject({ code: expectedCode });
        if (expectedCode === "aborted") {
          expect(fixture.deletedUris).toEqual([
            "storage://bucket/copy-id/bundle.zip",
          ]);
        }
        for (const directory of createdDirectories) {
          await expect(fs.stat(directory)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } finally {
        await archive.cleanup();
      }
    },
  );
});
