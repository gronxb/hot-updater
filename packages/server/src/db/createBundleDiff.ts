import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { createBrotliDecompress } from "node:zlib";

import { hdiff } from "@hot-updater/bsdiff";
import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestContentHash,
  getManifestStorageUri,
} from "@hot-updater/core";
import type { BundleManifest } from "@hot-updater/core";
import type {
  Bundle,
  BundlePatchPublishResult,
  BundlePatchRow,
  BundleRepository,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import {
  assertBundleArtifactByteSize,
  createBundleStorageKey,
  createDatabaseClient,
  DatabasePatchPublishUnsupportedError,
  getManifestAssetDownloadPath,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PATCHES,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";

import {
  readBoundedResponseBytes,
  ResponseBodyTooLargeError,
} from "../boundedResponseBody";
import {
  hasExplicitDownloadRepresentation,
  hasVerifiedDownloadRepresentation,
  hasVerifiedLogicalAsset,
  parseStoredBundleManifest,
} from "./bundleManifestValidation";

export interface CreateBundleDiffInput {
  baseBundleId: string;
  bundleId: string;
}

export interface CreateBundleDiffDependencies {
  databasePlugin: BundleRepository;
  storagePlugin: StoragePluginWith<"get" | "put" | "delete"> | null;
}

export interface CreateBundleDiffOptions {
  makePrimary?: boolean;
}

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

async function downloadFromUrl(url: string, maxBytes: number) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download storage object: ${response.status}`);
  }

  return readBoundedResponseBytes(response, maxBytes);
}

async function downloadStorageBytes(
  storageUri: string,
  storagePlugin: StoragePluginWith<"get" | "put" | "delete"> | null,
  maxBytes: number,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (!storagePlugin || storagePlugin.protocol !== protocol) {
    if (protocol === "http" || protocol === "https") {
      return downloadFromUrl(storageUri, maxBytes);
    }
    if (!storagePlugin) {
      throw new Error("Storage plugin is not configured");
    }
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  const { response } = await storagePlugin.get({ storageUri });
  if (response === null) {
    throw new Error(`Storage object not found: ${storageUri}`);
  }
  return readBoundedResponseBytes(response, maxBytes);
}

export const decompressBrotliBytes = async (
  bytes: Uint8Array,
  maxBytes = MAX_BUNDLE_ARTIFACT_BYTES,
): Promise<Uint8Array> => {
  const decompressor = Readable.from([bytes]).pipe(createBrotliDecompress());
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of decompressor) {
    const value = new Uint8Array(chunk);
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      decompressor.destroy();
      throw new ResponseBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

async function fetchManifest(
  bundle: Bundle,
  storagePlugin: StoragePluginWith<"get" | "put" | "delete"> | null,
): Promise<BundleManifest> {
  const manifestStorageUri = getManifestStorageUri(bundle);
  if (!manifestStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have manifest metadata`);
  }

  const manifestBytes = await downloadStorageBytes(
    manifestStorageUri,
    storagePlugin,
    MAX_BUNDLE_MANIFEST_BYTES,
  );

  const manifest = parseStoredBundleManifest({
    bundleId: bundle.id,
    manifestBytes,
    manifestContentHash: getManifestContentHash(bundle),
  });
  if (!manifest) {
    throw new Error(`Invalid manifest payload for bundle ${bundle.id}`);
  }

  return manifest;
}

function resolvePatchAssetPath(manifest: BundleManifest) {
  const assetPath = manifest.patchAssetPath;
  if (!assetPath || !Object.hasOwn(manifest.assets, assetPath)) {
    throw new Error("Manifest must name an existing patchAssetPath");
  }
  return assetPath;
}

