import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";
import { bundleToPatchRows } from "@hot-updater/plugin-core";
import type {
  DatabaseImplementationResult,
  DatabaseModel,
} from "@hot-updater/plugin-core/internal";

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
  return model === "bundles"
    ? remote.loadBundleRows()
    : (await remote.loadBundles()).flatMap(bundleToPatchRows);
}
