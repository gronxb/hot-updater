-- Sort by small native ordinals, never a B-tree key containing the full label.
CREATE INDEX insights_report_counts_order_input_idx
  ON private_hot_updater_insights_report_counts(job_id, section, metric, count_key)
  WHERE section IN ('movementCohorts', 'bundleDistribution', 'activeBundleTotals');

CREATE TABLE private_hot_updater_insights_report_order_states (
  job_id uuid NOT NULL,
  section text COLLATE "C" NOT NULL,
  metric text COLLATE "C" NOT NULL,
  phase text NOT NULL CHECK (phase IN ('copy', 'merge', 'ready')),
  after_count_key text COLLATE "C",
  total_rows bigint NOT NULL CHECK (total_rows >= 0),
  sort_pass smallint NOT NULL CHECK (sort_pass BETWEEN 0 AND 58),
  pair bigint NOT NULL CHECK (pair >= 0),
  left_pos bigint NOT NULL CHECK (left_pos >= 0),
  right_pos bigint NOT NULL CHECK (right_pos >= 0),
  out_pos bigint NOT NULL CHECK (out_pos >= 0),
  PRIMARY KEY (job_id, section, metric),
  CHECK ((section = 'movementCohorts' AND metric IN ('installed', 'recovered'))
    OR (section IN ('bundleDistribution', 'activeBundleTotals') AND metric = ''))
);

CREATE TABLE private_hot_updater_insights_report_order_rows (
  job_id uuid NOT NULL,
  section text COLLATE "C" NOT NULL,
  metric text COLLATE "C" NOT NULL,
  sort_pass smallint NOT NULL CHECK (sort_pass BETWEEN 0 AND 58),
  run_number bigint NOT NULL CHECK (run_number >= 0),
  row_position bigint NOT NULL CHECK (row_position >= 0),
  label text NOT NULL,
  value bigint NOT NULL CHECK (value > 0),
  count_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (job_id, section, metric, sort_pass, run_number, row_position),
  CHECK ((section = 'movementCohorts' AND metric IN ('installed', 'recovered'))
    OR (section IN ('bundleDistribution', 'activeBundleTotals') AND metric = ''))
);
