import type { Bundle, GetBundlesArgs } from "@hot-updater/core";

import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import { parseLegacyBundle } from "./blobDatabaseLegacy";
import type { BlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import { blobArray, blobString } from "./blobDatabaseValue";
import { rowsToBundles, rowToBundle } from "./databaseRows";
import { filterCompatibleAppVersions } from "./filterCompatibleAppVersions";

type BlobManifestOperations = {
  readonly loadObject: (key: string) => Promise<unknown | null>;
};

const INVALID_ROUTE_SEGMENT = /[%/*?#\\\p{Cc}]/u;

export class BlobDatabaseUnsafeRouteSegmentError extends Error {
  readonly name = "BlobDatabaseUnsafeRouteSegmentError";

  constructor(
    readonly field: "channel" | "fingerprintHash",
    readonly value: string,
  ) {
    super(`Blob database ${field} contains an unsafe route character.`);
  }
}

export const assertBlobUpdateRouteSegment = (
  field: "channel" | "fingerprintHash",
  value: string,
): void => {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    INVALID_ROUTE_SEGMENT.test(value)
  ) {
    throw new BlobDatabaseUnsafeRouteSegmentError(field, value);
  }
};

export const assertBlobUpdateRouteArgs = (args: GetBundlesArgs): void => {
  assertBlobUpdateRouteSegment("channel", args.channel ?? "production");
  if (args._updateStrategy === "fingerprint") {
    assertBlobUpdateRouteSegment("fingerprintHash", args.fingerprintHash);
  }
};

const encodeManifestSegment = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

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

const loadFirstObject = async (
  operations: Pick<BlobManifestOperations, "loadObject">,
  keys: readonly string[],
): Promise<{ readonly key: string; readonly value: unknown } | null> => {
  for (const key of keys) {
    const value = await operations.loadObject(key);
    if (value !== null) return { key, value };
  }
  return null;
};

const loadManifestBundles = async (
  operations: Pick<BlobManifestOperations, "loadObject">,
  keys: readonly string[],
  required: boolean,
): Promise<Bundle[]> => {
  const stored = await loadFirstObject(operations, keys);
  if (stored !== null) return parseManifestBundles(stored.value, stored.key);
  if (required) throw new BlobDatabaseSnapshotError(keys[0] ?? "manifest");
  return [];
};

const appVersionManifestKey = (
  channel: string,
  platform: string,
  version: string,
): string =>
  `app-version/${encodeManifestSegment(channel)}/${platform}/${encodeManifestSegment(normalizeBlobTargetAppVersion(version))}/update.json`;

const fingerprintManifestKey = (
  channel: string,
  platform: string,
  fingerprintHash: string,
): string =>
  `fingerprint/${encodeManifestSegment(channel)}/${platform}/${encodeManifestSegment(fingerprintHash)}/update.json`;

const targetVersionIndexKey = (channel: string, platform: string): string =>
  `app-version/${encodeManifestSegment(channel)}/${platform}/target-app-versions.json`;

export const loadBlobUpdateBundles = async (
  operations: Pick<BlobManifestOperations, "loadObject">,
  args: GetBundlesArgs,
  prefix?: string,
  snapshot?: BlobDatabaseSnapshot,
): Promise<Bundle[]> => {
  const channel = args.channel ?? "production";
  const hasPrefix = prefix !== undefined;
  const hasMatchingSnapshotRows =
    snapshot?.bundles.some(
      (bundle) =>
        bundle.channel === channel &&
        bundle.platform === args.platform &&
        (args._updateStrategy === "fingerprint"
          ? bundle.fingerprint_hash === args.fingerprintHash
          : bundle.target_app_version !== null),
    ) ?? false;
  assertBlobUpdateRouteArgs(args);
  if (args._updateStrategy === "fingerprint") {
    const key = fingerprintManifestKey(
      channel,
      args.platform,
      args.fingerprintHash,
    );
    return loadManifestBundles(
      operations,
      hasPrefix
        ? [prefixedKey(prefix, key)]
        : [
            key,
            `${channel}/${args.platform}/${args.fingerprintHash}/update.json`,
          ],
      hasPrefix && hasMatchingSnapshotRows,
    );
  }

  const indexKey = targetVersionIndexKey(channel, args.platform);
  const storedVersions = await loadFirstObject(
    operations,
    hasPrefix
      ? [prefixedKey(prefix, indexKey)]
      : [indexKey, `${channel}/${args.platform}/target-app-versions.json`],
  );
  if (storedVersions === null && hasPrefix && hasMatchingSnapshotRows) {
    throw new BlobDatabaseSnapshotError(prefixedKey(prefix, indexKey));
  }
  const versions =
    storedVersions === null
      ? []
      : blobArray(storedVersions.value, storedVersions.key).map((item) =>
          blobString(item, storedVersions.key),
        );
  const compatible = filterCompatibleAppVersions(versions, args.appVersion);
  return (
    await Promise.all(
      compatible.map((version) =>
        loadManifestBundles(
          operations,
          hasPrefix
            ? [
                prefixedKey(
                  prefix,
                  appVersionManifestKey(channel, args.platform, version),
                ),
              ]
            : [
                appVersionManifestKey(channel, args.platform, version),
                `${channel}/${args.platform}/${normalizeBlobTargetAppVersion(version)}/update.json`,
              ],
          hasPrefix,
        ),
      ),
    )
  ).flat();
};

const manifestKeys = (bundle: Bundle): readonly string[] => {
  if (!bundle.targetAppVersion && !bundle.fingerprintHash) return [];
  assertBlobUpdateRouteSegment("channel", bundle.channel);
  const keys: string[] = [];
  if (bundle.targetAppVersion) {
    keys.push(
      appVersionManifestKey(
        bundle.channel,
        bundle.platform,
        bundle.targetAppVersion,
      ),
    );
  }
  if (bundle.fingerprintHash) {
    assertBlobUpdateRouteSegment("fingerprintHash", bundle.fingerprintHash);
    keys.push(
      fingerprintManifestKey(
        bundle.channel,
        bundle.platform,
        bundle.fingerprintHash,
      ),
    );
  }
  return keys;
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
    for (const key of manifestKeys(bundle)) {
      const values = result.get(key) ?? [];
      values.push(bundle);
      result.set(key, values);
    }
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
      const key = targetVersionIndexKey(bundle.channel, bundle.platform);
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
