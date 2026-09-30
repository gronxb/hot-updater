import { createHotUpdater } from "@hot-updater/server";
import { isMultiIndex, toolingTargetOf } from "@hot-updater/server/database";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import { createBundleEventRowFixture } from "@hot-updater/server/plugins/insights/testing";
import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { d1SchemaSql } from "../../src/d1Schema";
import { plugins } from "../../src/plugins";
import { d1Database } from "../../src/worker";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

/** Every data table of a target: each model's table and the index tables of its multi-valued indexes. */
const dataTablesOf = (target: ReturnType<typeof toolingTargetOf>) =>
  target.schema.tables.flatMap((table) => [
    table.name,
    ...table.indexes
      .filter((index) => isMultiIndex(table, index))
      .map((index) => `${table.name}__${index.name}`),
  ]);

/** Runs a migration file's statements; `exec` takes one per line, and no comment line. */
const execMigration = (sql: string) =>
  env.DB.exec(
    sql
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("--"))
      .join("\n"),
  );

const tableNames = async () =>
  (
    await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results
    .map(({ name }) => name)
    .toSorted();

const settingKeys = async () =>
  (
    await env.DB.prepare(
      "SELECT key FROM private_hot_updater_settings ORDER BY key",
    ).all<{ key: string }>()
  ).results.map(({ key }) => key);

it("ships a single 1.0.0 initialization migration", () => {
  expect(inject("d1Migrations").map(({ name }) => name)).toEqual([
    "0001_hot-updater_1.0.0.sql",
  ]);
});

it("creates core's tables first, then the tables and settings of the plugins init migrates", async () => {
  const [migration] = inject("d1Migrations");
  await execMigration(migration!.sql);

  expect(await tableNames()).toEqual(
    [
      "_hu_write",
      "private_hot_updater_settings",
      ...dataTablesOf(toolingTargetOf([])),
    ].toSorted(),
  );
  expect(await settingKeys()).toEqual(["schema.core", "schema.engine"]);

  // What init migrates for the plugins the managed Worker runs.
  await execMigration(d1SchemaSql(toolingTargetOf(plugins)));

  expect(await tableNames()).toEqual(
    [
      "_hu_write",
      "private_hot_updater_settings",
      ...dataTablesOf(toolingTargetOf(plugins)),
    ].toSorted(),
  );
  expect(await settingKeys()).toEqual([
    "schema.apiKeys",
    "schema.core",
    "schema.engine",
    "schema.insights",
  ]);
});

it("returns canonical downloaded and applied events from the initialized D1 schema", async () => {
  const model = createInsightsModel(
    createHotUpdater({
      database: d1Database(env.DB),
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
