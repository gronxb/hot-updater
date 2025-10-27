CREATE TABLE "bundles" (
  "id" varchar(255) NOT NULL PRIMARY KEY,
  "platform" text NOT NULL,
  "should_force_update" boolean NOT NULL,
  "enabled" boolean NOT NULL,
  "file_hash" text NOT NULL,
  "git_commit_hash" text,
  "message" text,
  "channel" text NOT NULL,
  "storage_uri" text NOT NULL,
  "target_app_version" text,
  "fingerprint_hash" text,
  "metadata" json NOT NULL
);

CREATE TABLE "private_hot-updater_settings" (
  "key" varchar(255) PRIMARY KEY,
  "value" text NOT NULL
);

INSERT INTO
  "private_hot-updater_settings" ("key", "value")
VALUES
  ('version', '0.21.0');

INSERT INTO
  "private_hot-updater_settings" ("key", "value")
VALUES
  (
    'name-variants',
    '{"bundles":{"convex":"bundles","drizzle":"bundles","prisma":"bundles","mongodb":"bundles","sql":"bundles"},"bundles.id":{"convex":"id","drizzle":"id","prisma":"id","mongodb":"_id","sql":"id"},"bundles.platform":{"convex":"platform","drizzle":"platform","prisma":"platform","mongodb":"platform","sql":"platform"},"bundles.should_force_update":{"convex":"should_force_update","drizzle":"should_force_update","prisma":"should_force_update","mongodb":"should_force_update","sql":"should_force_update"},"bundles.enabled":{"convex":"enabled","drizzle":"enabled","prisma":"enabled","mongodb":"enabled","sql":"enabled"},"bundles.file_hash":{"convex":"file_hash","drizzle":"file_hash","prisma":"file_hash","mongodb":"file_hash","sql":"file_hash"},"bundles.git_commit_hash":{"convex":"git_commit_hash","drizzle":"git_commit_hash","prisma":"git_commit_hash","mongodb":"git_commit_hash","sql":"git_commit_hash"},"bundles.message":{"convex":"message","drizzle":"message","prisma":"message","mongodb":"message","sql":"message"},"bundles.channel":{"convex":"channel","drizzle":"channel","prisma":"channel","mongodb":"channel","sql":"channel"},"bundles.storage_uri":{"convex":"storage_uri","drizzle":"storage_uri","prisma":"storage_uri","mongodb":"storage_uri","sql":"storage_uri"},"bundles.target_app_version":{"convex":"target_app_version","drizzle":"target_app_version","prisma":"target_app_version","mongodb":"target_app_version","sql":"target_app_version"},"bundles.fingerprint_hash":{"convex":"fingerprint_hash","drizzle":"fingerprint_hash","prisma":"fingerprint_hash","mongodb":"fingerprint_hash","sql":"fingerprint_hash"},"bundles.metadata":{"convex":"metadata","drizzle":"metadata","prisma":"metadata","mongodb":"metadata","sql":"metadata"}}'
  );