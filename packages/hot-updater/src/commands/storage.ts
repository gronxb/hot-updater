import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabasePlugin,
  NodeStoragePlugin,
  StorageObject,
} from "@hot-updater/plugin-core";
import {
  assertNodeStoragePlugin,
  BUNDLE_STORAGE_PREFIX,
  getManifestAssetDownloadPath,
  isContentAddressedAssetBaseStorageUri,
  resolveManifestAssetStorageUri,
} from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";

const BUNDLE_PAGE_SIZE = 10_000;
const STANDALONE_BUNDLE_PAGE_SIZE = 100;
const STANDALONE_DATABASE_NAME = "standalone-repository";
const MANIFEST_READ_CONCURRENCY = 4;
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_ADDRESSED_ASSET_KEY_RE =
  /^assets\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}(?:\.[^/]+)?$/i;

export const DEFAULT_STORAGE_PRUNE_PROTECTION_MS = 24 * 60 * 60 * 1000;

export interface StoragePruneOptions {
  dryRun?: boolean;
  protectNewerThan?: number;
  yes?: boolean;
}

interface BundleManifest {
  bundleId: string;
  assets: Record<string, { fileHash: string }>;
}

interface BundleStorageReferences {
  exactUris: ReadonlySet<string>;
  prefixUris: readonly string[];
}

interface PruneCandidate extends StorageObject {
  reason: "asset" | "bundle";
}

export function parseStoragePruneProtection(value: string): number {
  const match = value.trim().match(/^(\d+)(m|h|d|w)$/i);
  if (!match) {
    throw new Error("must use a duration such as 30m, 24h, or 7d");
  }

  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit === "m"
      ? 60 * 1000
      : unit === "h"
        ? 60 * 60 * 1000
        : unit === "d"
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;

  return amount * multiplier;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDuration(value: number): string {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (value % day === 0) {
    return `${value / day}d`;
  }
  if (value % hour === 0) {
    return `${value / hour}h`;
  }
  return `${value / (60 * 1000)}m`;
}

type PruneCandidateColumn = "key" | "modified" | "size" | "type";

const PRUNE_CANDIDATE_COLUMNS = [
  { key: "type", label: "Type" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Modified", format: ui.muted },
  { key: "key", label: "Key", format: ui.path },
] as const satisfies readonly {
  key: PruneCandidateColumn;
  label: string;
  format?: (value: string) => string;
}[];

function formatPruneCandidateTable(candidates: readonly PruneCandidate[]) {
  const rows: Record<PruneCandidateColumn, string>[] = candidates.map(
    (candidate) => ({
      key: candidate.key,
      modified: candidate.lastModifiedAt?.toISOString() ?? "-",
      size: formatBytes(candidate.size),
      type: candidate.reason === "asset" ? "shared asset" : "bundle data",
    }),
  );

  return ui.table(PRUNE_CANDIDATE_COLUMNS, rows);
}

function normalizeStorageUri(storageUri: string): string {
  return new URL(storageUri).toString();
}

function isLegacyBundleArtifactPath(segments: readonly string[]) {
  const [firstSegment] = segments;
  return (
    firstSegment === "manifest.json" ||
    firstSegment === "files" ||
    firstSegment === "patches" ||
    (firstSegment !== undefined && /^bundle(?:\..+)?$/.test(firstSegment))
  );
}

function getBundleIdFromStorageKey(key: string): string | null {
  const segments = key.split("/").filter(Boolean);
  if (segments[0] === BUNDLE_STORAGE_PREFIX) {
    const bundleId = segments[1];
    return bundleId && UUID_V7_RE.test(bundleId)
      ? bundleId.toLowerCase()
      : null;
  }

  const bundleId = segments[0];
  return bundleId &&
    UUID_V7_RE.test(bundleId) &&
    isLegacyBundleArtifactPath(segments.slice(1))
    ? bundleId.toLowerCase()
    : null;
}

function isBundleManifest(
  value: unknown,
  bundleId: string,
): value is BundleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { assets?: unknown; bundleId?: unknown };
  if (candidate.bundleId !== bundleId) {
    return false;
  }

  const assets = candidate.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
    return false;
  }

  return Object.values(assets as Record<string, unknown>).every((asset) => {
    return (
      asset !== null &&
      typeof asset === "object" &&
      !Array.isArray(asset) &&
      typeof (asset as { fileHash?: unknown }).fileHash === "string" &&
      /^[0-9a-f]{64}$/i.test((asset as { fileHash: string }).fileHash)
    );
  });
}

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value === undefined) {
          return;
        }
        await callback(value, index);
      }
    },
  );

  const results = await Promise.allSettled(workers);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

