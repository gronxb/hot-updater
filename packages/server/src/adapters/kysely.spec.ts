import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { createHotUpdater } from "../index";
import {
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import { kyselyAdapter } from "./kysely";

const sqliteJsonBundle: Bundle = {
  id: "00000000-0000-0000-0000-000000000901",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "sqlite-json-hash",
  gitCommitHash: null,
  message: "sqlite json bundle",
  channel: "production",
  storageUri: "s3://bucket/sqlite-json.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: { app_version: "1.0.0" },
  targetCohorts: ["17", "qa-group"],
};

describe("kyselyAdapter sqlite provider", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<object>[] = [];

  afterEach(async () => {
    for (const kysely of kyselyInstances.splice(0)) {
      await kysely.destroy();
    }
    for (const db of databases.splice(0)) {
      await db.close();
    }
  });

  it("stores bundle JSON columns as text and round-trips them", async () => {
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely({ dialect: new PGliteDialect(db) });
    kyselyInstances.push(kysely);
    await db.exec(`
      create table bundles (
        id text primary key,
        platform text not null,
        should_force_update boolean not null,
        enabled boolean not null,
        file_hash text not null,
        git_commit_hash text,
        message text,
        channel text not null,
        storage_uri text not null,
        target_app_version text,
        fingerprint_hash text,
        metadata text not null,
        manifest_storage_uri text,
        manifest_file_hash text,
        asset_base_storage_uri text,
        rollout_cohort_count integer not null,
        target_cohorts text
      );
      create table bundle_patches (
        id text primary key,
        bundle_id text not null,
        base_bundle_id text not null,
        base_file_hash text not null,
        patch_file_hash text not null,
        patch_storage_uri text not null,
        order_index integer not null
      );
      create table ${HOT_UPDATER_SETTINGS_TABLE} (
        key text primary key,
        value text not null
      );
      insert into ${HOT_UPDATER_SETTINGS_TABLE} (key, value)
      values ('version', '${HOT_UPDATER_SCHEMA_VERSION}');
    `);
    const hotUpdater = createHotUpdater({
      database: kyselyAdapter({
        db: kysely,
        provider: "sqlite",
      }),
    });

    await hotUpdater.insertBundle(sqliteJsonBundle);
    const stored = await db.query<{
      metadata: string;
      target_cohorts: string;
    }>("select metadata, target_cohorts from bundles where id = $1", [
      sqliteJsonBundle.id,
    ]);
    const restored = await hotUpdater.getBundleById(sqliteJsonBundle.id);

    expect(stored.rows[0]).toEqual({
      metadata: JSON.stringify({ app_version: "1.0.0" }),
      target_cohorts: JSON.stringify(["17", "qa-group"]),
    });
    expect(restored?.metadata).toEqual({ app_version: "1.0.0" });
    expect(restored?.targetCohorts).toEqual(["17", "qa-group"]);
  });
});
