export const DATABASE_PLUGIN_TEST_SCHEMA_SQL = `
  create table bundles (
    id text primary key,
    platform text not null,
    should_force_update boolean not null,
    enabled boolean not null,
    file_hash text not null,
    git_commit_hash text,
    message text,
    channel text not null default 'production',
    storage_uri text not null,
    target_app_version text,
    fingerprint_hash text,
    metadata jsonb not null default '{}'::jsonb,
    manifest_storage_uri text,
    manifest_file_hash text,
    asset_base_storage_uri text,
    rollout_cohort_count integer not null default 1000,
    target_cohorts jsonb
  );
  create table bundle_patches (
    id varchar(255) primary key,
    bundle_id text not null references bundles(id) on delete cascade,
    base_bundle_id text not null references bundles(id) on delete cascade,
    base_file_hash text not null,
    patch_file_hash text not null,
    patch_storage_uri text not null,
    order_index integer not null default 0
  );
`;

export const DATABASE_PLUGIN_TEST_RESET_SQL = `
  delete from bundle_patches;
  delete from bundles;
`;
