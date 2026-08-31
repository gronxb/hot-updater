-- Immutable search aliases belong to one captured installation overview.
-- Keep full identities out of B-tree keys, including long or escaped aliases.
CREATE TABLE private_hot_updater_insights_report_aliases (
  job_id uuid NOT NULL,
  alias_key text COLLATE "C" NOT NULL,
  install_key text NOT NULL,
  identity json NOT NULL,
  PRIMARY KEY (job_id, alias_key)
);
