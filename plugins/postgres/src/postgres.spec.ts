import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleEventRow,
  BundleRow,
  ChannelRow,
  ApiKeyRow,
  InsightsInstallationRow,
  ReleaseRow,
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
      "DELETE FROM bundle_installations; DELETE FROM bundle_events; DELETE FROM api_keys; DELETE FROM bundle_patches; DELETE FROM release_catalogs; DELETE FROM releases; DELETE FROM bundles; DELETE FROM channels;",
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

const bundleFixture = (): BundleRow => ({
  id: "00000000-0000-0000-0000-000000000701",
  platform: "ios",
  file_hash: "file-hash",
  git_commit_hash: null,
  storage_uri: "storage://bundles/701.zip",
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const releaseFixture = (
  channel: ChannelRow,
  bundle: BundleRow,
): ReleaseRow => ({
  id: "00000000-0000-7000-8000-000000000702",
  revision: 1,
  scope_key: `v1:test:${channel.name}:ios:app-version`,
  channel_id: channel.id,
  platform: bundle.platform,
  kind: "BUNDLE",
  bundle_id: bundle.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 100,
  updated_at_ms: 100,
});

const apiKeyFixture = (): ApiKeyRow => ({
  id: "00000000-0000-0000-0000-000000000901",
  hash: "channel-delete-race-hash",
  name: "channel-delete-race",
  prefix: "hu_test",
  role: "client",
  created_at_ms: 100,
  revoked_at_ms: null,
});

const insightsEventFixture = (input: {
  readonly id: string;
  readonly installId: string;
  readonly receivedAtMs: number;
  readonly userId: string;
}): BundleEventRow => ({
  id: input.id,
  type: "UPDATE_APPLIED",
  install_id: input.installId,
  user_id: input.userId,
  username: null,
  from_bundle_id: "00000000-0000-7000-8000-000000001001",
  from_release_id: null,
  to_bundle_id: "00000000-0000-7000-8000-000000001002",
  to_release_id: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "0",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: input.receivedAtMs,
});

const installationFixture = (
  event: BundleEventRow,
): InsightsInstallationRow => ({
  id: event.id,
  install_id: event.install_id,
  user_id: event.user_id,
  username: event.username,
  to_bundle_id: event.to_bundle_id,
  type: event.type,
  platform: event.platform,
  app_version: event.app_version,
  channel: event.channel,
  cohort: event.cohort,
  received_at_ms: event.received_at_ms,
});

describe("PostgreSQL artifact byte-size constraints", () => {
  it("rejects negative archive and patch sizes at the database boundary", async () => {
    const { database, plugin } = await createPostgresTestPlugin();
    const bundle = bundleFixture();

    try {
      await expect(
        database.exec(`
          INSERT INTO bundles (
            id, platform, file_hash, storage_uri, archive_byte_size, metadata
          ) VALUES (
            '${bundle.id}', 'ios', 'hash', 'storage://bundle', -1, '{}'
          )
        `),
      ).rejects.toThrow();

      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row: bundle }],
      });
      await expect(
        database.exec(`
          INSERT INTO bundle_patches (
            id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
            patch_storage_uri, byte_size
          ) VALUES (
            'patch-invalid-size', '${bundle.id}', '${bundle.id}', 'base-hash',
            'patch-hash', 'storage://patch', -1
          )
        `),
      ).rejects.toThrow();
    } finally {
      await plugin.dispose?.();
    }
  });
});

