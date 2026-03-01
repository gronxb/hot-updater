import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hdiff } from "@hot-updater/bsdiff/node";
import type {
  AppUpdateInfo,
  Bundle,
  BundleIncrementalMetadata,
  GetBundlesArgs,
  IncrementalChangedAsset,
  IncrementalManifestEntry,
  IncrementalPatchCacheEntry,
  UpdateInfo,
} from "@hot-updater/core";

type UploadPatchArgs = {
  protocol: string;
  key: string;
  filePath: string;
};

type IncrementalDeps = {
  getUpdateInfo: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
  getBundleById: (bundleId: string) => Promise<Bundle | null>;
  updateBundleById: (
    bundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>;
  uploadPatch: (
    args: UploadPatchArgs,
  ) => Promise<{ storageUri: string } | null>;
  patchLocks: Map<string, Promise<IncrementalPatchCacheEntry | null>>;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isString = (value: unknown): value is string => {
  return typeof value === "string" && value.length > 0;
};

const isNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value);
};

const isManifestKind = (
  value: unknown,
): value is IncrementalManifestEntry["kind"] => {
  return value === "bundle" || value === "asset";
};

const toManifestEntry = (value: unknown): IncrementalManifestEntry | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const { path: filePath, hash, size, kind } = value;
  if (!isString(filePath) || !isString(hash) || !isNumber(size)) {
    return null;
  }
  if (!isManifestKind(kind)) {
    return null;
  }

  return {
    path: filePath,
    hash,
    size,
    kind,
  };
};

const toPatchCacheEntry = (
  value: unknown,
): IncrementalPatchCacheEntry | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const { storageUri, fileHash, size } = value;
  if (!isString(storageUri) || !isString(fileHash) || !isNumber(size)) {
    return null;
  }

  return {
    storageUri,
    fileHash,
    size,
  };
};

const toIncrementalMetadata = (
  bundle: Bundle | null,
): BundleIncrementalMetadata | null => {
  const incremental = bundle?.metadata?.incremental;
  if (!isObjectRecord(incremental)) {
    return null;
  }

  const bundleHash = incremental.bundleHash;
  if (!isString(bundleHash)) {
    return null;
  }

  const rawManifest = incremental.manifest;
  if (!Array.isArray(rawManifest)) {
    return null;
  }

  const manifest = rawManifest
    .map(toManifestEntry)
    .filter((entry): entry is IncrementalManifestEntry => entry !== null);

  if (manifest.length !== rawManifest.length) {
    return null;
  }

  const patchCache: Record<string, IncrementalPatchCacheEntry> = {};
  if (isObjectRecord(incremental.patchCache)) {
    for (const [baseBundleId, rawEntry] of Object.entries(
      incremental.patchCache,
    )) {
      const parsed = toPatchCacheEntry(rawEntry);
      if (parsed) {
        patchCache[baseBundleId] = parsed;
      }
    }
  }

  return {
    bundleHash,
    manifest,
    patchCache,
  };
};

const sha256Hex = (bytes: Uint8Array): string => {
  return createHash("sha256").update(bytes).digest("hex");
};

const storageProtocol = (storageUri: string): string | null => {
  try {
    return new URL(storageUri).protocol.replace(":", "");
  } catch {
    return null;
  }
};

const resolveStorageUriForPath = (
  bundleStorageUri: string,
  manifestPath: string,
): string | null => {
  try {
    const storageUrl = new URL(bundleStorageUri);
    const currentPath = storageUrl.pathname.replace(/^\/+/, "");
    const baseDir = currentPath.split("/").slice(0, -1).join("/");
    const normalizedManifestPath = manifestPath.replace(/^\/+/, "");
    const resolvedPath = [baseDir, normalizedManifestPath]
      .filter(Boolean)
      .join("/");
    if (!resolvedPath) {
      return null;
    }

    return `${storageUrl.protocol}//${storageUrl.host}/${resolvedPath}`;
  } catch {
    return null;
  }
};

