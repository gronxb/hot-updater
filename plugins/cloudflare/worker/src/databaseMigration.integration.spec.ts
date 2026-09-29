import { createHotUpdater } from "@hot-updater/server";
import { builtInSchema, isMultiIndex } from "@hot-updater/server/database";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "../../src/worker";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

/** Every data table: each model's table and the index tables of its multi-valued indexes. */
const dataTables = builtInSchema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

it("ships a single 1.0.0 initialization migration", () => {
  expect(inject("d1Migrations").map(({ name }) => name)).toEqual([
    "0001_hot-updater_1.0.0.sql",
  ]);
});

it("creates every table, the batch guard, and the settings the fence checks", async () => {
  const [migration] = inject("d1Migrations");
  // `exec` runs one statement per line, and a comment line is not one.
  await env.DB.exec(
    migration!.sql
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("--"))
      .join("\n"),
  );
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>()
  ).results.map(({ name }) => name);
  expect(tables.toSorted()).toEqual(
    ["_hu_write", "private_hot_updater_settings", ...dataTables].toSorted(),
  );
  const settings = await env.DB.prepare(
    "SELECT key, value FROM private_hot_updater_settings ORDER BY key",
  ).all<{ key: string; value: string }>();
  expect(settings.results.map(({ key }) => key)).toEqual([
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
