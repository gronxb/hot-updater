import semver from "semver";

import type { BlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import type { BundleRow } from "./types";

const normalizeTargetAppVersion = (version: string): string =>
  version
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /([><=~^]+)\s+(\d)/g,
      (_match, operator, digit) => `${operator}${digit}`,
    );

const exactVersionPaths = (
  apiBasePath: string,
  bundle: BundleRow,
  channelName: string,
  version: string,
): readonly string[] => {
  const normalized = normalizeTargetAppVersion(version);
  if (semver.valid(normalized) === null) {
    return [`${apiBasePath}/app-version/${bundle.platform}/*`];
  }
  const parsed = semver.coerce(normalized);
  if (!parsed) return [`${apiBasePath}/app-version/${bundle.platform}/*`];
  const versions = new Set([parsed.version]);
  if (parsed.patch === 0) versions.add(`${parsed.major}.${parsed.minor}`);
  if (parsed.minor === 0 && parsed.patch === 0) {
    versions.add(`${parsed.major}`);
  }
  return [...versions].map(
    (item) =>
      `${apiBasePath}/app-version/${bundle.platform}/${item}/${channelName}/*`,
  );
};

const bundlePaths = (
  apiBasePath: string,
  snapshot: BlobDatabaseSnapshot,
  bundle: BundleRow,
): readonly string[] => {
  const channelName = snapshot.channels.find(
    ({ id }) => id === bundle.channel_id,
  )?.name;
  if (channelName === undefined) return [];
  if (bundle.fingerprint_hash) {
    return [
      `${apiBasePath}/fingerprint/${bundle.platform}/${bundle.fingerprint_hash}/${channelName}/*`,
    ];
  }
  return bundle.target_app_version
    ? exactVersionPaths(
        apiBasePath,
        bundle,
        channelName,
        bundle.target_app_version,
      )
    : [];
};

const patchFingerprint = (
  snapshot: BlobDatabaseSnapshot,
  bundleId: string,
): string =>
  JSON.stringify(
    snapshot.bundle_patches.filter(({ bundle_id }) => bundle_id === bundleId),
  );

export const changedBundleInvalidationPaths = (
  apiBasePath: string,
  before: BlobDatabaseSnapshot,
  after: BlobDatabaseSnapshot,
): readonly string[] => {
  const beforeById = new Map(before.bundles.map((row) => [row.id, row]));
  const afterById = new Map(after.bundles.map((row) => [row.id, row]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const paths = new Set<string>();
  for (const id of ids) {
    const previous = beforeById.get(id);
    const next = afterById.get(id);
    const bundleChanged = JSON.stringify(previous) !== JSON.stringify(next);
    const patchesChanged =
      patchFingerprint(before, id) !== patchFingerprint(after, id);
    if (!bundleChanged && !patchesChanged) continue;
    if (previous) {
      for (const path of bundlePaths(apiBasePath, before, previous)) {
        paths.add(path);
      }
    }
    if (next) {
      for (const path of bundlePaths(apiBasePath, after, next)) {
        paths.add(path);
      }
    }
  }
  return [...paths];
};