async function loadAllBundles(databasePlugin: DatabasePlugin) {
  const bundles: Bundle[] = [];
  const seenCursors = new Set<string>();
  const pageSize =
    databasePlugin.name === STANDALONE_DATABASE_NAME
      ? STANDALONE_BUNDLE_PAGE_SIZE
      : BUNDLE_PAGE_SIZE;
  let after: string | undefined;

  while (true) {
    const { data, pagination } = await databasePlugin.getBundles({
      cursor: after ? { after } : undefined,
      limit: pageSize,
      orderBy: { direction: "desc", field: "id" },
    });
    bundles.push(...data);

    const nextCursor = pagination.nextCursor ?? undefined;
    if (pagination.hasNextPage && !nextCursor) {
      throw new Error(
        "Database cannot provide safe cursor pagination for storage prune.",
      );
    }
    if (!nextCursor) {
      return bundles;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Database returned a repeated cursor: ${nextCursor}`);
    }

    seenCursors.add(nextCursor);
    after = nextCursor;
  }
}

async function readManifest(
  bundle: Bundle,
  storagePlugin: NodeStoragePlugin,
  workDir: string,
  index: number,
): Promise<BundleManifest> {
  const manifestStorageUri = getManifestStorageUri(bundle);
  if (!manifestStorageUri) {
    throw new Error(
      `Cannot prune shared assets: bundle ${bundle.id} has no manifest URI.`,
    );
  }

  const protocol = new URL(manifestStorageUri).protocol.replace(":", "");
  let manifestText: string;
  if (protocol === "http" || protocol === "https") {
    const response = await fetch(manifestStorageUri);
    if (!response.ok) {
      throw new Error(
        `Cannot prune shared assets: failed to read manifest for bundle ${bundle.id}.`,
      );
    }
    manifestText = await response.text();
  } else {
    if (protocol !== storagePlugin.supportedProtocol) {
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }

    const manifestPath = path.join(workDir, `${index}.json`);
    try {
      await storagePlugin.profiles.node.downloadFile(
        manifestStorageUri,
        manifestPath,
      );
      manifestText = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      throw new Error(
        `Cannot prune shared assets: failed to read manifest for bundle ${bundle.id}.`,
        { cause: error },
      );
    }
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot prune shared assets: invalid manifest for bundle ${bundle.id}.`,
      { cause: error },
    );
  }

  if (!isBundleManifest(manifest, bundle.id)) {
    throw new Error(
      `Cannot prune shared assets: invalid manifest for bundle ${bundle.id}.`,
    );
  }

  return manifest;
}

async function collectReferencedAssetUris(
  bundles: readonly Bundle[],
  storagePlugin: NodeStoragePlugin,
) {
  const bundlesWithSharedAssets = bundles.filter((bundle) => {
    const assetBaseStorageUri = getAssetBaseStorageUri(bundle);
    if (
      assetBaseStorageUri === null ||
      !isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)
    ) {
      return false;
    }

    const protocol = new URL(assetBaseStorageUri).protocol.replace(":", "");
    if (protocol !== storagePlugin.supportedProtocol) {
      throw new Error(
        `Cannot prune shared assets: bundle ${bundle.id} uses ${protocol} asset storage, but the configured storage plugin uses ${storagePlugin.supportedProtocol}.`,
      );
    }
    return true;
  });
  const referencedUris = new Set<string>();

  if (bundlesWithSharedAssets.length === 0) {
    return { manifestCount: 0, referencedUris };
  }

  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-storage-prune-"),
  );
  try {
    await forEachWithConcurrency(
      bundlesWithSharedAssets,
      MANIFEST_READ_CONCURRENCY,
      async (bundle, index) => {
        const assetBaseStorageUri = getAssetBaseStorageUri(bundle)!;
        const manifest = await readManifest(
          bundle,
          storagePlugin,
          workDir,
          index,
        );

        for (const [assetPath, asset] of Object.entries(manifest.assets)) {
          const downloadPath = getManifestAssetDownloadPath(assetPath);
          referencedUris.add(
            normalizeStorageUri(
              resolveManifestAssetStorageUri({
                assetBaseStorageUri,
                assetPath: downloadPath,
                fileHash: asset.fileHash,
              }),
            ),
          );
        }
      },
    );
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }

  return {
    manifestCount: bundlesWithSharedAssets.length,
    referencedUris,
  };
}

