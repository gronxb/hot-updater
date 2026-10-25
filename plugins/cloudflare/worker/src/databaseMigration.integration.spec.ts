import {
  isMultiIndex,
  type SqlStatement,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  apiKeys,
  createInsightsModel,
  insights,
  remoteConfig,
} from "@hot-updater/server/plugins";
import {
  createBundleEventRowFixture,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { toSqlResult } from "../../src/d1Executor";
import { applyD1Migrations } from "../../src/d1Migrations";
import { d1Database } from "../../src/worker";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

/** Every data table of the managed server's migration: each model's table and the index tables of its multi-valued indexes. */
const dataTables = toolingTargetOf([
  insights(),
  apiKeys(),
  remoteConfig(),
]).schema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

/** A migration as `exec` runs it: one statement per line, and a comment line is not one. */
const execable = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("--"))
    .join("\n");

/** The D1 binding as `applyD1Migrations` runs statements: one at a time, or a batch in one transaction. */
const runner = {
  query: async ({ sql, params }: SqlStatement) =>
    toSqlResult(
      await env.DB.prepare(sql)
        .bind(...params)
        .all(),
    ),
  batch: async (statements: readonly SqlStatement[]) =>
    (
      await env.DB.batch(
        statements.map(({ sql, params }) =>
          env.DB.prepare(sql).bind(...params),
        ),
      )
    ).map(toSqlResult),
};

it("leaves alone a database the managed init did not create", async () => {
  await expect(
    applyD1Migrations(runner, inject("d1Migrations")),
  ).resolves.toEqual({
    skip: expect.stringContaining("hot-updater db generate"),
    unmanaged: true,
  });
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_cf_%'",
  ).all();
  expect(tables.results).toEqual([]);
});

it("runs the migrations a database initialized by an earlier release has not run, and records them", async () => {
  const [first, ...later] = inject("d1Migrations");
  // What `wrangler d1 migrations apply` left when init ran with only the first.
  await env.DB.exec(execable(first!.sql));
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
  );
  await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)")
    .bind(first!.name)
    .run();

  await expect(
    applyD1Migrations(runner, inject("d1Migrations")),
  ).resolves.toEqual({ applied: later.map(({ name }) => name) });
  const recorded = await env.DB.prepare(
    "SELECT name FROM d1_migrations ORDER BY id",
  ).all<{ name: string }>();
  expect(recorded.results.map(({ name }) => name)).toEqual(
    inject("d1Migrations").map(({ name }) => name),
  );
  await expect(
    applyD1Migrations(runner, inject("d1Migrations")),
  ).resolves.toEqual({ applied: [] });
  // The managed server's fence passes.
  await expect(
    createHotUpdater({
      database: d1Database(env.DB),
      storage: createReleaseCatalogTestStorage(),
      plugins: [insights(), apiKeys(), remoteConfig()],
    }).core.listChannels(),
  ).resolves.toEqual([]);
});

it("creates every table, the batch guard, the migration records, and the settings the fence checks", async () => {
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results.map(({ name }) => name);
  expect(tables.toSorted()).toEqual(
    [
      "_hu_write",
      "d1_migrations",
      "private_hot_updater_settings",
      ...dataTables,
    ].toSorted(),
  );
  const settings = await env.DB.prepare(
    "SELECT key, value FROM private_hot_updater_settings ORDER BY key",
  ).all<{ key: string; value: string }>();
  expect(settings.results.map(({ key }) => key)).toEqual([
    "schema.apiKeys",
    "schema.core",
    "schema.engine",
    "schema.insights",
    "schema.remoteConfig",
  ]);
});

it("publishes a Remote Config template and serves it from the initialized D1 schema", async () => {
  const api = createHotUpdater({
    database: d1Database(env.DB),
    storage: createReleaseCatalogTestStorage(),
    plugins: [remoteConfig()],
    clientAccess: "public",
  }).api.remoteConfig;
  const template = {
    conditions: [
      {
        name: "Android",
        rules: [{ type: "platform", platforms: ["android"] }],
      },
    ],
    parameters: {
      greeting: {
        valueType: "STRING",
        defaultValue: { value: "Hi" },
        conditionalValues: { Android: { value: "Hi, Android" } },
      },
    },
  };
  await expect(
    api.publish({ template, baseVersion: 0 }),
  ).resolves.toMatchObject({ status: "published", version: { version: 1 } });
  await expect(api.getActive()).resolves.toMatchObject({
    version: 1,
    template,
  });
  await expect(api.resolve({ platform: "android" })).resolves.toEqual({
    version: 1,
    values: { greeting: "Hi, Android" },
  });
});

it("returns canonical downloaded and applied events from the initialized D1 schema", async () => {
  const model = createInsightsModel(
    createHotUpdater({
      database: d1Database(env.DB),
      storage: createReleaseCatalogTestStorage(),
      plugins: [insights()],
      clientAccess: "public",
    }).api.insights,
  );
  const download = {
    ...createBundleEventRowFixture("9601", 100),
    type: "UPDATE_DOWNLOADED" as const,
    from_bundle_id: "00000000-0000-7000-8000-000000001001",
    metadata: {
      ...createBundleEventRowFixture("9601", 100).metadata,
      update_strategy: "appVersion" as const,
    },
  };
  await model.recordEvent({ event: download });
  await expect(
    model.findLatestEvents({
      installId: download.install_id,
    }),
  ).resolves.toEqual([download]);
  const applied = {
    ...download,
    id: createBundleEventRowFixture("9602", 200).id,
    type: "UPDATE_APPLIED" as const,
    received_at_ms: 200,
  };
  await model.recordEvent({ event: applied });
  await model.recordEvent({ event: download });
  await expect(
    model.findLatestEvents({
      installId: download.install_id,
    }),
  ).resolves.toEqual([applied]);
});
