import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";

export interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
}
