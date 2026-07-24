import type {
  BundlePatchRow,
  BundleRow,
  DatabaseRow,
} from "@hot-updater/plugin-core";

type BundleEventRow = DatabaseRow<"bundle_events">;

export interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
}
