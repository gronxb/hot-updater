import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";

export interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly channels: ChannelRow;
}
