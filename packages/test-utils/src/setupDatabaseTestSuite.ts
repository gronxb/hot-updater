import type { EngineDatabase, StorageAdapter } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe } from "vitest";

import {
  setupDatabaseTestRunner,
  type DatabaseTestLifecycle,
} from "./databaseTestRunner";
import type { HttpTestClient, HttpTestServer } from "./httpTestClient";
import { createReleaseCatalogTestStorage } from "./releaseCatalogHttpFixtures";
import { setupBundleMethodsTestSuite } from "./setupBundleMethodsTestSuite";
import { setupCoreAdminTestSuite } from "./setupCoreAdminTestSuite";
import { setupPartitioningEnableTestSuite } from "./setupPartitioningEnableTestSuite";
import { setupReleaseCatalogTestSuite } from "./setupReleaseCatalogTestSuite";

export type { DatabaseTestLifecycle } from "./databaseTestRunner";

/**
 * A server plugin's tests on a provider's database, such as the Insights
 * plugin's `insightsTestSuite()`. The provider's HTTP server must run the
 * plugin.
 */
export interface DatabasePluginTestSuite<TDatabase = unknown> {
  readonly name: string;
  register(context: {
    readonly getClient: () => HttpTestClient;
    readonly getDatabase: () => TDatabase;
  }): void;
}

export type DatabaseTestSuiteOptions<
  TDatabase extends EngineDatabase = EngineDatabase,
> = DatabaseTestLifecycle<TDatabase> & {
  /**
   * Serves the handlers of `createHotUpdater({ database, storage, plugins,
   * clientAccess: "public" })` over HTTP, in process or in the runtime the
   * provider deploys to, with the plugins whose suites `plugins` lists.
   */
  readonly createHttpClient: (options: {
    readonly database: TDatabase;
    readonly storage: StorageAdapter;
  }) => HttpTestServer | Promise<HttpTestServer>;
  /** The suites of the server plugins the provider opts in to test. */
  readonly plugins?: readonly DatabasePluginTestSuite<TDatabase>[];
  /**
   * False for a database without `release_catalog_partitions`, such as a
   * prerelease's before its by-hand step, whose spec checks that nothing
   * touches the table: turning partitioning on probes it.
   */
  readonly partitioning?: boolean;
};

/**
 * A provider's database under Hot Updater's server: core's operations, the
 * Release Catalog contract, bundles, and turning release catalog partitioning
 * on, all through HTTP, on the tables the provider's tooling creates, then
 * each opted-in plugin's suite.
 */
export const setupDatabaseTestSuite = <TDatabase extends EngineDatabase>(
  options: DatabaseTestSuiteOptions<TDatabase>,
): void => {
  setupDatabaseTestRunner(options, ({ getDatabase }) => {
    let client: HttpTestServer | undefined;
    beforeEach(async () => {
      client = await options.createHttpClient({
        database: getDatabase(),
        storage: createReleaseCatalogTestStorage(),
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
    // Last of core's: it turns the switch on, and off again after each test.
    if (options.partitioning !== false) {
      setupPartitioningEnableTestSuite({ getClient, getDatabase });
    }
    for (const suite of options.plugins ?? []) {
      describe(suite.name, () => {
        suite.register({ getClient, getDatabase });
      });
    }
  });
};
