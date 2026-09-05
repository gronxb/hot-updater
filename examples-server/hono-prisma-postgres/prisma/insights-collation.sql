-- Prisma's schema syntax cannot express the exact Insights identity ordering.
ALTER TABLE bundle_events ALTER COLUMN install_id TYPE varchar(255) COLLATE "C";
ALTER TABLE bundle_events ALTER COLUMN user_id TYPE varchar(255) COLLATE "C";
ALTER TABLE bundle_events ALTER COLUMN platform TYPE text COLLATE "C";
ALTER TABLE bundle_events ALTER COLUMN channel TYPE text COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN install_id TYPE varchar(255) COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN user_id TYPE varchar(255) COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN platform TYPE text COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN channel TYPE text COLLATE "C";
