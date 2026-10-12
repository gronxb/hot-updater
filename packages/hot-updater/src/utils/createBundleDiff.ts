import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { createBrotliDecompress } from "node:zlib";

import { bsdiff } from "@hot-updater/bsdiff";
import type {
  Bundle,
  HotUpdaterCoreApi,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  assertBundleArtifactByteSize,
  hasExplicitDownloadRepresentation,
  hasVerifiedDownloadRepresentation,
  hasVerifiedLogicalAsset,
  parseStoredBundleManifest,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PATCHES,
  createBundleStorageKey,
  getManifestAssetDownloadPath,
  resolveManifestAssetStorageUri,
  rowToBundle,
} from "@hot-updater/plugin-core";
import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getManifestStorageUri,
  getManifestContentHash,
  type BundleManifest,
} from "@hot-updater/protocol";

export interface CreateBundleDiffInput {
  baseBundleId: string;
  bundleId: string;
}

export interface CreateBundleDiffDependencies {
  /** Core's API: assembled over the config's database, or a self-hosted server's admin API. */
  core: Pick<HotUpdaterCoreApi, "getBundle" | "updateBundle">;
  storageAdapter: StorageAdapterWith<"get" | "put" | "delete"> | null;
}

export interface CreateBundleDiffOptions {
  makePrimary?: boolean;
}

import {
  readBoundedResponseBytes,
  ResponseBodyTooLargeError,
} from "./boundedResponseBody";

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
  storageAdapter: StorageAdapterWith<"get" | "put" | "delete"> | null,
  maxBytes: number,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (!storageAdapter || storageAdapter.protocol !== protocol) {
    if (protocol === "http" || protocol === "https") {
      return downloadFromUrl(storageUri, maxBytes);
    }
    if (!storageAdapter) {
      throw new Error("Storage adapter is not configured");
    }
    throw new Error(`No storage adapter for protocol: ${protocol}`);
  }

  const { response } = await storageAdapter.get({ storageUri });
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
  storageAdapter: StorageAdapterWith<"get" | "put" | "delete"> | null,
): Promise<BundleManifest> {
  const manifestStorageUri = getManifestStorageUri(bundle);
  if (!manifestStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have manifest metadata`);
  }

  const manifestBytes = await downloadStorageBytes(
    manifestStorageUri,
    storageAdapter,
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
  storageAdapter: StorageAdapterWith<"get" | "put" | "delete"> | null,
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
    storageAdapter,
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

export async function createBundleDiff(
  { baseBundleId, bundleId }: CreateBundleDiffInput,
  deps: CreateBundleDiffDependencies,
  options: CreateBundleDiffOptions = {},
) {
  const { core } = deps;

  if (!deps.storageAdapter) {
    throw new Error("Storage adapter is not configured");
  }

  if (baseBundleId === bundleId) {
    throw new Error("Base bundle must be different from the target bundle");
  }

  const [baseBundle, targetBundle] = (
    await Promise.all([core.getBundle(baseBundleId), core.getBundle(bundleId)])
  ).map((detail) =>
    detail === null ? null : rowToBundle(detail.bundle, detail.patches),
  );

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
    fetchManifest(baseBundle, deps.storageAdapter),
    fetchManifest(targetBundle, deps.storageAdapter),
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
    fetchAssetBytes(
      baseBundle,
      baseAssetPath,
      baseManifest,
      deps.storageAdapter,
    ),
    fetchAssetBytes(
      targetBundle,
      targetAssetPath,
      targetManifest,
      deps.storageAdapter,
    ),
  ]);

  const patchBytes = await bsdiff(baseBytes, targetBytes);
  assertBundleArtifactByteSize(patchBytes.byteLength, targetAssetPath);
  const patchFileHash = crypto
    .createHash("sha256")
    .update(patchBytes)
    .digest("hex");
  const patchFilename = `${path.posix.basename(targetAssetPath)}.bsdiff`;

  const uploadKey = createBundleStorageKey(
    targetBundle.id,
    "patches",
    baseBundle.id,
    patchFileHash,
    getRelativeStorageDir(targetAssetPath),
    patchFilename,
  );
  const patchUpload = await deps.storageAdapter.put({
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

  const nextPatch = {
    baseBundleId: baseBundle.id,
    baseFileHash: baseAssetHash,
    byteSize: patchBytes.byteLength,
    patchFileHash,
    patchStorageUri: patchUpload.storageUri,
  };
  await core.updateBundle(targetBundle.id, {
    upsertPatch: {
      artifact: nextPatch,
      position: options.makePrimary === false ? "last" : "first",
    },
  });
  const committed = await core.getBundle(targetBundle.id);
  const updatedBundle =
    committed && rowToBundle(committed.bundle, committed.patches);
  if (
    !updatedBundle ||
    getBundlePatch(updatedBundle, baseBundle.id)?.patchStorageUri !==
      patchUpload.storageUri
  ) {
    throw new Error("Patch publication could not be confirmed");
  }
  // Neither an ambiguous commit nor replacement proves an object is unreferenced.
  return updatedBundle;
}
