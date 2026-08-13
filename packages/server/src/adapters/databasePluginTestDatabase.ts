export const DATABASE_PLUGIN_TEST_SCHEMA_SQL = `
  create table channels (
    id text primary key,
    name text not null unique
  );
  create table bundles (
    id text primary key,
    platform text not null,
    file_hash text not null,
    git_commit_hash text,
    storage_uri text not null,
    metadata jsonb not null default '{}'::jsonb,
    manifest_storage_uri text,
    manifest_file_hash text,
    asset_base_storage_uri text
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
  create table releases (
    id text primary key,
    revision integer not null,
    scope_key text not null,
    channel_id text not null references channels(id),
    platform text not null,
    kind text not null,
    bundle_id text references bundles(id),
    strategy text not null,
    target_app_version text,
    fingerprint_hash text,
    enabled boolean not null,
    should_force_update boolean not null,
    message text,
    rollout_cohort_count integer not null default 1000,
    target_cohorts jsonb not null default '[]'::jsonb,
    operation text not null,
    source_release_id text references releases(id) on delete set null,
    created_at_ms integer not null,
    updated_at_ms integer not null
  );
  create table release_catalogs (
    scope_key text primary key,
    authority_id text not null,
    strategy text not null,
    channel_id text not null references channels(id),
    channel_key text not null,
    platform text not null,
    fingerprint_hash text,
    generation integer not null,
    payload text not null,
    catalog_hash text not null,
    byte_size integer not null,
    is_tombstone boolean not null,
    updated_at_ms integer not null
  );
  create table bundle_events (
    id text primary key,
    type text not null,
    install_id text not null,
    user_id text,
    username text,
    from_release_id text,
    from_bundle_id text,
    to_release_id text,
    to_bundle_id text,
    platform text not null,
    app_version text not null,
    channel text not null,
    cohort text not null,
    update_strategy text,
    fingerprint_hash text,
    sdk_version text,
    received_at_ms integer not null
  );
  create table client_access_keys (
    id text primary key,
    hash text not null unique,
    name text not null,
    prefix text not null,
    role text not null,
    created_at_ms integer not null,
    revoked_at_ms integer
  );
`;

export const DATABASE_PLUGIN_TEST_RESET_SQL = `
  delete from bundle_events;
  delete from client_access_keys;
  delete from bundle_patches;
  delete from release_catalogs;
  delete from releases;
  delete from bundles;
  delete from channels;
`;
