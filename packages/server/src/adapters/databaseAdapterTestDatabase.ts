export const DATABASE_ADAPTER_TEST_SCHEMA_SQL = `
  create table channels (
    id varchar(255) primary key,
    name varchar(255) not null unique
  );
  create table bundles (
    id text primary key,
    platform text not null,
    should_force_update boolean not null,
    enabled boolean not null,
    file_hash text not null,
    git_commit_hash text,
    message text,
    channel text not null default 'production',
    channel_id varchar(255) not null references channels(id) on delete restrict,
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
    bundle_id text not null references bundles(id) on delete restrict,
    base_bundle_id text not null references bundles(id) on delete restrict,
    base_file_hash text not null,
    patch_file_hash text not null,
    patch_storage_uri text not null,
    order_index integer not null default 0
  );
  create table bundle_events (
    id text primary key,
    type text not null,
    install_id text not null,
    user_id text,
    username text,
    from_bundle_id text not null,
    to_bundle_id text not null,
    platform text not null,
    app_version text not null,
    channel text not null,
    cohort text not null,
    update_strategy text not null,
    fingerprint_hash text,
    sdk_version text,
    received_at_ms integer not null
  );
`;

export const DATABASE_ADAPTER_TEST_RESET_SQL = `
  delete from bundle_events;
  delete from bundle_patches;
  delete from bundles;
  delete from channels;
`;
