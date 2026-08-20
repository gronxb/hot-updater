-- HotUpdater.schema

create table channels (
  id varchar(255) primary key not null,
  name varchar(255) not null
);

create table bundles (
  id uuid primary key not null,
  platform text not null,
  file_hash text not null,
  git_commit_hash text,
  storage_uri text not null,
  metadata json not null default '{}'::json,
  manifest_storage_uri text,
  manifest_file_hash text,
  asset_base_storage_uri text
);

create table bundle_patches (
  id varchar(255) primary key not null,
  bundle_id uuid not null,
  base_bundle_id uuid not null,
  base_file_hash text not null,
  patch_file_hash text not null,
  patch_storage_uri text not null,
  order_index integer not null default 0
);

create table releases (
  id uuid primary key not null,
  revision integer not null,
  scope_key varchar(2048) not null,
  channel_id varchar(255) not null,
  platform text not null,
  kind text not null,
  bundle_id uuid,
  strategy text not null,
  target_app_version text,
  fingerprint_hash text,
  enabled boolean not null,
  should_force_update boolean not null,
  message text,
  rollout_cohort_count integer not null default 1000,
  target_cohorts json not null default '[]'::json,
  operation text not null,
  source_release_id uuid,
  created_at_ms double precision not null,
  updated_at_ms double precision not null
);

create table release_catalogs (
  scope_key varchar(2048) primary key not null,
  authority_id varchar(255) not null,
  strategy text not null,
  channel_id varchar(255) not null,
  channel_key varchar(1400) not null,
  platform text not null,
  fingerprint_hash text,
  generation double precision not null,
  payload text not null,
  catalog_hash varchar(71) not null,
  byte_size integer not null,
  is_tombstone boolean not null,
  updated_at_ms double precision not null
);

create table bundle_events (
  id uuid primary key not null,
  type text not null,
  install_id text not null,
  user_id text,
  username text,
  from_release_id uuid,
  from_bundle_id uuid,
  to_release_id uuid,
  to_bundle_id uuid not null,
  platform text not null,
  app_version text not null,
  channel text not null,
  cohort text not null,
  update_strategy text,
  fingerprint_hash text,
  sdk_version text,
  received_at_ms double precision not null
);

create table client_access_keys (
  id varchar(255) primary key not null,
  hash text not null,
  name text not null,
  prefix text not null,
  role text not null,
  created_at_ms double precision not null,
  revoked_at_ms double precision
);

create table private_hot_updater_settings (
  key varchar(255) primary key not null,
  value text not null default '1.0.0'
);

create unique index channels_name_key on channels(name);
create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id);
create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id);
create index releases_scope_order_idx on releases(scope_key, id);
create index releases_channel_platform_order_idx on releases(channel_id, platform, id);
create index releases_bundle_id_idx on releases(bundle_id);
create index releases_fingerprint_hash_idx on releases(fingerprint_hash);
create index releases_enabled_idx on releases(enabled);
create index release_catalogs_channel_idx on release_catalogs(channel_id);
create index release_catalogs_authority_strategy_idx on release_catalogs(authority_id, strategy);
create index bundle_events_received_at_idx on bundle_events(received_at_ms, id);
create index bundle_events_install_idx on bundle_events(install_id, received_at_ms, id);
create index bundle_events_user_id_idx on bundle_events(user_id, received_at_ms, id);
create index bundle_events_username_idx on bundle_events(username, received_at_ms, id);
create index bundle_events_to_bundle_idx on bundle_events(type, to_bundle_id, received_at_ms, id);
create index bundle_events_from_bundle_idx on bundle_events(type, from_bundle_id, received_at_ms, id);
create index bundle_events_to_release_idx on bundle_events(type, to_release_id, received_at_ms, id);
create index bundle_events_from_release_idx on bundle_events(type, from_release_id, received_at_ms, id);
create unique index client_access_keys_hash_key on client_access_keys(hash);
create index client_access_keys_created_at_idx on client_access_keys(created_at_ms, id);

alter table channels add constraint channels_id_length_check
  check (char_length(id) between 1 and 255);
alter table channels add constraint channels_name_length_check
  check (char_length(name) between 1 and 255);
alter table releases add constraint releases_revision_check
  check (revision >= 1);
alter table releases add constraint releases_kind_bundle_check
  check ((kind = 'BUNDLE' and bundle_id is not null) or (kind = 'EMBEDDED' and bundle_id is null));
alter table releases add constraint releases_strategy_target_check
  check ((strategy = 'APP_VERSION' and target_app_version is not null and fingerprint_hash is null) or (strategy = 'FINGERPRINT' and target_app_version is null and fingerprint_hash is not null));
alter table releases add constraint releases_rollout_cohort_count_check
  check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000);
alter table releases add constraint releases_operation_check
  check (operation in ('DEPLOY', 'PROMOTE', 'ROLLBACK'));
alter table release_catalogs add constraint release_catalogs_strategy_target_check
  check ((strategy = 'APP_VERSION' and fingerprint_hash is null) or (strategy = 'FINGERPRINT' and fingerprint_hash is not null));
alter table release_catalogs add constraint release_catalogs_generation_check
  check (generation >= 1 and generation <= 9007199254740991);
alter table release_catalogs add constraint release_catalogs_byte_size_check
  check (byte_size >= 0 and byte_size <= 262144);
alter table bundle_events add constraint bundle_events_type_check
  check (type in ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED', 'UNCHANGED'));
alter table bundle_events add constraint bundle_events_platform_check
  check (platform in ('ios', 'android'));
alter table bundle_events add constraint bundle_events_shape_check
  check (((type in ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED')) and from_bundle_id is not null and update_strategy is not null and update_strategy in ('fingerprint', 'appVersion')) or (type = 'UNCHANGED' and from_bundle_id is null and update_strategy is null));
alter table bundle_events add constraint bundle_events_received_at_check
  check (received_at_ms >= 0);
alter table client_access_keys add constraint client_access_keys_role_check
  check (role = 'client');
alter table client_access_keys add constraint client_access_keys_created_at_check
  check (created_at_ms >= 0);
alter table client_access_keys add constraint client_access_keys_revoked_at_check
  check (revoked_at_ms is null or revoked_at_ms >= 0);

alter table bundle_patches add constraint bundle_patches_bundle_id_fk
  foreign key (bundle_id) references bundles(id) on update restrict on delete cascade;
alter table bundle_patches add constraint bundle_patches_base_bundle_id_fk
  foreign key (base_bundle_id) references bundles(id) on update restrict on delete cascade;
alter table releases add constraint releases_channel_id_fk
  foreign key (channel_id) references channels(id) on update restrict on delete restrict;
alter table releases add constraint releases_bundle_id_fk
  foreign key (bundle_id) references bundles(id) on update restrict on delete restrict;
alter table releases add constraint releases_source_release_id_fk
  foreign key (source_release_id) references releases(id) on update restrict on delete set null;
alter table release_catalogs add constraint release_catalogs_channel_id_fk
  foreign key (channel_id) references channels(id) on update restrict on delete restrict;

insert into private_hot_updater_settings (key, value)
values ('schema.core', '1.0.0')
on conflict (key) do update set value = excluded.value;
