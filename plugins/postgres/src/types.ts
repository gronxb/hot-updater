import type {
  BundleEventRow,
  InsightsInstallationRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";

export interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
  readonly bundle_installations: InsightsInstallationRow;
  readonly channels: ChannelRow;
  readonly api_keys: ApiKeyRow;
  readonly release_catalogs: ReleaseCatalogRow;
  readonly releases: ReleaseRow;
}
