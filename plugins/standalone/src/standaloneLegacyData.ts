import type {
  BundlePatchRow,
  BundleRow,
  DatabaseImplementationResult,
  DatabaseModel,
} from "@hot-updater/plugin-core";
import { bundleToPatchRows, bundleToRow } from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";

export function loadRows(
  remote: StandaloneBundleRemote,
  model: "bundles",
): Promise<BundleRow[]>;
export function loadRows(
  remote: StandaloneBundleRemote,
  model: "bundle_patches",
): Promise<BundlePatchRow[]>;
export async function loadRows(
  remote: StandaloneBundleRemote,
  model: DatabaseModel,
): Promise<DatabaseImplementationResult[]> {
  const bundles = await remote.loadBundles();
  return model === "bundles"
    ? bundles.map(bundleToRow)
    : bundles.flatMap(bundleToPatchRows);
}
