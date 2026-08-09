import { NIL_UUID } from "@hot-updater/core";
import type {
  BundleRow,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  rowToBundle,
} from "@hot-updater/plugin-core";

import {
  queryUpdateBundles,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";

type GetUpdateInfo = NonNullable<DatabasePluginImplementation["getUpdateInfo"]>;

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
    return resolveUpdateInfoFromBundles({
      args: { ...args, channel, minBundleId },
      bundles: rows.map((row) => rowToBundle(row)),
    });
  };
