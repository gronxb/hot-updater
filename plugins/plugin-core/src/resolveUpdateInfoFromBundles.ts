import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { getUpdateInfo as getManifestUpdateInfo } from "@hot-updater/js";

import type { LegacyBundle } from "./types";

export interface ResolveUpdateInfoFromBundlesOptions {
  readonly args: GetBundlesArgs;
  readonly bundles: LegacyBundle[];
}

export const resolveUpdateInfoFromBundles = async ({
  args,
  bundles,
}: ResolveUpdateInfoFromBundlesOptions): Promise<UpdateInfo | null> =>
  getManifestUpdateInfo(bundles, args);