const fetchStorageBytes = async (
  storageUri: string,
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>,
): Promise<Uint8Array | null> => {
  const fileUrl = await resolveFileUrl(storageUri);
  if (!fileUrl) {
    return null;
  }

  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      return null;
    }
    const bytes = await response.arrayBuffer();
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
};

const getBundleEntryFromManifest = (
  manifest: IncrementalManifestEntry[],
): IncrementalManifestEntry | null => {
  const bundleEntries = manifest.filter((entry) => entry.kind === "bundle");
  if (bundleEntries.length !== 1) {
    return null;
  }
  return bundleEntries[0] ?? null;
};

const compareHash = (left: string, right: string): boolean => {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
};

type GetPatchArgs = {
  baseBundleId: string;
  baseBundle: Bundle;
  targetBundle: Bundle;
  targetMetadata: BundleIncrementalMetadata;
  deps: IncrementalDeps;
};

const buildAndUploadPatch = async ({
  baseBundleId,
  baseBundle,
  targetBundle,
  targetMetadata,
  deps,
}: GetPatchArgs): Promise<IncrementalPatchCacheEntry | null> => {
  const targetStorageUri = targetBundle.storageUri;
  const baseStorageUri = baseBundle.storageUri;
  if (!targetStorageUri || !baseStorageUri) {
    return null;
  }

  const protocol = storageProtocol(targetStorageUri);
  if (!protocol) {
    return null;
  }

  const [baseBytes, targetBytes] = await Promise.all([
    fetchStorageBytes(baseStorageUri, deps.resolveFileUrl),
    fetchStorageBytes(targetStorageUri, deps.resolveFileUrl),
  ]);
  if (!baseBytes || !targetBytes) {
    return null;
  }

  let patchBytes: Uint8Array;
  try {
    patchBytes = await hdiff(baseBytes, targetBytes);
  } catch {
    return null;
  }

  const patchFileHash = sha256Hex(patchBytes);
  const tempDir = await mkdtemp(path.join(tmpdir(), "hot-updater-patch-"));
  const patchFilePath = path.join(tempDir, `${baseBundleId}.patch`);

  try {
    await writeFile(patchFilePath, patchBytes);
    const uploadResult = await deps.uploadPatch({
      protocol,
      key: `${targetBundle.id}/.patches`,
      filePath: patchFilePath,
    });
    if (!uploadResult?.storageUri) {
      return null;
    }

    const entry: IncrementalPatchCacheEntry = {
      storageUri: uploadResult.storageUri,
      fileHash: patchFileHash,
      size: patchBytes.byteLength,
    };

    const nextPatchCache = {
      ...(targetMetadata.patchCache ?? {}),
      [baseBundleId]: entry,
    };

    await deps.updateBundleById(targetBundle.id, {
      metadata: {
        ...(targetBundle.metadata ?? {}),
        incremental: {
          ...targetMetadata,
          patchCache: nextPatchCache,
        },
      },
    });

    return entry;
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const getOrCreatePatch = async (
  args: GetPatchArgs,
): Promise<IncrementalPatchCacheEntry | null> => {
  const cacheEntry = args.targetMetadata.patchCache?.[args.baseBundleId];
  if (cacheEntry) {
    return cacheEntry;
  }

  const lockKey = `${args.targetBundle.id}:${args.baseBundleId}`;
  const inFlight = args.deps.patchLocks.get(lockKey);
  if (inFlight) {
    return await inFlight;
  }

  const patchPromise = buildAndUploadPatch(args);
  args.deps.patchLocks.set(lockKey, patchPromise);
  try {
    return await patchPromise;
  } finally {
    args.deps.patchLocks.delete(lockKey);
  }
};

type ChangedAssetsArgs = {
  baseManifest: IncrementalManifestEntry[];
  targetManifest: IncrementalManifestEntry[];
  targetStorageUri: string;
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>;
};

const buildChangedAssets = async ({
  baseManifest,
  targetManifest,
  targetStorageUri,
  resolveFileUrl,
}: ChangedAssetsArgs): Promise<IncrementalChangedAsset[] | null> => {
  const baseAssetHashByPath = new Map<string, string>();
  for (const entry of baseManifest) {
    if (entry.kind === "asset") {
      baseAssetHashByPath.set(entry.path, entry.hash);
    }
  }

  const changedTargetAssets = targetManifest.filter((entry) => {
    if (entry.kind !== "asset") {
      return false;
    }
    const baseHash = baseAssetHashByPath.get(entry.path);
    return !baseHash || !compareHash(baseHash, entry.hash);
  });

  const changedAssets: IncrementalChangedAsset[] = [];
  for (const asset of changedTargetAssets) {
    const assetStorageUri = resolveStorageUriForPath(
      targetStorageUri,
      asset.path,
    );
    if (!assetStorageUri) {
      return null;
    }
    const fileUrl = await resolveFileUrl(assetStorageUri);
    if (!fileUrl) {
      return null;
    }
    changedAssets.push({
      path: asset.path,
      fileUrl,
      hash: asset.hash,
      size: asset.size,
    });
  }

  return changedAssets;
};

export async function buildIncrementalAppUpdateInfo(
  args: GetBundlesArgs,
  deps: IncrementalDeps,
): Promise<AppUpdateInfo | null> {
  if (args.currentHash === null || args.currentHash === undefined) {
    return null;
  }

  const updateInfo = await deps.getUpdateInfo(args);
  if (!updateInfo) {
    return null;
  }

  const [baseBundle, targetBundle] = await Promise.all([
    deps.getBundleById(args.bundleId),
    deps.getBundleById(updateInfo.id),
  ]);
  if (!baseBundle || !targetBundle) {
    return null;
  }

  const baseMetadata = toIncrementalMetadata(baseBundle);
  const targetMetadata = toIncrementalMetadata(targetBundle);
  if (!baseMetadata || !targetMetadata) {
    return null;
  }

  const baseBundleEntry = getBundleEntryFromManifest(baseMetadata.manifest);
  const targetBundleEntry = getBundleEntryFromManifest(targetMetadata.manifest);
  if (!baseBundleEntry || !targetBundleEntry) {
    return null;
  }
  if (
    !compareHash(baseBundleEntry.hash, baseMetadata.bundleHash) ||
    !compareHash(targetBundleEntry.hash, targetMetadata.bundleHash)
  ) {
    return null;
  }

  if (!compareHash(args.currentHash, baseMetadata.bundleHash)) {
    return null;
  }

  const bundlePath = targetBundleEntry.path;

  const patchEntry = await getOrCreatePatch({
    baseBundleId: baseBundle.id,
    baseBundle,
    targetBundle,
    targetMetadata,
    deps,
  });
  if (!patchEntry) {
    return null;
  }

  const patchFileUrl = await deps.resolveFileUrl(patchEntry.storageUri);
  if (!patchFileUrl) {
    return null;
  }

  const targetStorageUri = targetBundle.storageUri;
  if (!targetStorageUri) {
    return null;
  }

  const changedAssets = await buildChangedAssets({
    baseManifest: baseMetadata.manifest,
    targetManifest: targetMetadata.manifest,
    targetStorageUri,
    resolveFileUrl: deps.resolveFileUrl,
  });
  if (!changedAssets) {
    return null;
  }

  const fileUrl = await deps.resolveFileUrl(updateInfo.storageUri ?? null);

  return {
    id: updateInfo.id,
    shouldForceUpdate: updateInfo.shouldForceUpdate,
    message: updateInfo.message,
    status: updateInfo.status,
    fileHash: updateInfo.fileHash,
    fileUrl,
    incremental: {
      protocol: "bsdiff-v1",
      baseBundleId: baseBundle.id,
      baseBundleHash: baseMetadata.bundleHash,
      bundlePath,
      patch: {
        fileUrl: patchFileUrl,
        fileHash: patchEntry.fileHash,
        size: patchEntry.size,
      },
      manifest: targetMetadata.manifest,
      changedAssets,
    },
  };
}
