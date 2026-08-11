import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ClientAccessKeyRow,
} from "@hot-updater/plugin-core";

export interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
  readonly client_access_keys: ClientAccessKeyRow;
}
