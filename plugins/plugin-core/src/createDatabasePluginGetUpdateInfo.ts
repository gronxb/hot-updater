import {
  type AppVersionGetBundlesArgs,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { getUpdateInfo as getManifestUpdateInfo } from "@hot-updater/js";

import { filterCompatibleAppVersions } from "./filterCompatibleAppVersions";
import { seedRequestUpdateBundles } from "./requestUpdateBundleState";
import type { Bundle, HotUpdaterContext } from "./types";

type AppVersionLookupArgs = {
  channel: string;
  minBundleId: string;
  platform: AppVersionGetBundlesArgs["platform"];
};

type FingerprintLookupArgs = {
  channel: string;
  fingerprintHash: string;
  minBundleId: string;
  platform: FingerprintGetBundlesArgs["platform"];
};

export interface CreateDatabasePluginGetUpdateInfoOptions<TContext = unknown> {
  getBundlesByFingerprint: (
    args: FingerprintLookupArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Bundle[]>;
  getBundlesByTargetAppVersions: (
    args: AppVersionLookupArgs,
    targetAppVersions: string[],
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Bundle[]>;
  listTargetAppVersions: (
    args: AppVersionLookupArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<string[]>;
}

const findSeedBundle = (bundles: readonly Bundle[], bundleId: string) =>
  bundles.find((bundle) => bundle.id === bundleId);

const seedSelectedBundles = <TContext = unknown>({
  bundles,
  bundleId,
  context,
  info,
}: {
  readonly bundles: readonly Bundle[];
  readonly bundleId: string;
  readonly context?: HotUpdaterContext<TContext>;
  readonly info: UpdateInfo | null;
}) => {
  if (!info) {
    return;
  }

  seedRequestUpdateBundles(context, [
    findSeedBundle(bundles, info.id),
    bundleId === NIL_UUID ? null : findSeedBundle(bundles, bundleId),
  ]);
};

const normalizeAppVersionArgs = (
  args: AppVersionGetBundlesArgs,
): AppVersionGetBundlesArgs & AppVersionLookupArgs => ({
  ...args,
  channel: args.channel ?? "production",
  minBundleId: args.minBundleId ?? NIL_UUID,
});

const normalizeFingerprintArgs = (
  args: FingerprintGetBundlesArgs,
): FingerprintGetBundlesArgs & FingerprintLookupArgs => ({
  ...args,
  channel: args.channel ?? "production",
  minBundleId: args.minBundleId ?? NIL_UUID,
});

export const createDatabasePluginGetUpdateInfo = <TContext = unknown>({
  getBundlesByFingerprint,
  getBundlesByTargetAppVersions,
  listTargetAppVersions,
}: CreateDatabasePluginGetUpdateInfoOptions<TContext>) => {
  return async (
    args: GetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ): Promise<UpdateInfo | null> => {
    if (args._updateStrategy === "appVersion") {
      const normalizedArgs = normalizeAppVersionArgs(args);
      const targetAppVersions = await listTargetAppVersions(
        normalizedArgs,
        context,
      );
      const compatibleAppVersions = filterCompatibleAppVersions(
        targetAppVersions,
        normalizedArgs.appVersion,
      );
      const bundles =
        compatibleAppVersions.length > 0
          ? await getBundlesByTargetAppVersions(
              normalizedArgs,
              compatibleAppVersions,
              context,
            )
          : [];

      const info = await getManifestUpdateInfo(bundles, normalizedArgs);
      seedSelectedBundles({
        bundles,
        bundleId: normalizedArgs.bundleId,
        context,
        info,
      });
      return info;
    }

    const normalizedArgs = normalizeFingerprintArgs(args);
    const bundles = await getBundlesByFingerprint(normalizedArgs, context);

    const info = await getManifestUpdateInfo(bundles, normalizedArgs);
    seedSelectedBundles({
      bundles,
      bundleId: normalizedArgs.bundleId,
      context,
      info,
    });
    return info;
  };
};