describe("PostgreSQL Insights projection", () => {
  it("counts beyond 50,000 reports and uses the bundle range index for a bounded drill-down", async () => {
    const { database, plugin } = await createPostgresTestPlugin();
    const bundleId = "00000000-0000-7000-8000-000000001002";
    try {
      await database.exec(`
        INSERT INTO bundle_events (
          id, type, install_id, from_bundle_id, to_bundle_id, platform,
          app_version, channel, cohort, update_strategy, received_at_ms
        )
        SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
          'UPDATE_APPLIED', 'install-scale',
          '00000000-0000-7000-8000-000000001001'::uuid,
          '${bundleId}'::uuid, 'ios', '1.0.0', 'production', '0', 'appVersion', n
        FROM generate_series(1, 50001) AS n;
        ANALYZE bundle_events;
      `);
      const filter = {
        type: "UPDATE_APPLIED",
        platform: "ios",
        channel: "production",
        toBundleId: bundleId,
      } as const;
      await expect(
        plugin.models.insights.countEvents({
          filter,
          sinceMs: 0,
          beforeReceivedAtMs: 50002,
        }),
      ).resolves.toBe(50001);
      const rows = await plugin.models.insights.listEvents({
        filter: { kind: "bundle", ...filter },
        sinceMs: 50000,
        beforeReceivedAtMs: 50002,
        limit: 101,
      });
      expect(rows.map((row) => row.received_at_ms)).toEqual([50001, 50000]);
      const sparseEvent = {
        ...insightsEventFixture({
          id: "00000000-0000-7000-8000-000000050002",
          installId: "sparse-installation",
          receivedAtMs: 25000,
          userId: "sparse-user",
        }),
        to_bundle_id: "00000000-0000-7000-8000-000000001003",
      };
      await plugin.models.insights.record({
        event: sparseEvent,
        installation: installationFixture(sparseEvent),
      });
      await database.exec("ANALYZE bundle_events");
      const plan = await database.query(`
        EXPLAIN (FORMAT JSON) SELECT * FROM bundle_events
        WHERE type = 'UPDATE_APPLIED' AND platform = 'ios' AND channel = 'production'
          AND to_bundle_id = '${sparseEvent.to_bundle_id}' AND received_at_ms >= 0 AND received_at_ms < 50002
        ORDER BY received_at_ms DESC, id DESC LIMIT 101
      `);
      expect(JSON.stringify(plan.rows)).toContain(
        "bundle_events_to_bundle_idx",
      );
    } finally {
      await plugin.dispose?.();
    }
  });

  it("rolls back the event when snapshot storage fails and permits retry", async () => {
    const { database, plugin } = await createPostgresTestPlugin();
    const event = insightsEventFixture({
      id: "00000000-0000-7000-8000-000000002101",
      installId: "install-atomic",
      receivedAtMs: 100,
      userId: "user-before-failure",
    });
    const input = { event, installation: installationFixture(event) };
    try {
      await database.exec(`
        CREATE FUNCTION fail_insights_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected snapshot failure'; END; $$;
        CREATE TRIGGER fail_insights_snapshot BEFORE INSERT ON bundle_installations
        FOR EACH ROW EXECUTE FUNCTION fail_insights_snapshot();
      `);
      await expect(plugin.models.insights.record(input)).rejects.toThrow(
        "injected snapshot failure",
      );
      expect(
        (await database.query("SELECT * FROM bundle_events")).rows,
      ).toEqual([]);
      expect(
        (await database.query("SELECT * FROM bundle_installations")).rows,
      ).toEqual([]);
      await database.exec(
        "DROP TRIGGER fail_insights_snapshot ON bundle_installations",
      );
      await plugin.models.insights.record(input);
      await plugin.models.insights.record(input);
      expect(
        (await database.query("SELECT id FROM bundle_events")).rows,
      ).toEqual([{ id: event.id }]);
      await expect(
        plugin.models.insights.findInstallations({
          installId: event.install_id,
        }),
      ).resolves.toEqual([input.installation]);
    } finally {
      await plugin.dispose?.();
    }
  });

  it("concurrent reports keep the greatest key and duplicate IDs cannot restore a user", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const first = insightsEventFixture({
      id: "00000000-0000-7000-8000-000000002201",
      installId: "install-race",
      receivedAtMs: 100,
      userId: "former-user",
    });
    const latest = {
      ...first,
      id: "00000000-0000-7000-8000-000000002203",
      user_id: null,
    };
    const stale = { ...first, id: "00000000-0000-7000-8000-000000002202" };
    try {
      await Promise.all(
        [latest, first, stale].map((event) =>
          plugin.models.insights.record({
            event,
            installation: installationFixture(event),
          }),
        ),
      );
      const reusedId = { ...first, received_at_ms: 200 };
      await plugin.models.insights.record({
        event: reusedId,
        installation: installationFixture(reusedId),
      });
      await expect(
        plugin.models.insights.findInstallations({
          installId: first.install_id,
        }),
      ).resolves.toEqual([installationFixture(latest)]);
      await expect(
        plugin.models.insights.findInstallations({
          userId: "former-user",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        plugin.models.insights.countEvents({
          filter: {
            type: "UPDATE_APPLIED",
            platform: "ios",
            channel: "production",
            toBundleId: first.to_bundle_id,
          },
          sinceMs: 100,
          beforeReceivedAtMs: 101,
        }),
      ).resolves.toBe(3);
    } finally {
      await plugin.dispose?.();
    }
  });

  it("keeps the latest installation row and counts active installations", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const userId = "current-user";
    const first = insightsEventFixture({
      id: "00000000-0000-7000-8000-000000002001",
      installId: "install-a",
      receivedAtMs: 100,
      userId,
    });
    const latestAtSameTime = insightsEventFixture({
      id: "00000000-0000-7000-8000-000000002003",
      installId: "install-a",
      receivedAtMs: 100,
      userId,
    });
    const staleAtSameTime = insightsEventFixture({
      id: "00000000-0000-7000-8000-000000002002",
      installId: "install-a",
      receivedAtMs: 100,
      userId,
    });
    const secondInstallation = insightsEventFixture({
      id: "00000000-0000-7000-8000-000000002004",
      installId: "install-b",
      receivedAtMs: 200,
      userId,
    });

    try {
      await plugin.models.insights.record({
        event: first,
        installation: installationFixture(first),
      });
      await plugin.models.insights.record({
        event: latestAtSameTime,
        installation: installationFixture(latestAtSameTime),
      });
      await plugin.models.insights.record({
        event: staleAtSameTime,
        installation: installationFixture(staleAtSameTime),
      });
      await plugin.models.insights.record({
        event: secondInstallation,
        installation: installationFixture(secondInstallation),
      });

      await expect(
        plugin.models.insights.findInstallations({ installId: "install-a" }),
      ).resolves.toEqual([installationFixture(latestAtSameTime)]);
      await expect(
        plugin.models.insights.findInstallations({
          userId,
          limit: 10,
        }),
      ).resolves.toEqual([
        installationFixture(latestAtSameTime),
        installationFixture(secondInstallation),
      ]);
      await expect(
        plugin.models.insights.countInstallations({
          platform: "ios",
          channel: "production",
          sinceMs: 101,
        }),
      ).resolves.toBe(1);
    } finally {
      await plugin.dispose?.();
    }
  });
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
      const bundle = bundleFixture();
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

  it("atomically refuses to delete a channel referenced by a Release", async () => {
    const { plugin } = await createPostgresTestPlugin();
    const channel = channelFixture(
      "active",
      "00000000-0000-0000-0000-000000000004",
    );
    const bundle = bundleFixture();
    const release = releaseFixture(channel, bundle);

    try {
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "releases", operation: "insert", row: release },
        ],
      });

      await expect(
        plugin.models.channels.delete({ id: channel.id }),
      ).resolves.toEqual({ deleted: false, reason: "not_empty" });
      await expect(
        plugin.commit({
          changes: [
            {
              model: "releases",
              operation: "update",
              where: { id: release.id },
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
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toEqual(release);
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
    const apiKey = apiKeyFixture();

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
              model: "apiKeys",
              operation: "insert",
              row: apiKey,
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
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    } finally {
      await plugin.dispose?.();
    }
  });
});
