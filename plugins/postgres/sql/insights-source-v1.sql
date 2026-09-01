-- Explicit PostgreSQL Insights source cutover. Apply before deploying writers.
-- The NOT VALID fence checks new writes without scanning historical rows.
-- Schedule a maintenance window: transactional DDL/index creation blocks writes.
alter table bundle_events add column insights_source_shard smallint;
alter table bundle_events add column insights_source_seq bigint;
alter table bundle_events add column insights_event jsonb;

create table private_hot_updater_insights_source_clocks (
  shard smallint primary key check (shard between 0 and 15),
  committed_seq bigint not null check (committed_seq >= 0)
);
insert into private_hot_updater_insights_source_clocks (shard, committed_seq)
select shard, 0 from generate_series(0, 15) shard;

create table private_hot_updater_insights_source_state (
  id integer primary key check (id = 1),
  version integer not null check (version = 1),
  source_id uuid not null default gen_random_uuid(),
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
insert into private_hot_updater_insights_source_state
  (id, version, initialized, ready, failed, revision)
  values (1, 1, false, false, false, 1);

create unique index bundle_events_source_idx
  on bundle_events (insights_source_shard, insights_source_seq)
  where insights_source_shard is not null;
alter table bundle_events add constraint bundle_events_source_required check (
  insights_source_shard is not null and insights_source_shard between 0 and 15
  and insights_source_seq is not null and insights_source_seq > 0
  and insights_event is not null
) not valid;
