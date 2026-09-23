import { PGlite } from "@electric-sql/pglite";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll } from "vitest";

import { generateEngineSql } from "../db/engineSql";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createHotUpdater } from "../index";
import {
  createLegacyDatabasePlugin,
  legacyFacadeSchema,
  legacyFacadeSettings,
  migrateLegacyFacade,
} from "./legacyFacade";
import { createSqlAdapter } from "./sql/sqlAdapter";
import { pgliteExecutor } from "./sql/sqlTestExecutors";

type Plugin = DatabaseAdapterWithCapabilities;

/** One plugin object for the suite; each test gets a fresh façade behind it. */
const resettable = (createAdapter: () => Promise<DatabaseAdapter>) => {
  let current: Plugin | undefined;
  const facade = () => current!;
  const forward = <K extends keyof Plugin["models"]>(model: K) =>
    new Proxy({} as Plugin["models"][K], {
      get: (_, method) => Reflect.get(facade().models[model] as object, method),
      has: (_, method) => Reflect.has(facade().models[model] as object, method),
    });
  const plugin: Plugin = {
    name: "legacy façade",
    models: {
      bundles: forward("bundles"),
      bundlePatches: forward("bundlePatches"),
      releases: forward("releases"),
      releaseCatalogs: forward("releaseCatalogs"),
      channels: forward("channels"),
      insights: forward("insights"),
      apiKeys: forward("apiKeys"),
    },
    commit: (input) => facade().commit(input),
    get engineAdapter() {
      return facade().engineAdapter;
    },
  };
  return {
    plugin,
    reset: async () => {
      const adapter = await createAdapter();
      current = createLegacyDatabasePlugin({
        name: "legacy façade",
        adapter,
        fence: true,
      });
    },
  };
};

const pglite = new PGlite();
afterAll(() => pglite.close());
let tables = 0;

for (const [name, createAdapter] of [
  [
    "legacy façade (memory)",
    async () => {
      const adapter = createMemoryAdapter();
      await migrateLegacyFacade(adapter, "memory");
      return adapter;
    },
  ],
  [
    "legacy façade (PGlite)",
    async () => {
      tables += 1;
      // The shared SQL schema, database foreign keys included.
      const tablePrefix = `f${tables}_`;
      await pglite.exec(
        generateEngineSql(
          "postgresql",
          legacyFacadeSchema,
          legacyFacadeSettings,
          { tablePrefix },
        ).join(";\n"),
      );
      return createSqlAdapter({
        executor: pgliteExecutor(pglite),
        tablePrefix,
      });
    },
  ],
] as const) {
  const { plugin, reset } = resettable(createAdapter);
  setupDatabasePluginTestSuite({
    name,
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({ ...options, clientAccess: { type: "public" } })
          .handlers,
      ),
    createPlugin: () => plugin,
    migrate: () => undefined,
    reset,
    dispose: () => undefined,
  });
}
