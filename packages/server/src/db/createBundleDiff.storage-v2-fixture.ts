import { brotliCompressSync } from "node:zlib";

import type {
  Bundle,
  DatabasePlugin,
  StorageOperationContext,
} from "@hot-updater/plugin-core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import {
  createStoragePlugin,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";
import {
  createNodeStoragePluginFacade,
  type BorrowedNodeStoragePlugin,
} from "@hot-updater/plugin-core/storage/node";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createBundleDiff } from "./createBundleDiff";

export const baseId = "00000000-0000-0000-0000-000000000001";
export const targetId = "00000000-0000-0000-0000-000000000002";

export const createBundle = (
  id: string,
  overrides: Partial<Bundle> = {},
): Bundle => ({
  assetBaseStorageUri: `s3://test-bucket/releases/${id}/files`,
  channel: "production",
  enabled: true,
  fileHash: `${id}-file-hash`,
  fingerprintHash: null,
  gitCommitHash: null,
  id,
  manifestStorageUri: `s3://test-bucket/releases/${id}/manifest.json`,
  message: id,
  metadata: {},
  platform: "ios",
  shouldForceUpdate: false,
  storageUri: `s3://test-bucket/releases/${id}/bundle.zip`,
  targetAppVersion: "1.0.0",
  ...overrides,
});

export const createDatabasePlugin = async (
  bundles: readonly Bundle[],
): Promise<DatabasePlugin> => {
  const plugin = createInMemoryDatabasePlugin();
  const database = createDatabaseClient(plugin);
  for (const bundle of bundles) {
    await database.insertBundle(bundle);
  }
  return plugin;
};

export const createObjects = () => {
  const manifest = (bundleId: string, fileHash: string) =>
    new TextEncoder().encode(
      JSON.stringify({
        assets: { "index.ios.bundle": { fileHash } },
        bundleId,
      }),
    );

  return new Map<string, Uint8Array>([
    [
      `s3://test-bucket/releases/${baseId}/manifest.json`,
      manifest(baseId, "old"),
    ],
    [
      `s3://test-bucket/releases/${targetId}/manifest.json`,
      manifest(targetId, "new"),
    ],
    [
      `s3://test-bucket/releases/${baseId}/files/index.ios.bundle.br`,
      brotliCompressSync(new Uint8Array([1, 2, 3])),
    ],
    [
      `s3://test-bucket/releases/${targetId}/files/index.ios.bundle.br`,
      brotliCompressSync(new Uint8Array([1, 9, 3])),
    ],
  ]);
};

type FixtureOverrides = Readonly<{
  get?: StoragePluginImplementation["get"];
  put?: StoragePluginImplementation["put"];
}>;

export const createFacade = (
  context: StorageOperationContext,
  objects: ReadonlyMap<string, Uint8Array>,
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
      if (overrides.get) {
        return overrides.get(input);
      }
      contexts.push(input.context);
      const bytes = objects.get(input.storageUri);
      if (!bytes) {
        return { kind: "not-found" };
      }
      return {
        body: new Blob([bytes]).stream(),
        kind: "found",
        metadata: { contentLength: bytes.byteLength },
        storageUri: input.storageUri,
      };
    },
    async head(input) {
      contexts.push(input.context);
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
        storageUri: `s3://test-bucket/${input.key}`,
      };
    },
  };
  const plugin = createStoragePlugin({
    name: "storage-v2",
    plugin: () => implementation,
    protocol: "s3",
  });

  return {
    contexts,
    deletedUris,
    facade: createNodeStoragePluginFacade(plugin, context),
    putBodies,
    putKeys,
  };
};

export const runDiff = async (
  storagePlugin: BorrowedNodeStoragePlugin,
  targetOverrides: Partial<Bundle> = {},
) => {
  const databasePlugin = await createDatabasePlugin([
    createBundle(baseId),
    createBundle(targetId, targetOverrides),
  ]);
  return {
    databasePlugin,
    result: await createBundleDiff(
      { baseBundleId: baseId, bundleId: targetId },
      { databasePlugin, storagePlugin },
    ),
  };
};
