import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { getUpdateInfo as getManifestUpdateInfo } from "@hot-updater/js";

import { seedRequestUpdateBundles } from "./requestUpdateBundleState";
import type { Bundle, HotUpdaterContext } from "./types";

export interface ResolveUpdateInfoFromBundlesOptions<TContext = unknown> {
  readonly args: GetBundlesArgs;
  readonly bundles: Bundle[];
  readonly context?: HotUpdaterContext<TContext>;
}

const findSeedBundle = (bundles: readonly Bundle[], bundleId: string) =>
  bundles.find((bundle) => bundle.id === bundleId);

export const resolveUpdateInfoFromBundles = async <TContext = unknown>({
  args,
  bundles,
  context,
}: ResolveUpdateInfoFromBundlesOptions<TContext>): Promise<UpdateInfo | null> => {
  const info = await getManifestUpdateInfo(bundles, args);
  if (!info) {
    return null;
  }

  seedRequestUpdateBundles(context, [
    findSeedBundle(bundles, info.id),
    args.bundleId === NIL_UUID ? null : findSeedBundle(bundles, args.bundleId),
  ]);
  return info;
};
