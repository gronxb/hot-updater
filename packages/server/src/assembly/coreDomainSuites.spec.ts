import { PGlite } from "@electric-sql/pglite";
import type { DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import { setupInsightsModelTestSuite } from "@hot-updater/test-utils";
import { afterAll } from "vitest";

import { registerDatabasePluginRelationTests } from "../../../test-utils/src/databasePluginRelationTests";
import {
  setupDatabasePluginTestRunner,
  type DatabasePluginTestLifecycle,
} from "../../../test-utils/src/databasePluginTestRunner";
import {
  commitLegacyChanges,
  coreModule,
  createCoreReads,
  deleteChannel,
  insertChannel,
} from "../core";
import { createDatabaseEngine } from "../database/database";
import { resolveSchema } from "../database/resolveSchema";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { pgliteExecutor } from "../database/sql/sqlTestExecutors";
import { apiKeysSchema, createApiKeyModel } from "../plugins/api-keys";
import {
  createInsightsModel,
  insights,
  insightsSchema,
} from "../plugins/insights";

const insightsModule = { id: "insights", schema: insightsSchema } as const;
const apiKeysModule = { id: "apiKeys", schema: apiKeysSchema } as const;
const schema = resolveSchema([coreModule, insightsModule, apiKeysModule]);

const unsupported = (): never => {
  throw new Error("C3's legacy façade serves this read.");
};

/**
 * Today's `DatabasePlugin` over core, Insights, and API keys on one engine,
 * with the models the ported suites use; C3's façade serves the rest.
 */
const createDomainPlugin = (adapter: DatabaseAdapter): DatabasePlugin => {
  const engine = createDatabaseEngine({ adapter, schema });
  const core = engine.database(coreModule);
  const reads = createCoreReads(core, { resolveFileUrl: async () => null });
  const insightsApi = insights().init({
    db: engine.database(insightsModule),
    core: {},
    now: Date.now,
  }).api;
  return {
    name: "core-engine",
    commit: (input) => commitLegacyChanges(core, input),
    models: {
      bundles: {
        findById: async (id) => (await reads.getBundle(id))?.bundle ?? null,
        findMany: unsupported,
        count: unsupported,
      },
      bundlePatches: {
        findByBundleIds: async (ids) =>
          (await Promise.all(ids.map((id) => reads.getBundle(id)))).flatMap(
            (detail) => detail?.patches ?? [],
          ),
      },
      releases: {
        findById: (id) => reads.getRelease(id),
        findMany: unsupported,
        findManyByScope: unsupported,
      },
      releaseCatalogs: {
        findByScopeKey: (scopeKey) => reads.getReleaseCatalogRow(scopeKey),
        findMany: unsupported,
      },
      channels: {
        insert: ({ row }) => insertChannel(core, row),
        list: async () => ({ channels: await reads.listChannels() }),
        delete: ({ id }) => deleteChannel(core, id),
      },
      insights: createInsightsModel(insightsApi),
      apiKeys: createApiKeyModel(engine.database(apiKeysModule)),
    },
  };
};

/** One plugin for the whole suite, over a fresh adapter per test. */
const lifecycle = (
  name: string,
  createAdapter: () => Promise<DatabaseAdapter>,
): DatabasePluginTestLifecycle<DatabasePlugin> => {
  let current: DatabasePlugin | undefined;
  const plugin = (): DatabasePlugin => current!;
  const forward = <K extends keyof DatabasePlugin["models"]>(model: K) =>
    new Proxy({} as DatabasePlugin["models"][K], {
      get: (_, method) => Reflect.get(plugin().models[model] as object, method),
    });
  return {
    name,
    createPlugin: () => ({
      name,
      commit: (input) => plugin().commit(input),
      models: {
        bundles: forward("bundles"),
        bundlePatches: forward("bundlePatches"),
        releases: forward("releases"),
        releaseCatalogs: forward("releaseCatalogs"),
        channels: forward("channels"),
        insights: forward("insights"),
        apiKeys: forward("apiKeys"),
      },
    }),
    migrate: () => undefined,
    reset: async () => {
      current = createDomainPlugin(await createAdapter());
    },
    dispose: () => undefined,
  };
};

const pglite = new PGlite();
afterAll(() => pglite.close());
let tables = 0;

for (const [name, createAdapter] of [
  ["core on the engine (memory)", async () => createMemoryAdapter()],
  [
    "core on the engine (PGlite)",
    async () => {
      tables += 1;
      const adapter = createSqlAdapter({
        executor: pgliteExecutor(pglite),
        tablePrefix: `c${tables}_`,
      });
      await adapter.migrations?.apply(schema.tables);
      return adapter;
    },
  ],
] as const) {
  const suite = lifecycle(name, createAdapter);
  setupInsightsModelTestSuite(suite);
  setupDatabasePluginTestRunner(
    { ...suite, name: `${name}: relations` },
    registerDatabasePluginRelationTests,
  );
}
