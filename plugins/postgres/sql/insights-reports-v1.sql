-- JSON preserves escaped NUL/unpaired surrogates in valid zero-match queries.
-- These payloads need no JSONB operators or indexes. Checkpoints remain JSONB.
create table private_hot_updater_insights_report_heads (
  query_key text primary key check (query_key ~ '^[0-9a-f]{64}$'),
  canonical_query json not null,
  active_job_id uuid,
  publication_job_id uuid
);

create table private_hot_updater_insights_report_jobs (
  id uuid primary key,
  query_key text not null references private_hot_updater_insights_report_heads(query_key),
  as_of_ms double precision check (as_of_ms >= 0 and as_of_ms <= 9007199254740991 and as_of_ms = trunc(as_of_ms)),
  base_job_id uuid references private_hot_updater_insights_report_jobs(id) on delete restrict,
  status text not null check (status in ('queued', 'preparing', 'ready', 'failed')),
  source_generation text check (length(source_generation) between 1 and 1024),
  checkpoint jsonb not null,
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  claimable_at timestamptz not null default clock_timestamp(),
  publication json,
  check ((status = 'ready') = (publication is not null)),
  check (status <> 'ready' or (source_generation is not null and as_of_ms is not null)),
  check (base_job_id is null or base_job_id <> id),
  check (as_of_ms is not null or (base_job_id is not null and checkpoint = '{"phase":"awaitIdentity"}'::jsonb))
);

-- Pin a base for the entire lifetime of its search jobs/publications. The
-- referencing index also bounds PostgreSQL's FK checks during explicit cleanup.
create index private_hot_updater_insights_report_base_idx
  on private_hot_updater_insights_report_jobs(base_job_id);

create index private_hot_updater_insights_report_claim_idx
  on private_hot_updater_insights_report_jobs(claimable_at, id)
  where status in ('queued', 'preparing');

alter table private_hot_updater_insights_report_heads
  add foreign key (active_job_id) references private_hot_updater_insights_report_jobs(id),
  add foreign key (publication_job_id) references private_hot_updater_insights_report_jobs(id);
