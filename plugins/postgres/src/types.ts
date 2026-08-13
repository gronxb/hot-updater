import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ClientAccessKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";

export interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
  readonly channels: ChannelRow;
  readonly client_access_keys: ClientAccessKeyRow;
  readonly release_catalogs: ReleaseCatalogRow;
  readonly releases: ReleaseRow;
}
