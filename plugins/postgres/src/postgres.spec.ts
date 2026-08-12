import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleRow,
  ChannelRow,
  ClientAccessKeyRow,
} from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import { postgres } from "./postgres";

class PostgresTestStateError extends Error {
  readonly name = "PostgresTestStateError";
}

let client: PGlite | undefined;

const getClient = (): PGlite => {
  if (client === undefined) {
    throw new PostgresTestStateError();
  }
  return client;
};

setupDatabasePluginTestSuite({
  name: "postgres fixed-model database plugin",
  migrate: async () => {
    client = new PGlite();
    const schema = await fs.readFile(
      path.resolve("plugins/postgres/sql/bundles.sql"),
      "utf8",
    );
    await client.exec(schema);
  },
  createPlugin: () => postgres({ dialect: new PGliteDialect(getClient()) }),
  reset: async () => {
    await getClient().exec(
      "DELETE FROM bundle_events; DELETE FROM client_access_keys; DELETE FROM bundle_patches; DELETE FROM bundles; DELETE FROM channels;",
    );
  },
  dispose: async (plugin) => {
    await plugin.dispose?.();
    client = undefined;
  },
});

const createPostgresTestPlugin = async () => {
  const database = new PGlite();
  const schema = await fs.readFile(
    path.resolve("plugins/postgres/sql/bundles.sql"),
    "utf8",
  );
  await database.exec(schema);
  return {
    database,
    plugin: postgres({ dialect: new PGliteDialect(database) }),
  };
};

const channelFixture = (name: string, id: string): ChannelRow => ({ id, name });

const bundleFixture = (channel: ChannelRow): BundleRow => ({
  id: "00000000-0000-0000-0000-000000000701",
  platform: "ios",
  should_force_update: false,
  enabled: true,
  file_hash: "file-hash",
  git_commit_hash: null,
  message: null,
  channel: channel.name,
  channel_id: channel.id,
  storage_uri: "storage://bundles/701.zip",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const accessKeyFixture = (): ClientAccessKeyRow => ({
  id: "00000000-0000-0000-0000-000000000901",
  hash: "channel-delete-race-hash",
  name: "channel-delete-race",
  prefix: "hu_test",
  role: "client",
  created_at_ms: 100,
  revoked_at_ms: null,
});

describe("PostgreSQL channel model", () => {
  it("returns the canonical row when concurrent names conflict", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const first = channelFixture(
      "preview",
      "00000000-0000-0000-0000-000000000001",
    );
    const second = {
      id: "00000000-0000-0000-0000-999999999999",
      name: first.name,
    };

    try {
      const results = await Promise.all([
        plugin.models.channels.insert({
          row: first,
          onConflict: "returnExisting",
        }),
        plugin.models.channels.insert({
          row: second,
          onConflict: "returnExisting",
        }),
      ]);

      expect(results[0]?.row).toEqual(results[1]?.row);
      expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [results[0]!.row],
      });
    } finally {
      await plugin.dispose?.();
    }
  });

  it("lists persisted empty channels without consulting bundles", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const channel = channelFixture(
      "empty-channel",
      "00000000-0000-0000-0000-000000000002",
    );

    try {
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      const bundle = bundleFixture(channel);
      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row: bundle }],
      });
      await plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "delete",
            where: { id: bundle.id },
          },
        ],
      });

      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    } finally {
      await plugin.dispose?.();
    }
  });

  it("deletes an empty channel and reports a missing channel", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const channel = channelFixture(
      "temporary",
      "00000000-0000-0000-0000-000000000003",
    );

    try {
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });

      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: true });
      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: false, reason: "not_found" });
    } finally {
      await plugin.dispose?.();
    }
  });

  it("atomically refuses to delete a channel referenced by a bundle", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const channel = channelFixture(
      "active",
      "00000000-0000-0000-0000-000000000004",
    );
    const bundle = bundleFixture(channel);

    try {
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row: bundle }],
      });

      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: false, reason: "not_empty" });
      await expect(
        plugin.commit({
          changes: [
            {
              model: "bundles",
              operation: "update",
              where: { id: bundle.id },
              update: { enabled: false },
            },
            {
              model: "channels",
              operation: "delete",
              where: { id: channel.id },
            },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "referenced" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    } finally {
      await plugin.dispose?.();
    }
  });

  it("maps a raced FK rejection and rolls back earlier commit changes", async () => {
    const { database, plugin } = await createPostgresTestPlugin();
    const channel = channelFixture(
      "racing",
      "00000000-0000-0000-0000-000000000005",
    );
    const accessKey = accessKeyFixture();

    try {
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await database.exec(`
        CREATE FUNCTION reject_channel_delete_after_reference_race()
        RETURNS trigger AS $$
        BEGIN
          RAISE foreign_key_violation;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER channel_delete_reference_race
        BEFORE DELETE ON channels
        FOR EACH ROW
        EXECUTE FUNCTION reject_channel_delete_after_reference_race();
      `);

      await expect(
        plugin.commit({
          changes: [
            {
              model: "clientAccessKeys",
              operation: "insert",
              row: accessKey,
              onConflict: "ignore",
            },
            {
              model: "channels",
              operation: "delete",
              where: { id: channel.id },
            },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "referenced" },
      });
      await expect(
        plugin.models.clientAccessKeys.findByHash(accessKey.hash),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    } finally {
      await plugin.dispose?.();
    }
  });
});