function collectBundleStorageReferences(
  bundles: readonly Bundle[],
): BundleStorageReferences {
  const exactUris = new Set<string>();
  const prefixUris = new Set<string>();
  const addExactUri = (storageUri: string | null | undefined) => {
    if (storageUri) {
      exactUris.add(normalizeStorageUri(storageUri));
    }
  };

  for (const bundle of bundles) {
    addExactUri(bundle.storageUri);
    addExactUri(getManifestStorageUri(bundle));
    addExactUri(getPatchStorageUri(bundle));
    for (const patch of getBundlePatches(bundle)) {
      addExactUri(patch.patchStorageUri);
    }

    const assetBaseStorageUri = getAssetBaseStorageUri(bundle);
    if (
      assetBaseStorageUri &&
      !isContentAddressedAssetBaseStorageUri(assetBaseStorageUri)
    ) {
      prefixUris.add(
        `${normalizeStorageUri(assetBaseStorageUri).replace(/\/+$/, "")}/`,
      );
    }
  }

  return { exactUris, prefixUris: [...prefixUris] };
}

function getPruneCandidates({
  bundleStorageReferences,
  objects,
  liveBundleIds,
  referencedAssetUris,
}: {
  bundleStorageReferences: BundleStorageReferences;
  objects: readonly StorageObject[];
  liveBundleIds: ReadonlySet<string>;
  referencedAssetUris: ReadonlySet<string>;
}): PruneCandidate[] {
  const candidates: PruneCandidate[] = [];

  for (const object of objects) {
    const normalizedStorageUri = normalizeStorageUri(object.storageUri);
    if (
      bundleStorageReferences.exactUris.has(normalizedStorageUri) ||
      bundleStorageReferences.prefixUris.some((prefix) =>
        normalizedStorageUri.startsWith(prefix),
      )
    ) {
      continue;
    }

    const bundleId = getBundleIdFromStorageKey(object.key);
    if (bundleId && !liveBundleIds.has(bundleId)) {
      candidates.push({ ...object, reason: "bundle" });
      continue;
    }

    if (
      CONTENT_ADDRESSED_ASSET_KEY_RE.test(object.key) &&
      !referencedAssetUris.has(normalizedStorageUri)
    ) {
      candidates.push({ ...object, reason: "asset" });
    }
  }

  return candidates;
}

