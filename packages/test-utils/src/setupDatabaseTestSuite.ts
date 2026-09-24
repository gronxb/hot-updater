import type {
  EngineDatabase,
  InsightsModel,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe } from "vitest";

import {
  setupDatabaseTestRunner,
  type DatabaseTestLifecycle,
} from "./databaseTestRunner";
import type { HttpTestServer } from "./httpTestClient";
import { registerInsightsModelTests } from "./insightsModelTests";
import { createReleaseCatalogTestStorage } from "./releaseCatalogHttpFixtures";
import { setupBundleMethodsTestSuite } from "./setupBundleMethodsTestSuite";
import { setupCoreAdminTestSuite } from "./setupCoreAdminTestSuite";
import { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";
import { setupReleaseCatalogTestSuite } from "./setupReleaseCatalogTestSuite";

export type { DatabaseTestLifecycle } from "./databaseTestRunner";

export type DatabaseTestSuiteOptions<
  TDatabase extends EngineDatabase = EngineDatabase,
> = DatabaseTestLifecycle<TDatabase> & {
  /**
   * Serves the handlers of `createHotUpdater({ database, storage, plugins:
   * [insights()], clientAccess: "public" })` over HTTP: in process, or in the
   * runtime the provider deploys to.
   */
  readonly createHttpClient: (options: {
    readonly database: TDatabase;
    readonly storage: readonly StoragePlugin[];
  }) => HttpTestServer | Promise<HttpTestServer>;
  /**
   * The Insights plugin's model on the database, to run the Insights report
   * contract on its tables: `(database) => createInsightsModel(
   * createDatabasePluginApis(database, [insights()]).insights)`.
   */
  readonly createInsightsModel?: (database: TDatabase) => InsightsModel;
};

/**
 * A provider's database under Hot Updater's server: core's operations, the
 * Release Catalog contract, bundles, and Insights, all through HTTP, on the
 * tables the provider's tooling creates; with `createInsightsModel`, also the
 * Insights report contract in process.
 */
export const setupDatabaseTestSuite = <TDatabase extends EngineDatabase>(
  options: DatabaseTestSuiteOptions<TDatabase>,
): void => {
  setupDatabaseTestRunner(options, ({ getDatabase }) => {
    let client: HttpTestServer | undefined;
    beforeEach(async () => {
      client = await options.createHttpClient({
        database: getDatabase(),
        storage: [createReleaseCatalogTestStorage()],
      });
    });
    afterEach(async () => {
      await client?.close();
      client = undefined;
    });
    const getClient = () => {
      if (client === undefined) {
        throw new Error("HTTP test server has not started");
      }
      return client;
    };
    setupCoreAdminTestSuite({ getClient });
    setupBundleMethodsTestSuite({ getClient });
    setupReleaseCatalogTestSuite({ getClient });
    setupInsightsHttpTestSuite({ getClient });
    const { createInsightsModel } = options;
    if (createInsightsModel !== undefined) {
      describe("Insights model", () => {
        registerInsightsModelTests({
          getDatabase: () => createInsightsModel(getDatabase()),
        });
      });
    }
  });
};
