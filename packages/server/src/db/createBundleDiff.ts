import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";

import { hdiff } from "@hot-updater/bsdiff";
import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getBundlePatches,
  getManifestStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  BundleRepository,
  StoragePluginWith,
} from "@hot-updater/plugin-core";
import {
  createDatabaseClient,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";

type BundleManifest = {
  bundleId: string;
  assets: Record<string, { fileHash: string; signature?: string }>;
};

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

const HBC_ASSET_PATH_RE = /\.bundle$/;
const BR_COMPRESSED_ASSET_PATH_RE = /(^|\/)index\.[^/]+\.bundle$/;
const decompressBrotli = promisify(brotliDecompress);

const isBundleManifest = (value: unknown): value is BundleManifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const manifest = value as {
    bundleId?: unknown;
    assets?: unknown;
  };

  if (typeof manifest.bundleId !== "string") {
    return false;
  }

  if (!manifest.assets || typeof manifest.assets !== "object") {
    return false;
  }

  return Object.values(manifest.assets as Record<string, unknown>).every(
    (asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        return false;
      }

      const manifestAsset = asset as {
        fileHash?: unknown;
        signature?: unknown;
      };

      return (
        typeof manifestAsset.fileHash === "string" &&
        (manifestAsset.signature === undefined ||
          typeof manifestAsset.signature === "string")
      );
    },
  );
};

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

async function downloadFromUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download storage object: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function downloadStorageBytes(
  storageUri: string,
  storagePlugin: StoragePluginWith<"get" | "put" | "delete"> | null,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return downloadFromUrl(storageUri);
  }

  if (!storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  if (storagePlugin.protocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  const { response } = await storagePlugin.get({ storageUri });
  if (response === null) {
    throw new Error(`Storage object not found: ${storageUri}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

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
  );

  const payload: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (!isBundleManifest(payload)) {
    throw new Error(`Invalid manifest payload for bundle ${bundle.id}`);
  }

  return payload;
}

function resolveHbcAssetPath(manifest: BundleManifest) {
  const candidates = Object.keys(manifest.assets)
    .sort((left, right) => left.localeCompare(right))
    .filter((candidate) => HBC_ASSET_PATH_RE.test(candidate));

  if (candidates.length === 0) {
    throw new Error("No Hermes bundle asset found in manifest");
  }
  if (candidates.length > 1) {
    throw new Error(
      `Expected exactly one Hermes bundle asset in manifest, found ${candidates.length}: ${candidates.join(", ")}`,
    );
  }

  return candidates[0];
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

  if (BR_COMPRESSED_ASSET_PATH_RE.test(assetPath)) {
    const compressedAssetStorageUri = resolveManifestAssetStorageUri({
      assetBaseStorageUri,
      assetPath: `${assetPath}.br`,
      fileHash: asset.fileHash,
    });

    let compressedBytes: Uint8Array | null = null;
    try {
      compressedBytes = await downloadStorageBytes(
        compressedAssetStorageUri,
        storagePlugin,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      compressedBytes = null;
    }

    if (compressedBytes) {
      return new Uint8Array(await decompressBrotli(compressedBytes));
    }
  }

  const assetStorageUri = resolveManifestAssetStorageUri({
    assetBaseStorageUri,
    assetPath,
    fileHash: asset.fileHash,
  });
  return downloadStorageBytes(assetStorageUri, storagePlugin);
}

function buildNextPatchState({
  currentBundle,
  nextPatch,
  makePrimary,
}: {
  currentBundle: Bundle;
  nextPatch: NonNullable<ReturnType<typeof getBundlePatch>>;
  makePrimary: boolean;
}) {
  const existingPatches = getBundlePatches(currentBundle).filter(
    (patch) => patch.baseBundleId !== nextPatch.baseBundleId,
  );
  const orderedPatches = makePrimary
    ? [nextPatch, ...existingPatches]
    : [...existingPatches, nextPatch];
  const primaryPatch = orderedPatches[0] ?? nextPatch;

  return {
    patches: orderedPatches,
    primaryPatch,
  };
}

export async function createBundleDiff(
  { baseBundleId, bundleId }: CreateBundleDiffInput,
  deps: CreateBundleDiffDependencies,
  options: CreateBundleDiffOptions = {},
) {
  const database = createDatabaseClient(deps.databasePlugin);

  if (!deps.storagePlugin) {
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

  if (baseBundle.id.localeCompare(targetBundle.id) >= 0) {
    throw new Error("Base bundle must be older than the target bundle");
  }

  const [baseManifest, targetManifest] = await Promise.all([
    fetchManifest(baseBundle, deps.storagePlugin),
    fetchManifest(targetBundle, deps.storagePlugin),
  ]);

  const baseAssetPath = resolveHbcAssetPath(baseManifest);
  const targetAssetPath = resolveHbcAssetPath(targetManifest);

  if (baseAssetPath !== targetAssetPath) {
    throw new Error("Base and target Hermes asset paths do not match");
  }

  const baseAssetHash = baseManifest.assets[baseAssetPath]?.fileHash;
  const targetAssetHash = targetManifest.assets[targetAssetPath]?.fileHash;

  if (!baseAssetHash || !targetAssetHash) {
    throw new Error("Hermes asset hash is missing from manifest");
  }

  if (baseAssetHash === targetAssetHash) {
    throw new Error("Hermes bundle is unchanged; no diff patch is required");
  }

  const [baseBytes, targetBytes] = await Promise.all([
    fetchAssetBytes(
      baseBundle,
      baseAssetPath,
      baseManifest,
      deps.storagePlugin,
    ),
    fetchAssetBytes(
      targetBundle,
      targetAssetPath,
      targetManifest,
      deps.storagePlugin,
    ),
  ]);

  const patchBytes = await hdiff(baseBytes, targetBytes);
  const patchFilename = `${path.posix.basename(targetAssetPath)}.bsdiff`;
  const previousPatch = getBundlePatch(targetBundle, baseBundle.id);

  const uploadKey = [
    targetBundle.id,
    "patches",
    baseBundle.id,
    getRelativeStorageDir(targetAssetPath),
    patchFilename,
  ]
    .filter(Boolean)
    .join("/");
  const patchUpload = await deps.storagePlugin.put({
    key: uploadKey,
    body: patchBytes,
    contentType: "application/octet-stream",
  });
  const patchFileHash = crypto
    .createHash("sha256")
    .update(patchBytes)
    .digest("hex");

  const nextPatch = {
    baseBundleId: baseBundle.id,
    baseFileHash: baseAssetHash,
    patchFileHash,
    patchStorageUri: patchUpload.storageUri,
  };
  const nextState = buildNextPatchState({
    currentBundle: targetBundle,
    nextPatch,
    makePrimary: options.makePrimary ?? true,
  });

  const updatedBundle: Bundle = {
    ...targetBundle,
    patches: nextState.patches,
    patchBaseBundleId: nextState.primaryPatch.baseBundleId,
    patchBaseFileHash: nextState.primaryPatch.baseFileHash,
    patchFileHash: nextState.primaryPatch.patchFileHash,
    patchStorageUri: nextState.primaryPatch.patchStorageUri,
  };
  await database.updateBundleById(targetBundle.id, updatedBundle);

  if (
    previousPatch?.patchStorageUri &&
    previousPatch.patchStorageUri !== patchUpload.storageUri
  ) {
    await deps.storagePlugin
      .delete({ storageUri: previousPatch.patchStorageUri })
      .catch(() => {
        return;
      });
  }

  return updatedBundle;
}
