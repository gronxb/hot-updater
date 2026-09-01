-- Explicit maintenance cutover. Drain old writers before applying this fence.
alter table bundle_events add column insights_live_version smallint;

create table private_hot_updater_insights_live_installations (
  install_key bytea primary key check (octet_length(install_key) = 32),
  install_id text not null,
  event_id uuid not null,
  received_at_ms double precision not null check (received_at_ms >= 0),
  event jsonb not null
);

create table private_hot_updater_insights_live_state (
  id integer primary key check (id = 1),
  version integer not null check (version = 1),
  initialized boolean not null,
  ready boolean not null,
  failed boolean not null,
  failure text check (failure is null or octet_length(failure) <= 64),
  upper_id uuid,
  after_id uuid,
  revision bigint not null check (revision > 0),
  check ((failed and not ready and failure is not null)
    or (not failed and failure is null))
);
insert into private_hot_updater_insights_live_state
  (id, version, initialized, ready, failed, revision)
  values (1, 1, false, false, false, 1);

-- NOT VALID avoids a historical table scan but rejects every unfenced new row.
alter table bundle_events add constraint bundle_events_live_required
  check (insights_live_version is not null and insights_live_version = 1) not valid;
