-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "native_builds" ("id" TEXT NOT NULL, "scope_key" TEXT NOT NULL, "platform" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "fingerprint_hash" TEXT, "app_version" TEXT, "min_bundle_id" TEXT NOT NULL, "artifact_kind" TEXT NOT NULL, "artifact_storage_uri" TEXT NOT NULL, "byte_size" INTEGER NOT NULL, "git_commit_hash" TEXT, "created_at_ms" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "native_builds_byScope" ON "native_builds" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "native_builds_byChannel" ON "native_builds" ("channel_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_min_bundle_id" ON "native_builds" ("min_bundle_id");

CREATE TABLE IF NOT EXISTS "vault_secrets" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "kind" TEXT NOT NULL, "current_version" INTEGER NOT NULL, "metadata" TEXT NOT NULL, "created_at_ms" INTEGER NOT NULL, "updated_at_ms" INTEGER NOT NULL, "deleted_at_ms" INTEGER, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "vault_secrets_byName" ON "vault_secrets" ("name", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "vault_secrets_name" ON "vault_secrets" ("name");

CREATE TABLE IF NOT EXISTS "vault_secret_versions" ("secret_id" TEXT NOT NULL, "version" INTEGER NOT NULL, "kid" TEXT NOT NULL, "wrapped_dek" TEXT NOT NULL, "iv" TEXT NOT NULL, "ciphertext" TEXT NOT NULL, "created_at_ms" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("secret_id", "version"));

CREATE INDEX IF NOT EXISTS "vault_secret_versions_byKid" ON "vault_secret_versions" ("kid", "secret_id", "version");

CREATE TABLE IF NOT EXISTS "vault_tokens" ("id" TEXT NOT NULL, "hash" TEXT NOT NULL, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL, "scope" TEXT NOT NULL, "expires_at_ms" INTEGER, "created_at_ms" INTEGER NOT NULL, "revoked_at_ms" INTEGER, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "vault_tokens_byCreated" ON "vault_tokens" ("created_at_ms", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "vault_tokens_hash" ON "vault_tokens" ("hash");

CREATE TABLE IF NOT EXISTS "vault_audit" ("id" TEXT NOT NULL, "at_ms" INTEGER NOT NULL, "actor" TEXT NOT NULL, "action" TEXT NOT NULL, "secret_id" TEXT, "outcome" TEXT NOT NULL, "context" TEXT NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "vault_audit_byTime" ON "vault_audit" ("at_ms", "id");

CREATE INDEX IF NOT EXISTS "vault_audit_bySecret" ON "vault_audit" ("secret_id", "at_ms", "id");

CREATE INDEX IF NOT EXISTS "vault_audit_byActor" ON "vault_audit" ("actor", "at_ms", "id");

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.2.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.remoteConfig', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.vault', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
