import {
  HOT_UPDATER_CORE_SCHEMA_KEY,
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";

export const DATABASE_PLUGIN_TEST_SCHEMA_SQL = `
  create table ${HOT_UPDATER_SETTINGS_TABLE} (
    key text primary key,
    value text not null
  );
  insert into ${HOT_UPDATER_SETTINGS_TABLE} (key, value)
    values ('${HOT_UPDATER_CORE_SCHEMA_KEY}', '${HOT_UPDATER_SCHEMA_VERSION}');
  create table channels (
    id text primary key,
    name text not null unique
  );
  create table bundles (
    id text primary key,
    platform text not null,
    git_commit_hash text,
    metadata jsonb not null default '{}'::jsonb,
    manifest_storage_uri text not null,
    manifest_file_hash text not null,
    asset_base_storage_uri text not null
  );
  create table bundle_patches (
    id varchar(255) primary key,
    bundle_id text not null references bundles(id) on delete cascade,
    base_bundle_id text not null references bundles(id) on delete cascade,
    base_file_hash text not null,
    patch_file_hash text not null,
    patch_storage_uri text not null,
    byte_size double precision not null check (
      byte_size >= 0 and byte_size <= 9007199254740991
    ),
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
    created_at_ms double precision not null,
    updated_at_ms double precision not null
  );
  create table release_catalogs (
    scope_key text primary key,
    catalog_id text not null,
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
    updated_at_ms double precision not null
  );
  create table bundle_events (
    id text primary key,
    type text not null,
    install_id text not null,
    user_id text,
    from_release_id text,
    from_bundle_id text,
    to_release_id text,
    to_bundle_id text not null,
    platform text not null,
    app_version text not null,
    channel text not null,
    metadata jsonb not null,
    received_at_ms integer not null
  );
  create table bundle_event_heads (
    install_id text primary key,
    id text not null,
    received_at_ms integer not null,
    user_id text,
    platform text not null,
    channel text not null,
    type text not null,
    from_bundle_id text,
    to_bundle_id text not null,
    current_release_id text,
    app_version text not null
  );
  create index bundle_event_heads_user_idx on bundle_event_heads(user_id, install_id);
  create index bundle_event_heads_scope_idx on bundle_event_heads(platform, channel, received_at_ms);
  create table insights_overview (
    id text primary key,
    scope_kind text not null,
    release_kind text not null,
    release_id text not null default '',
    channel text not null,
    platform text not null,
    app_version_kind text not null,
    app_version text not null default '',
    period_kind text not null,
    bucket_start_ms integer not null default 0,
    downloads integer not null default 0,
    launches integer not null default 0,
    failed_launches integer not null default 0,
    latest_installations integer not null default 0,
    launch_users text,
    activity_users text,
    unique(scope_kind, release_kind, release_id, channel, platform,
      app_version_kind, app_version, period_kind, bucket_start_ms)
  );
  create index insights_overview_release_time_idx on insights_overview(
    scope_kind, release_id, platform, channel, period_kind, bucket_start_ms
  );
  create index insights_overview_scope_time_idx on insights_overview(
    scope_kind, channel, platform, app_version_kind, app_version,
    period_kind, bucket_start_ms
  );
  create index insights_overview_distribution_time_idx on insights_overview(
    scope_kind, channel, period_kind, bucket_start_ms, platform, app_version
  );
  create table api_keys (
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
  delete from insights_overview;
  delete from bundle_event_heads;
  delete from bundle_events;
  delete from api_keys;
  delete from bundle_patches;
  delete from release_catalogs;
  delete from releases;
  delete from bundles;
  delete from channels;
`;
