import { NIL_UUID } from "@hot-updater/core";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";
import type { Collection } from "mongodb";

import { rowToBundle } from "../db/bundleRows";
import { parseMongoBundleRow, parseMongoPatchRow } from "./mongodbRows";

type MongoUpdateBundleDocument = BundleRow & {
  readonly _hot_updater_deletion_token?: string;
};

type MongoUpdateCollections = {
  readonly bundles: Collection<MongoUpdateBundleDocument>;
  readonly bundlePatches: Collection<BundlePatchRow>;
};

const WITHOUT_MONGO_ID = {
  _id: 0,
  _hot_updater_deletion_token: 0,
} as const;
type GetUpdateInfo = NonNullable<
  DatabaseAdapterImplementation["getUpdateInfo"]
>;

export const createMongoGetUpdateInfo = (
  collections: MongoUpdateCollections,
): GetUpdateInfo => {
  return async (args) => {
    const channelName = args.channel ?? "production";
    const minBundleId = args.minBundleId ?? NIL_UUID;
    let rows: BundleRow[];
    if (args._updateStrategy === "appVersion") {
      const candidates = (
        await collections.bundles
          .find(
            {
              enabled: true,
              _hot_updater_deletion_token: { $exists: false },
              platform: args.platform,
              channel: channelName,
              id: { $gte: minBundleId },
              target_app_version: { $ne: null },
            },
            { projection: WITHOUT_MONGO_ID },
          )
          .toArray()
      ).map((row) => parseMongoBundleRow(row));
      const compatibleVersions = filterCompatibleAppVersions(
        Array.from(
          new Set(
            candidates.flatMap(({ target_app_version: version }) =>
              version === null ? [] : [version],
            ),
          ),
        ),
        args.appVersion,
      );
      rows =
        compatibleVersions.length === 0
          ? []
          : (
              await collections.bundles
                .find(
                  {
                    enabled: true,
                    _hot_updater_deletion_token: { $exists: false },
                    platform: args.platform,
                    channel: channelName,
                    id: { $gte: minBundleId },
                    target_app_version: { $in: compatibleVersions },
                  },
                  { projection: WITHOUT_MONGO_ID },
                )
                .sort({ id: -1 })
                .toArray()
            ).map((row) => parseMongoBundleRow(row));
    } else {
      rows = (
        await collections.bundles
          .find(
            {
              enabled: true,
              _hot_updater_deletion_token: { $exists: false },
              platform: args.platform,
              channel: channelName,
              id: { $gte: minBundleId },
              fingerprint_hash: args.fingerprintHash,
            },
            { projection: WITHOUT_MONGO_ID },
          )
          .sort({ id: -1 })
          .toArray()
      ).map((row) => parseMongoBundleRow(row));
    }
    const patches =
      rows.length === 0
        ? []
        : await collections.bundlePatches
            .find(
              { bundle_id: { $in: rows.map(({ id }) => id) } },
              { projection: WITHOUT_MONGO_ID },
            )
            .sort({ order_index: 1 })
            .toArray()
            .then((documents) =>
              documents.map((row) => parseMongoPatchRow(row)),
            );
    return resolveUpdateInfoFromBundles({
      args: { ...args, channel: channelName, minBundleId },
      bundles: rows.map((row) =>
        rowToBundle(
          row,
          patches.filter(({ bundle_id: bundleId }) => bundleId === row.id),
        ),
      ),
    });
  };
};
