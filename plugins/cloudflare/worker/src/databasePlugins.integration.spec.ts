import type {
  DeployReleasePolicy,
  EngineDatabase,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { builtInSchema, isMultiIndex } from "@hot-updater/server/database";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import {
  createHandlerHttpTestClient,
  setupDatabaseTestSuite,
} from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import {
  createBundleEventRowFixture,
  createBundleFixture,
  createBundleRowFixture,
} from "../../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "../../src/d1Database";
import { d1Database as d1RuntimeDatabase } from "../../src/worker";

const state = vi.hoisted<{ db: D1Database | undefined }>(() => ({
  db: undefined,
}));

class D1TestStateError extends Error {
  readonly name = "D1TestStateError";
}

const getDb = (): D1Database => {
  if (state.db === undefined) {
    throw new D1TestStateError();
  }
  return state.db;
};

vi.mock("cloudflare", () => ({
  default: class MockCloudflare {
    readonly d1 = {
      database: {
        query: async (
          _databaseId: string,
          input:
            | { readonly sql: string; readonly params?: readonly string[] }
            | {
                readonly batch: readonly {
                  readonly sql: string;
                  readonly params?: readonly string[];
                }[];
              },
        ) => {
          const statements =
            "batch" in input
              ? input.batch.map(({ sql, params }) =>
                  getDb()
                    .prepare(sql)
                    .bind(...(params ?? [])),
                )
              : (() => {
                  const params = input.params ?? [];
                  let paramOffset = 0;
                  return input.sql
                    .split(";")
                    .map((sql) => sql.trim())
                    .filter(Boolean)
                    .map((sql) => {
                      const paramCount = sql.match(/\?/g)?.length ?? 0;
                      const statement = getDb()
                        .prepare(sql)
                        .bind(
                          ...params.slice(
                            paramOffset,
                            paramOffset + paramCount,
                          ),
                        );
                      paramOffset += paramCount;
                      return statement;
                    });
                })();
          const results = await getDb().batch(statements);
          return {
            async *iterPages() {
              yield { result: results };
            },
          };
        },
      },
    };
  },
}));

/** Every data table: each model's table and the index tables of its multi-valued indexes. */
const dataTables = builtInSchema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

/** Empties every data table; the settings rows stay. */
const reset = async (): Promise<void> => {
  await getDb().batch(
    dataTables.map((name) => getDb().prepare(`DELETE FROM "${name}"`)),
  );
};

/**
 * A public server with Insights on `database`, as the suite serves it. The
 * specs here reach core and the Insights API through it.
 */
const serve = (options: {
  readonly database: EngineDatabase;
  readonly storage?: readonly StoragePlugin[];
}) =>
  createHotUpdater({
    ...options,
    plugins: [insights()],
    clientAccess: "public",
  });

const release = (channel: string, enabled: boolean): DeployReleasePolicy => ({
  channel,
  enabled,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.0",
});

setupDatabaseTestSuite({
  createHttpClient: (options) =>
    createHandlerHttpTestClient(serve(options).handlers),
  createInsightsModel: (database) =>
    createInsightsModel(serve({ database }).api.insights),
  name: "cloudflare d1 http",
  migrate: async () => {
    state.db = env.DB;
    await getDb().prepare(inject("prepareSql")).run();
  },
  createDatabase: () =>
    d1Database({
      accountId: "account-id",
      cloudflareApiToken: "api-token",
      databaseId: "database-id",
    }),
  reset,
  dispose: () => undefined,
});

setupDatabaseTestSuite({
  createHttpClient: (options) =>
    createHandlerHttpTestClient(serve(options).handlers),
  createInsightsModel: (database) =>
    createInsightsModel(serve({ database }).api.insights),
  name: "cloudflare worker d1",
  migrate: () => undefined,
  createDatabase: () => d1RuntimeDatabase(env.DB),
  reset,
  dispose: () => {
    state.db = undefined;
  },
});

describe.each([
  {
    name: "cloudflare d1 http",
    createDatabase: () =>
      d1Database({
        accountId: "account-id",
        cloudflareApiToken: "api-token",
        databaseId: "database-id",
      }),
  },
  {
    name: "cloudflare worker d1",
    createDatabase: () => d1RuntimeDatabase(env.DB),
  },
])("$name Channel deletion", ({ createDatabase }) => {
  beforeAll(() => {
    state.db = env.DB;
  });

  beforeEach(async () => {
    await reset();
  });

  afterAll(() => {
    state.db = undefined;
  });

  it("deletes only empty channels", async () => {
    const { core } = serve({ database: createDatabase() });
    const channel = await core.ensureChannel("empty");

    await expect(core.deleteChannel(channel.id)).resolves.toEqual({
      deleted: true,
    });
    await expect(core.deleteChannel(channel.id)).resolves.toEqual({
      deleted: false,
      reason: "not_found",
    });
  });

  it("keeps failed event inserts invisible, then safely retries", async () => {
    const model = createInsightsModel(
      serve({ database: createDatabase() }).api.insights,
    );
    const event = createBundleEventRowFixture("9101", 100);
    const input = { event };
    await env.DB.prepare(`
      CREATE TRIGGER fail_insights_event BEFORE INSERT ON bundle_events
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;
    `).run();
    try {
      // The engine reports a failed batch as ambiguous, with D1's error as its cause.
      await expect(model.recordEvent(input)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("injected event failure") },
      });
      expect(
        (await env.DB.prepare("SELECT * FROM bundle_events").all()).results,
      ).toEqual([]);
      await expect(
        model.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([]);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_insights_event").run();
    }
    await env.DB.prepare(`
      CREATE TRIGGER fail_insights_head BEFORE INSERT ON bundle_event_heads
      BEGIN SELECT RAISE(ABORT, 'injected head failure'); END;
    `).run();
    try {
      // The engine reports a failed batch as ambiguous, with D1's error as its cause.
      await expect(model.recordEvent(input)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("injected head failure") },
      });
      expect(
        (await env.DB.prepare("SELECT * FROM bundle_events").all()).results,
      ).toEqual([]);
      expect(
        (await env.DB.prepare("SELECT * FROM bundle_event_heads").all())
          .results,
      ).toEqual([]);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_insights_head").run();
    }
    await model.recordEvent(input);
    await model.recordEvent(input);
    await expect(
      model.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([input.event]);
    expect(
      (await env.DB.prepare("SELECT id FROM bundle_events").all()).results,
    ).toEqual([{ id: event.id }]);
  });

  it("refuses to delete a channel while a Release uses it", async () => {
    const { core } = serve({ database: createDatabase() });
    const channel = await core.ensureChannel("active");
    const bundle = createBundleFixture("902");
    await core.deploy([{ bundle, release: release(channel.name, true) }]);

    await expect(core.deleteChannel(channel.id)).resolves.toEqual({
      deleted: false,
      reason: "not_empty",
    });
    await expect(core.listChannels()).resolves.toEqual([channel]);
    await expect(core.getBundle(bundle.id)).resolves.toMatchObject({
      bundle: createBundleRowFixture("902"),
    });
  });

  it("deletes a channel once its last Release is deleted", async () => {
    const { core } = serve({ database: createDatabase() });
    const channel = await core.ensureChannel("retired");
    const bundle = createBundleFixture("903");
    const [deployed] = await core.deploy([
      { bundle, release: release(channel.name, false) },
    ]);
    const releaseId = deployed!.release!.id;

    await core.deleteRelease({ releaseId });
    await expect(core.deleteChannel(channel.id)).resolves.toEqual({
      deleted: true,
    });
    await expect(core.getRelease(releaseId)).resolves.toBeNull();
    await expect(core.getBundle(bundle.id)).resolves.toMatchObject({
      bundle: createBundleRowFixture("903"),
    });
    await expect(core.listChannels()).resolves.toEqual([]);
  });
});
