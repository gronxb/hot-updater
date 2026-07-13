import { NIL_UUID } from "@hot-updater/core";
import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";
import type { Collection } from "mongodb";

import { rowToBundle } from "../db/bundleRows";

type MongoUpdateCollections = {
  readonly bundles: Collection<BundleRow>;
  readonly bundlePatches: Collection<BundlePatchRow>;
  readonly channels: Collection<ChannelRow>;
};

const WITHOUT_MONGO_ID = { _id: 0 } as const;
type GetUpdateInfo = NonNullable<DatabasePluginImplementation["getUpdateInfo"]>;

export const createMongoGetUpdateInfo = (
  collections: MongoUpdateCollections,
): GetUpdateInfo => {
  return async (args, context) => {
    const channelName = args.channel ?? "production";
    const minBundleId = args.minBundleId ?? NIL_UUID;
    const channel = await collections.channels.findOne(
      { name: channelName },
      { projection: WITHOUT_MONGO_ID },
    );
    if (channel === null) {
      return resolveUpdateInfoFromBundles({
        args: { ...args, channel: channelName, minBundleId },
        bundles: [],
        context,
      });
    }
    let rows: BundleRow[];
    if (args._updateStrategy === "appVersion") {
      const candidates = await collections.bundles
        .find(
          {
            enabled: true,
            platform: args.platform,
            channel_id: channel.id,
            id: { $gte: minBundleId },
            target_app_version: { $ne: null },
          },
          { projection: WITHOUT_MONGO_ID },
        )
        .toArray();
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
          : await collections.bundles
              .find(
                {
                  enabled: true,
                  platform: args.platform,
                  channel_id: channel.id,
                  id: { $gte: minBundleId },
                  target_app_version: { $in: compatibleVersions },
                },
                { projection: WITHOUT_MONGO_ID },
              )
              .sort({ id: -1 })
              .toArray();
    } else {
      rows = await collections.bundles
        .find(
          {
            enabled: true,
            platform: args.platform,
            channel_id: channel.id,
            id: { $gte: minBundleId },
            fingerprint_hash: args.fingerprintHash,
          },
          { projection: WITHOUT_MONGO_ID },
        )
        .sort({ id: -1 })
        .toArray();
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
            .toArray();
    return resolveUpdateInfoFromBundles({
      args: { ...args, channel: channelName, minBundleId },
      bundles: rows.map((row) =>
        rowToBundle(
          row,
          channelName,
          patches.filter(({ bundle_id: bundleId }) => bundleId === row.id),
        ),
      ),
      context,
    });
  };
};
