import { NIL_UUID } from "@hot-updater/core";
import type {
  BundlePatchRow,
  BundleRow,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  rowToBundle,
} from "@hot-updater/plugin-core";

import {
  queryOwnerPatches,
  queryUpdateBundles,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";

type GetUpdateInfo = NonNullable<DatabasePluginImplementation["getUpdateInfo"]>;

const patchesByBundleId = (
  patches: readonly BundlePatchRow[],
): ReadonlyMap<string, readonly BundlePatchRow[]> => {
  const result = new Map<string, BundlePatchRow[]>();
  for (const patch of patches) {
    const current = result.get(patch.bundle_id) ?? [];
    current.push(patch);
    result.set(patch.bundle_id, current);
  }
  return result;
};

const compatibleRows = (
  rows: readonly BundleRow[],
  appVersion: string,
): BundleRow[] => {
  const versions = filterCompatibleAppVersions(
    rows.flatMap(({ target_app_version: version }) =>
      version === null ? [] : [version],
    ),
    appVersion,
  );
  const compatible = new Set(versions);
  return rows.filter(
    ({ target_app_version: version }) =>
      version !== null && compatible.has(version),
  );
};

export const createDynamoDBGetUpdateInfo =
  (store: DynamoDBStore, indexName: string): GetUpdateInfo =>
  async (args) => {
    const channel = args.channel ?? "production";
    const minBundleId = args.minBundleId ?? NIL_UUID;
    const candidates = await queryUpdateBundles(store, indexName, {
      channel,
      minimumBundleId: minBundleId,
      platform: args.platform,
    });
    const rows =
      args._updateStrategy === "appVersion"
        ? compatibleRows(candidates, args.appVersion)
        : candidates.filter(
            ({ fingerprint_hash: fingerprintHash }) =>
              fingerprintHash === args.fingerprintHash,
          );
    const patches = (
      await Promise.all(
        rows.map(({ id }) => queryOwnerPatches(store, indexName, id)),
      )
    ).flat();
    const groupedPatches = patchesByBundleId(patches);
    return resolveUpdateInfoFromBundles({
      args: { ...args, channel, minBundleId },
      bundles: rows.map((row) =>
        rowToBundle(row, groupedPatches.get(row.id) ?? []),
      ),
    });
  };
