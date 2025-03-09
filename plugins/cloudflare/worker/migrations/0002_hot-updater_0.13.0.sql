-- Migration number: 0002 	 2025-03-07T16:25:12.486Z
-- HotUpdater.bundles

ALTER TABLE bundles
ADD COLUMN channel TEXT NOT NULL DEFAULT 'production';
