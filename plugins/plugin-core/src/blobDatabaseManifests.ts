import type { Bundle, GetBundlesArgs } from "@hot-updater/core";

import { parseLegacyBundle } from "./blobDatabaseLegacy";
import type { BlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import { blobArray, blobString } from "./blobDatabaseValue";
import { rowsToBundles, rowToBundle } from "./databaseRows";
import { filterCompatibleAppVersions } from "./filterCompatibleAppVersions";

type BlobManifestOperations = {
  readonly loadObject: (key: string) => Promise<unknown | null>;
};

const prefixedKey = (prefix: string | undefined, key: string): string =>
  prefix ? `${prefix}/${key}` : key;

export const normalizeBlobTargetAppVersion = (version: string): string =>
  version
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /([><=~^]+)\s+(\d)/g,
      (_match, operator, digit) => `${operator}${digit}`,
    );

const parseManifestBundles = (value: unknown, source: string): Bundle[] =>
  blobArray(value, source).map((item) => {
    const parsed = parseLegacyBundle(item, source);
    return rowToBundle(parsed.bundle, parsed.patches);
  });

const loadManifestBundles = async (
  operations: Pick<BlobManifestOperations, "loadObject">,
  key: string,
): Promise<Bundle[]> => {
  const value = await operations.loadObject(key);
  return value === null ? [] : parseManifestBundles(value, key);
};

export const loadBlobUpdateBundles = async (
  operations: Pick<BlobManifestOperations, "loadObject">,
  args: GetBundlesArgs,
  prefix?: string,
): Promise<Bundle[]> => {
  const channel = args.channel ?? "production";
  if (args._updateStrategy === "fingerprint") {
    return loadManifestBundles(
      operations,
      prefixedKey(
        prefix,
        `${channel}/${args.platform}/${args.fingerprintHash}/update.json`,
      ),
    );
  }

  const versionsKey = prefixedKey(
    prefix,
    `${channel}/${args.platform}/target-app-versions.json`,
  );
  const value = await operations.loadObject(versionsKey);
  const versions =
    value === null
      ? []
      : blobArray(value, versionsKey).map((item) =>
          blobString(item, versionsKey),
        );
  const compatible = filterCompatibleAppVersions(versions, args.appVersion);
  return (
    await Promise.all(
      compatible.map((version) =>
        loadManifestBundles(
          operations,
          prefixedKey(
            prefix,
            `${channel}/${args.platform}/${normalizeBlobTargetAppVersion(version)}/update.json`,
          ),
        ),
      ),
    )
  ).flat();
};

const manifestKey = (bundle: Bundle): string | undefined => {
  const target = bundle.targetAppVersion
    ? normalizeBlobTargetAppVersion(bundle.targetAppVersion)
    : bundle.fingerprintHash;
  return target
    ? `${bundle.channel}/${bundle.platform}/${target}/update.json`
    : undefined;
};

const manifestBundles = (
  snapshot: BlobDatabaseSnapshot,
): Map<string, Bundle[]> => {
  const result = new Map<string, Bundle[]>();
  const bundles = rowsToBundles(
    snapshot.bundles,
    snapshot.bundle_patches,
    snapshot.bundles,
  );
  for (const bundle of bundles) {
    const key = manifestKey(bundle);
    if (!key) continue;
    const values = result.get(key) ?? [];
    values.push(bundle);
    result.set(key, values);
  }
  for (const values of result.values()) {
    values.sort((left, right) => right.id.localeCompare(left.id));
  }
  return result;
};

const targetVersionIndexes = (
  manifests: ReadonlyMap<string, readonly Bundle[]>,
): Map<string, string[]> => {
  const result = new Map<string, Set<string>>();
  for (const bundles of manifests.values()) {
    for (const bundle of bundles) {
      if (!bundle.targetAppVersion) continue;
      const key = `${bundle.channel}/${bundle.platform}/target-app-versions.json`;
      const versions = result.get(key) ?? new Set<string>();
      versions.add(normalizeBlobTargetAppVersion(bundle.targetAppVersion));
      result.set(key, versions);
    }
  }
  return new Map(
    [...result].map(([key, versions]) => [
      key,
      [...versions].sort((left, right) => right.localeCompare(left)),
    ]),
  );
};

export const createBlobUpdateManifestObjects = (
  snapshot: BlobDatabaseSnapshot,
): ReadonlyMap<string, unknown> => {
  const manifests = manifestBundles(snapshot);
  return new Map<string, unknown>([
    ...manifests,
    ...targetVersionIndexes(manifests),
  ]);
};
