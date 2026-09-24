import type { BundleRow, ReleaseCatalogRow, ReleaseRow } from "./databaseRows";

/** The fields of a bundle row a change may set. */
export type BundleRowUpdate = Partial<Omit<BundleRow, "id">>;

/** The fields of a release row a policy change may set. */
export type ReleaseRowUpdate = Partial<
  Pick<
    ReleaseRow,
    | "revision"
    | "scope_key"
    | "target_app_version"
    | "fingerprint_hash"
    | "enabled"
    | "should_force_update"
    | "message"
    | "rollout_cohort_count"
    | "target_cohorts"
    | "updated_at_ms"
  >
>;

export type ReleaseCatalogRowUpdate = Omit<ReleaseCatalogRow, "scope_key">;