async function fetchAssetBytes(
  bundle: Bundle,
  assetPath: string,
  manifest: BundleManifest,
  storagePlugin: StoragePluginWith<"get" | "put" | "delete"> | null,
) {
  const assetBaseStorageUri = getAssetBaseStorageUri(bundle);
  if (!assetBaseStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have asset storage metadata`);
  }
  const asset = manifest.assets[assetPath];
  if (!asset) {
    throw new Error(`Asset ${assetPath} is missing from manifest`);
  }

  if (asset.downloadCompression === undefined) {
    throw new Error(`Asset ${assetPath} does not declare downloadCompression`);
  }
  const downloadPath = getManifestAssetDownloadPath(
    assetPath,
    asset.downloadCompression,
  );
  const assetStorageUri = resolveManifestAssetStorageUri({
    assetBaseStorageUri,
    assetPath: downloadPath,
    downloadFileHash: asset.downloadFileHash,
    fileHash: asset.fileHash,
  });
  const bytes = await downloadStorageBytes(
    assetStorageUri,
    storagePlugin,
    MAX_BUNDLE_ARTIFACT_BYTES,
  );
  if (!hasVerifiedDownloadRepresentation(asset, bytes)) {
    throw new Error(`Invalid download representation for asset ${assetPath}`);
  }
  const logicalBytes =
    asset.downloadCompression === "br"
      ? await decompressBrotliBytes(bytes)
      : bytes;
  if (!hasVerifiedLogicalAsset(asset, logicalBytes)) {
    throw new Error(`Invalid logical bytes for asset ${assetPath}`);
  }
  return logicalBytes;
}

const patchRowToBundlePatch = (row: BundlePatchRow) => ({
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  byteSize: row.byte_size,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
});

export async function createBundleDiff(
  { baseBundleId, bundleId }: CreateBundleDiffInput,
  deps: CreateBundleDiffDependencies,
  options: CreateBundleDiffOptions = {},
) {
  const database = createDatabaseClient(deps.databasePlugin);
  const storagePlugin = deps.storagePlugin;

  if (!storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  if (baseBundleId === bundleId) {
    throw new Error("Base bundle must be different from the target bundle");
  }

  const baseBundle = await database.getBundleById(baseBundleId);
  const targetBundle = await database.getBundleById(bundleId);

  if (!baseBundle || !targetBundle) {
    throw new Error("Bundle not found");
  }

  if (baseBundle.platform !== targetBundle.platform) {
    throw new Error("Base bundle platform must match the target bundle");
  }

  if (
    !getBundlePatch(targetBundle, baseBundle.id) &&
    (targetBundle.patches?.length ?? 0) >= MAX_BUNDLE_PATCHES
  ) {
    throw new Error(
      `Target bundle cannot contain more than ${MAX_BUNDLE_PATCHES} patches`,
    );
  }

  const [baseManifest, targetManifest] = await Promise.all([
    fetchManifest(baseBundle, storagePlugin),
    fetchManifest(targetBundle, storagePlugin),
  ]);

  const baseAssetPath = resolvePatchAssetPath(baseManifest);
  const targetAssetPath = resolvePatchAssetPath(targetManifest);

  if (baseAssetPath !== targetAssetPath) {
    throw new Error("Base and target patchAssetPath values do not match");
  }

  const baseAssetHash = baseManifest.assets[baseAssetPath]?.fileHash;
  const targetAssetHash = targetManifest.assets[targetAssetPath]?.fileHash;

  if (!baseAssetHash || !targetAssetHash) {
    throw new Error("Patch asset hash is missing from manifest");
  }

  if (baseAssetHash === targetAssetHash) {
    throw new Error("Patch asset is unchanged; no diff patch is required");
  }

  for (const [assetPath, asset] of [
    [baseAssetPath, baseManifest.assets[baseAssetPath]],
    [targetAssetPath, targetManifest.assets[targetAssetPath]],
  ] as const) {
    if (!asset || !hasExplicitDownloadRepresentation(asset)) {
      throw new Error(
        `Asset ${assetPath} does not declare a verifiable download representation`,
      );
    }
  }

  const [baseBytes, targetBytes] = await Promise.all([
    fetchAssetBytes(baseBundle, baseAssetPath, baseManifest, storagePlugin),
    fetchAssetBytes(
      targetBundle,
      targetAssetPath,
      targetManifest,
      storagePlugin,
    ),
  ]);

  const patchBytes = await hdiff(baseBytes, targetBytes);
  const patchFilename = `${path.posix.basename(targetAssetPath)}.bsdiff`;
  assertBundleArtifactByteSize(patchBytes.byteLength, patchFilename);
  const patchFileHash = crypto
    .createHash("sha256")
    .update(patchBytes)
    .digest("hex");
  const uploadKey = createBundleStorageKey(
    targetBundle.id,
    "patches",
    baseBundle.id,
    patchFileHash,
    getRelativeStorageDir(targetAssetPath),
    patchFilename,
  );
  const patchUpload = await storagePlugin.put({
    key: uploadKey,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(patchBytes);
        controller.close();
      },
    }),
    contentLength: patchBytes.byteLength,
    contentType: "application/octet-stream",
  });

  const patchRow = {
    base_bundle_id: baseBundle.id,
    base_file_hash: baseAssetHash,
    bundle_id: targetBundle.id,
    byte_size: patchBytes.byteLength,
    id: `${targetBundle.id}:${baseBundle.id}`,
    patch_file_hash: patchFileHash,
    patch_storage_uri: patchUpload.storageUri,
  };
  const publish = deps.databasePlugin.models.bundlePatches.publish;
  if (!publish) {
    await storagePlugin.delete({ storageUri: patchUpload.storageUri });
    throw new DatabasePatchPublishUnsupportedError(deps.databasePlugin.name);
  }

  let publishResult: BundlePatchPublishResult;
  try {
    publishResult = await publish({
      position: options.makePrimary === false ? "last" : "primary",
      row: patchRow,
    });
  } catch (error) {
    const persistedTarget = await database.getBundleById(targetBundle.id);
    const persistedPatch = persistedTarget
      ? getBundlePatch(persistedTarget, baseBundle.id)
      : null;
    const persistedPatchIndex =
      persistedTarget?.patches?.findIndex(
        ({ baseBundleId }) => baseBundleId === baseBundle.id,
      ) ?? -1;
    const persistedPositionMatches =
      options.makePrimary === false
        ? persistedPatchIndex === (persistedTarget?.patches?.length ?? 0) - 1
        : persistedPatchIndex === 0;
    if (
      persistedTarget &&
      persistedPositionMatches &&
      persistedPatch?.baseFileHash === patchRow.base_file_hash &&
      persistedPatch.patchFileHash === patchRow.patch_file_hash &&
      persistedPatch.patchStorageUri === patchRow.patch_storage_uri
    ) {
      return persistedTarget;
    }
    throw error;
  }

  if (!publishResult.published) {
    await storagePlugin.delete({ storageUri: patchUpload.storageUri });
    throw new Error(
      publishResult.reason === "limit_exceeded"
        ? `Target bundle cannot contain more than ${MAX_BUNDLE_PATCHES} patches`
        : "Bundle not found",
    );
  }
  const updatedBundle: Bundle = {
    ...targetBundle,
    patches: publishResult.patches.map(patchRowToBundlePatch),
  };

  return updatedBundle;
}
