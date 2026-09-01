CREATE TABLE private_hot_updater_insights_job_heads (
  query_key TEXT PRIMARY KEY NOT NULL,
  query_json TEXT NOT NULL,
  active_job_id TEXT,
  publication_job_id TEXT,
  CONSTRAINT insights_job_heads_key_check CHECK (
    length(query_key) = 64 AND query_key NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE private_hot_updater_insights_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  query_key TEXT NOT NULL,
  query_json TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  as_of_ms REAL NOT NULL,
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  source_alias_upper_id INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until_ms REAL NOT NULL DEFAULT 0,
  claimable_at_ms REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  publication_json TEXT,
  result_total INTEGER,
  completed_at_ms REAL,
  failure_code TEXT,
  CONSTRAINT insights_jobs_head_fk FOREIGN KEY (query_key)
    REFERENCES private_hot_updater_insights_job_heads(query_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT insights_jobs_kind_check CHECK (
    job_kind IN ('search', 'report')
  ),
  CONSTRAINT insights_jobs_status_check CHECK (
    status IN ('queued', 'preparing', 'ready', 'failed')
  ),
  CONSTRAINT insights_jobs_number_check CHECK (
    as_of_ms >= 0 AND source_generation >= 0 AND source_alias_upper_id >= 0
    AND lease_epoch >= 0
    AND lease_until_ms >= 0 AND claimable_at_ms >= 0 AND revision >= 0
    AND (result_total IS NULL OR result_total >= 0)
    AND (completed_at_ms IS NULL OR completed_at_ms >= 0)
  ),
  CONSTRAINT insights_jobs_failure_check CHECK (
    failure_code IS NULL
    OR failure_code IN ('preparation-failed', 'migration-poison')
  )
);

CREATE UNIQUE INDEX private_hot_updater_insights_job_head_active_idx
  ON private_hot_updater_insights_job_heads(active_job_id, query_key);
CREATE INDEX private_hot_updater_insights_job_claim_idx
  ON private_hot_updater_insights_jobs(status, claimable_at_ms, id);
CREATE INDEX private_hot_updater_insights_job_lease_idx
  ON private_hot_updater_insights_jobs(status, lease_until_ms, id);
CREATE INDEX private_hot_updater_insights_job_query_idx
  ON private_hot_updater_insights_jobs(query_key, status, id);

CREATE TABLE private_hot_updater_insights_job_latest (
  job_id TEXT NOT NULL,
  install_key TEXT NOT NULL,
  bucket_index INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (job_id, install_key, bucket_index),
  CONSTRAINT insights_job_latest_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_latest_key_check CHECK (
    length(install_key) = 64 AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_job_latest_number_check CHECK (
    bucket_index >= -1 AND received_at_ms >= 0
    AND row_bytes >= 1 AND row_bytes <= 20480
  )
);

CREATE INDEX private_hot_updater_insights_job_latest_scan_idx
  ON private_hot_updater_insights_job_latest(
    job_id, bucket_index, install_key
  );

CREATE TABLE private_hot_updater_insights_job_memberships (
  job_id TEXT NOT NULL,
  count_key TEXT NOT NULL,
  install_key TEXT NOT NULL,
  install_id TEXT NOT NULL,
  section TEXT NOT NULL,
  metric TEXT NOT NULL,
  label TEXT NOT NULL,
  bucket_start_ms REAL NOT NULL,
  PRIMARY KEY (job_id, count_key, install_key),
  CONSTRAINT insights_job_memberships_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_memberships_key_check CHECK (
    length(install_key) = 64 AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_job_memberships_bucket_check CHECK (
    bucket_start_ms >= -1
  )
);

CREATE TABLE private_hot_updater_insights_job_counts (
  job_id TEXT NOT NULL,
  count_key TEXT NOT NULL,
  section TEXT NOT NULL,
  metric TEXT NOT NULL,
  label TEXT NOT NULL,
  bucket_start_ms REAL NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (job_id, count_key),
  CONSTRAINT insights_job_counts_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_counts_value_check CHECK (
    bucket_start_ms >= -1 AND value >= 1
  )
);

CREATE INDEX private_hot_updater_insights_job_count_order_idx
  ON private_hot_updater_insights_job_counts(
    job_id, section, metric, count_key
  );
CREATE INDEX private_hot_updater_insights_job_count_series_idx
  ON private_hot_updater_insights_job_counts(
    job_id, section, metric, label, bucket_start_ms
  );

CREATE TABLE private_hot_updater_insights_job_order (
  job_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  order_key TEXT NOT NULL,
  count_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (job_id, section_key, order_key),
  CONSTRAINT insights_job_order_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_order_value_check CHECK (value >= 1)
);

CREATE TABLE private_hot_updater_insights_job_page_rows (
  job_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  filter_label TEXT NOT NULL,
  filter_ordinal INTEGER NOT NULL,
  row_bytes INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (job_id, section_key, ordinal),
  CONSTRAINT insights_job_page_rows_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_page_rows_number_check CHECK (
    ordinal >= 0 AND filter_ordinal >= 0
    AND row_bytes >= 1 AND row_bytes <= 1048576
  )
);

CREATE INDEX private_hot_updater_insights_job_page_filter_idx
  ON private_hot_updater_insights_job_page_rows(
    job_id, section_key, filter_label, filter_ordinal
  );

CREATE TABLE private_hot_updater_insights_job_sections (
  job_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  PRIMARY KEY (job_id, section_key),
  CONSTRAINT insights_job_sections_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_sections_total_check CHECK (total_rows >= 0)
);

CREATE TRIGGER insights_job_latest_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_job_latest
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_job_latest
  WHERE job_id = NEW.job_id AND install_key = NEW.install_key
    AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_JOB_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER insights_job_membership_count_collision
BEFORE INSERT ON private_hot_updater_insights_job_memberships
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_job_counts
  WHERE job_id = NEW.job_id AND count_key = NEW.count_key
    AND (
      section <> NEW.section OR metric <> NEW.metric OR label <> NEW.label
      OR bucket_start_ms <> NEW.bucket_start_ms
    )
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_JOB_COUNT_COLLISION');
END;

CREATE TRIGGER insights_job_membership_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_job_memberships
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_job_memberships
  WHERE job_id = NEW.job_id AND install_key = NEW.install_key
    AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_JOB_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER insights_job_membership_count
AFTER INSERT ON private_hot_updater_insights_job_memberships
BEGIN
  INSERT INTO private_hot_updater_insights_job_counts (
    job_id, count_key, section, metric, label, bucket_start_ms, value
  ) VALUES (
    NEW.job_id, NEW.count_key, NEW.section, NEW.metric, NEW.label,
    NEW.bucket_start_ms, 1
  )
  ON CONFLICT(job_id, count_key) DO UPDATE SET value = value + 1;
END;
