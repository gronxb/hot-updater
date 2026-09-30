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
    readonly storage: readonly StorageAdapter[];
  }) => HttpTestServer | Promise<HttpTestServer>;
  /** The suites of the server plugins the provider opts in to test. */
  readonly plugins?: readonly DatabasePluginTestSuite<TDatabase>[];
};

/**
 * A provider's database under Hot Updater's server: core's operations, the
 * Release Catalog contract, and bundles, all through HTTP, on the tables the
 * provider's tooling creates, then each opted-in plugin's suite.
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
    for (const suite of options.plugins ?? []) {
      describe(suite.name, () => {
        suite.register({ getClient, getDatabase });
      });
    }
  });
};
