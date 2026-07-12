import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseWhere,
  HotUpdaterContext,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";

import { rowToBundle } from "../db/bundleRows";

type UpdateInfoDatabaseReader = {
  readonly findBundles: (
    where: readonly DatabaseWhere<"bundles">[],
  ) => Promise<readonly BundleRow[]>;
  readonly findPatches: (
    bundleIds: readonly string[],
  ) => Promise<readonly BundlePatchRow[]>;
};

const hydrateBundles = (
  rows: readonly BundleRow[],
  patches: readonly BundlePatchRow[],
) => {
  const patchesByBundleId = new Map<string, BundlePatchRow[]>();
  for (const patch of patches) {
    const current = patchesByBundleId.get(patch.bundle_id) ?? [];
    current.push(patch);
    patchesByBundleId.set(patch.bundle_id, current);
  }
  return rows.map((row) =>
    rowToBundle(row, patchesByBundleId.get(row.id) ?? []),
  );
};

export const getDatabaseAdapterUpdateInfo = async <TContext>(
  reader: UpdateInfoDatabaseReader,
  args: GetBundlesArgs,
  context?: HotUpdaterContext<TContext>,
): Promise<UpdateInfo | null> => {
  const channel = args.channel ?? "production";
  const minBundleId = args.minBundleId ?? NIL_UUID;
  const commonWhere = [
    { field: "enabled", value: true },
    { field: "platform", value: args.platform },
    { field: "channel", value: channel },
    { field: "id", operator: "gte", value: minBundleId },
  ] satisfies readonly DatabaseWhere<"bundles">[];

  const rows =
    args._updateStrategy === "appVersion"
      ? await reader.findBundles([
          ...commonWhere,
          {
            field: "target_app_version",
            operator: "in",
            value: filterCompatibleAppVersions(
              (
                await reader.findBundles([
                  ...commonWhere,
                  {
                    field: "target_app_version",
                    operator: "ne",
                    value: null,
                  },
                ])
              )
                .map((row) => row.target_app_version)
                .filter((value): value is string => value !== null),
              args.appVersion,
            ),
          },
        ])
      : await reader.findBundles([
          ...commonWhere,
          {
            field: "fingerprint_hash",
            value: args.fingerprintHash,
          },
        ]);

  const patches = await reader.findPatches(rows.map((row) => row.id));
  return resolveUpdateInfoFromBundles({
    args: { ...args, channel, minBundleId },
    bundles: hydrateBundles(rows, patches),
    context,
  });
};
