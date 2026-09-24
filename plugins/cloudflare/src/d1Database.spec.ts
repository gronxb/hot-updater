import type { DeployReleasePolicy } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { DatabaseConstraintError } from "@hot-updater/server/database";
import {
  createDatabaseCoreApi,
  createMigrator,
  generateSchema,
} from "@hot-updater/server/db";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";
import { beforeEach, expect, it, vi } from "vitest";

import { createBundleFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "./d1Database";
import { createD1TestDatabase } from "./d1TestDatabase";

type Body = {
  readonly sql?: string;
  readonly params?: readonly string[];
  readonly batch?: readonly { sql: string; params: readonly string[] }[];
};

const state = vi.hoisted(() => ({
  database: undefined as ReturnType<typeof createD1TestDatabase> | undefined,
  bodies: [] as Body[],
}));

/** The REST API over `node:sqlite`, recording each request body. */
vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    readonly d1 = {
      database: {
        query: async (_databaseId: string, body: Body) => {
          state.bodies.push(body);
          const result = state.database!.batch(
            body.batch ?? [{ sql: body.sql!, params: body.params ?? [] }],
          );
          return {
            async *iterPages() {
              yield { result };
            },
          };
        },
      },
    };
  },
}));

const config = {
  accountId: "account-id",
  cloudflareApiToken: "api-token",
  databaseId: "database-id",
};

/** Core's API over the REST database, as the CLI and console run it. */
const core = () => createDatabaseCoreApi(d1Database(config));

/** A third-party plugin with one table. */
const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: ({ db }) => ({
    api: {
      add: (id: string, text: string) =>
        db.transaction(async (tx) => {
          tx.create("notes", { id, text });
        }),
      read: (id: string) => db.findOne("notes", { id }),
    },
  }),
});

const server = () =>
  createHotUpdater({
    database: d1Database(config),
    plugins: [notes],
    clientAccess: "public",
  });

const release: DeployReleasePolicy = {
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.0",
};

beforeEach(() => {
  state.database = createD1TestDatabase();
  state.bodies = [];
});

it("binds every value as JSON text and reads it back with json_extract", async () => {
  const channel = await core().ensureChannel("production");
  await expect(core().listChannels()).resolves.toEqual([channel]);
  const statements = state.bodies.flatMap(
    (body) => body.batch ?? [{ sql: body.sql!, params: body.params ?? [] }],
  );
  for (const { sql, params } of statements) {
    expect(sql.match(/\?/gu)?.length ?? 0).toBe(
      sql.match(/json_extract\(\?, '\$'\)/gu)?.length ?? 0,
    );
    for (const param of params) expect(() => JSON.parse(param)).not.toThrow();
  }
});

it("sends a write as one batch: the guard row, each guard, the changes, then the failure", async () => {
  await core().ensureChannel("production");
  state.bodies = [];
  const [deployed] = await core().deploy([
    { bundle: createBundleFixture("1"), release },
  ]);
  const writes = state.bodies.filter((body) => body.batch !== undefined);
  expect(writes).toHaveLength(1);
  const sql = writes[0]!.batch!.map((statement) => statement.sql);
  expect(sql[0]).toMatch(/^INSERT INTO "_hu_write"/u);
  expect(sql.at(-2)).toMatch(/^SELECT "failed_op" FROM "_hu_write"/u);
  expect(sql.at(-1)).toMatch(/^DELETE FROM "_hu_write"/u);
  await expect(core().getRelease(deployed!.release!.id)).resolves.toEqual(
    deployed!.release,
  );
});

it("applies nothing when a guard fails", async () => {
  const bundle = createBundleFixture("2");
  // The patch's base bundle does not exist, so the guard on its row fails.
  await expect(
    core().deploy([
      {
        bundle: {
          ...bundle,
          patches: [
            {
              baseBundleId: createBundleFixture("1").id,
              baseFileHash: "base-hash",
              byteSize: 1,
              patchFileHash: "patch-hash",
              patchStorageUri: "storage://patches/2.patch",
            },
          ],
        },
        release,
      },
    ]),
  ).rejects.toBeInstanceOf(DatabaseConstraintError);
  await expect(core().getBundle(bundle.id)).resolves.toBeNull();
  await expect(
    core().listReleases({ limit: 10, filter: { kind: "all" } }),
  ).resolves.toEqual([]);
});

it("generates a wrangler migration with a server's plugin tables", async () => {
  const hotUpdater = server();
  const migration = generateSchema(hotUpdater, "latest");
  expect(migration.path).toMatch(/^migrations\/\d{14}_hot-updater\.sql$/u);
  await expect(hotUpdater.api.notes.read("n1")).rejects.toThrow(
    '"schema.notes" for d1Database is missing',
  );

  state.database!.db.exec(migration.code);
  await hotUpdater.api.notes.add("n1", "hello");
  await expect(hotUpdater.api.notes.read("n1")).resolves.toEqual({
    id: "n1",
    text: "hello",
  });
});

it("migrates an empty database's tables, write guard included, through the API", async () => {
  state.database = createD1TestDatabase([]);
  const hotUpdater = server();
  const result = await createMigrator(hotUpdater).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();

  await hotUpdater.api.notes.add("n1", "hello");
  const [deployed] = await hotUpdater.core.deploy([
    { bundle: createBundleFixture("1"), release },
  ]);
  await expect(
    hotUpdater.core.getRelease(deployed!.release!.id),
  ).resolves.toEqual(deployed!.release);
});
