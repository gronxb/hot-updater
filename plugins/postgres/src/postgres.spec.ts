import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { analyticsProviderToken } from "@hot-updater/analytics/provider";
import type { DatabaseRow } from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";
import { expect, it } from "vitest";

import { postgres } from "./postgres";

type BundleEventRow = DatabaseRow<"bundle_events">;

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

it("contributes the Analytics provider capability", async () => {
  // Given / When
  const plugin = postgres({ connectionString: "postgres://localhost/test" });

  // Then
  expect(getCapabilityContributions(plugin).map(({ token }) => token)).toEqual([
    analyticsProviderToken,
  ]);
  await plugin.onUnmount?.();
});

it("upgrades a pre-0.38 installation for bundle event writes and reads", async () => {
  // Given
  const database = new PGlite();
  const preV038Schema = await fs.readFile(
    path.resolve("plugins/postgres/src/__fixtures__/bundles.pre-0.38.sql"),
    "utf8",
  );
  const migration = await fs.readFile(
    path.resolve("plugins/postgres/sql/migrations/0.38.0-bundle-events.sql"),
    "utf8",
  );
  await database.exec(preV038Schema);
  const plugin = postgres({ dialect: new PGliteDialect(database) });
  const event = {
    id: "00000000-0000-0000-0000-000000000101",
    type: "UPDATE_APPLIED",
    install_id: "install-pre-v038",
    user_id: "user-1",
    username: "tester",
    from_bundle_id: "00000000-0000-0000-0000-000000000001",
    to_bundle_id: "00000000-0000-0000-0000-000000000002",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "cohort-1",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: "0.38.0",
    received_at_ms: 1_000,
  } satisfies BundleEventRow;

  // When
  await database.exec(migration);
  await plugin.create({ model: "bundle_events", data: event });
  const stored = await plugin.findOne({
    model: "bundle_events",
    where: [{ field: "id", value: event.id }],
  });

  // Then
  expect(stored).toEqual(event);
  await plugin.onUnmount?.();
});

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
      "DELETE FROM bundle_events; DELETE FROM bundle_patches; DELETE FROM bundles;",
    );
  },
  dispose: async (plugin) => {
    await plugin.onUnmount?.();
    client = undefined;
  },
});
