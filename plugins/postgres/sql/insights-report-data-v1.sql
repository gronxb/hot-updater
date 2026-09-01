-- Private per-job output. A publication never shares mutable rows with its successor.
CREATE TABLE private_hot_updater_insights_report_members (
  job_id uuid NOT NULL,
  member_key text COLLATE "C" NOT NULL,
  identity jsonb NOT NULL,
  PRIMARY KEY (job_id, member_key)
);

CREATE TABLE private_hot_updater_insights_report_latest (
  job_id uuid NOT NULL,
  install_key text COLLATE "C" NOT NULL,
  bucket_index integer NOT NULL CHECK (bucket_index BETWEEN -1 AND 29),
  install_id text NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (job_id, install_key, bucket_index)
);
CREATE INDEX insights_report_latest_installations_idx
  ON private_hot_updater_insights_report_latest (job_id, bucket_index, install_key);

CREATE TABLE private_hot_updater_insights_report_counts (
  job_id uuid NOT NULL,
  count_key text COLLATE "C" NOT NULL,
  identity jsonb NOT NULL,
  section text COLLATE "C" NOT NULL,
  metric text COLLATE "C" NOT NULL,
  label text NOT NULL,
  bucket_start_ms bigint NOT NULL,
  value bigint NOT NULL CHECK (value > 0),
  PRIMARY KEY (job_id, count_key)
);
-- One immutable identity marker for every positive count. Point reads can
-- distinguish a legitimate sparse zero from a deleted published count row.
CREATE TABLE private_hot_updater_insights_report_count_manifest (
  job_id uuid NOT NULL,
  count_key text COLLATE "C" NOT NULL,
  identity jsonb NOT NULL,
  section text COLLATE "C" NOT NULL,
  metric text COLLATE "C" NOT NULL,
  label text NOT NULL,
  bucket_start_ms bigint NOT NULL,
  PRIMARY KEY (job_id, count_key)
);
CREATE INDEX insights_report_counts_bucket_idx
  ON private_hot_updater_insights_report_counts (job_id, section, metric, bucket_start_ms)
  WHERE section = 'movementSeries';
