import { NIL_UUID } from "@hot-updater/core";
import type {
  BundlePatchRow,
  BundleRow,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";

import { rowToBundle } from "../db/bundleRows";
import {
  getPrismaDelegate,
  parsePrismaBundleRow,
  parsePrismaPatchRow,
  parsePrismaRows,
} from "./prismaRows";

const fetchPatches = async (
  client: object,
  bundleIds: readonly string[],
): Promise<BundlePatchRow[]> => {
  if (bundleIds.length === 0) return [];
  const rows = await getPrismaDelegate(client, "bundle_patches").findMany({
    where: { bundle_id: { in: bundleIds } },
    orderBy: { order_index: "asc" },
  });
  return parsePrismaRows(rows, parsePrismaPatchRow);
};

const hydrateBundles = async (client: object, rows: readonly BundleRow[]) => {
  const patches = await fetchPatches(
    client,
    rows.map(({ id }) => id),
  );
  return rows.map((row) =>
    rowToBundle(
      row,
      patches.filter(({ bundle_id: bundleId }) => bundleId === row.id),
    ),
  );
};

type GetUpdateInfo = NonNullable<DatabasePluginImplementation["getUpdateInfo"]>;

export const createPrismaGetUpdateInfo = (client: object): GetUpdateInfo => {
  return async (args, context) => {
    const channel = args.channel ?? "production";
    const minBundleId = args.minBundleId ?? NIL_UUID;
    const delegate = getPrismaDelegate(client, "bundles");
    let rows: BundleRow[];
    if (args._updateStrategy === "appVersion") {
      const candidates = parsePrismaRows(
        await delegate.findMany({
          where: {
            enabled: true,
            platform: args.platform,
            channel,
            id: { gte: minBundleId },
            target_app_version: { not: null },
          },
        }),
        parsePrismaBundleRow,
      );
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
          : parsePrismaRows(
              await delegate.findMany({
                where: {
                  enabled: true,
                  platform: args.platform,
                  channel,
                  id: { gte: minBundleId },
                  target_app_version: { in: compatibleVersions },
                },
                orderBy: { id: "desc" },
              }),
              parsePrismaBundleRow,
            );
    } else {
      rows = parsePrismaRows(
        await delegate.findMany({
          where: {
            enabled: true,
            platform: args.platform,
            channel,
            id: { gte: minBundleId },
            fingerprint_hash: args.fingerprintHash,
          },
          orderBy: { id: "desc" },
        }),
        parsePrismaBundleRow,
      );
    }
    return resolveUpdateInfoFromBundles({
      args: { ...args, channel, minBundleId },
      bundles: await hydrateBundles(client, rows),
      context,
    });
  };
};