async function safeOnUnmount(databasePlugin: DatabasePlugin) {
  try {
    await databasePlugin.onUnmount?.();
  } catch (error) {
    p.log.warn(
      `Database plugin onUnmount failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleStoragePrune(options: StoragePruneOptions = {}) {
  printBanner();

  if (options.dryRun && options.yes) {
    throw new Error("Storage prune --dry-run cannot be used with --yes.");
  }

  const protectNewerThan =
    options.protectNewerThan ?? DEFAULT_STORAGE_PRUNE_PROTECTION_MS;
  if (!Number.isFinite(protectNewerThan) || protectNewerThan < 0) {
    throw new Error(
      "Storage prune protection must be a non-negative duration.",
    );
  }

  const config = await loadConfig(null);
  const [databasePlugin, loadedStoragePlugin] = await Promise.all([
    config.database(),
    config.storage(),
  ]);
  assertNodeStoragePlugin(loadedStoragePlugin);
  const storagePlugin = loadedStoragePlugin;

  try {
    const listObjects = storagePlugin.profiles.node.listObjects;
    if (!listObjects) {
      throw new Error(
        `Storage plugin "${storagePlugin.name}" does not support storage prune.`,
      );
    }
    const deleteObjects = storagePlugin.profiles.node.deleteObjects;
    if (options.yes && !deleteObjects) {
      throw new Error(
        `Storage plugin "${storagePlugin.name}" does not support exact object deletion.`,
      );
    }
    if (options.yes) {
      p.log.warn(
        "Storage prune requires exclusive access. Stop deploy and promote operations first.",
      );
      p.log.warn(
        "The current database must own every object under this storage prefix. Use a separate storage basePath for each database or environment.",
      );
    }

    const bundles = await loadAllBundles(databasePlugin);
    const liveBundleIds = new Set(
      bundles.map((bundle) => bundle.id.toLowerCase()),
    );
    const bundleStorageReferences = collectBundleStorageReferences(bundles);
    const { manifestCount, referencedUris } = await collectReferencedAssetUris(
      bundles,
      storagePlugin,
    );
    const objects = await listObjects();
    const unreferenced = getPruneCandidates({
      bundleStorageReferences,
      liveBundleIds,
      objects,
      referencedAssetUris: referencedUris,
    });

    const cutoff = Date.now() - protectNewerThan;
    let candidates = unreferenced.filter((object) => {
      const modifiedAt = object.lastModifiedAt?.getTime();
      return modifiedAt !== undefined && modifiedAt <= cutoff;
    });
    if (options.yes && candidates.length > 0) {
      const refreshedBundles = await loadAllBundles(databasePlugin);
      const refreshedBundleIds = new Set(
        refreshedBundles.map((bundle) => bundle.id.toLowerCase()),
      );
      const refreshedBundleStorageReferences =
        collectBundleStorageReferences(refreshedBundles);
      const { referencedUris: refreshedReferencedUris } =
        await collectReferencedAssetUris(refreshedBundles, storagePlugin);
      candidates = getPruneCandidates({
        bundleStorageReferences: refreshedBundleStorageReferences,
        liveBundleIds: refreshedBundleIds,
        objects: candidates,
        referencedAssetUris: refreshedReferencedUris,
      });
    }
    const protectedCount = unreferenced.length - candidates.length;
    const bundleObjects = candidates.filter(
      (candidate) => candidate.reason === "bundle",
    );
    const assetObjects = candidates.filter(
      (candidate) => candidate.reason === "asset",
    );
    const candidateBytes = candidates.reduce(
      (total, candidate) => total + candidate.size,
      0,
    );

    p.log.message(
      ui.block(
        "Storage prune",
        [
          ui.kv("Storage", storagePlugin.name),
          ui.kv("Bundles", bundles.length),
          ui.kv("Manifests", manifestCount),
          ui.kv("Objects", objects.length),
          ui.kv("Protect newer", formatDuration(protectNewerThan)),
          ui.kv("Bundle data", bundleObjects.length),
          ui.kv("Shared assets", assetObjects.length),
          ui.kv("Reclaimable", formatBytes(candidateBytes)),
          protectedCount > 0
            ? ui.kv("Protected", `${protectedCount} newer/undated objects`)
            : null,
        ].filter((line): line is string => line !== null),
      ),
    );

    if (candidates.length === 0) {
      p.log.success("No objects are eligible for pruning.");
      return;
    }

    if (!options.yes) {
      p.log.message(
        ui.block("Eligible objects", [formatPruneCandidateTable(candidates)]),
      );
      p.log.info(
        `Dry run only. Delete with ${ui.command(
          `hot-updater storage prune --protect-newer-than ${formatDuration(protectNewerThan)} --yes`,
        )}.`,
      );
      return;
    }

    await deleteObjects!(candidates.map((candidate) => candidate.key));
    p.log.success(
      `Pruned ${candidates.length} objects (${formatBytes(candidateBytes)}).`,
    );
  } finally {
    await safeOnUnmount(databasePlugin);
  }
}
