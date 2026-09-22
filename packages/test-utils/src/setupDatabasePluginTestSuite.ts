import type { DatabasePlugin, StoragePlugin } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe } from "vitest";

import { registerDatabasePluginBundleTests } from "./databasePluginBundleTests";
import { registerDatabasePluginCapabilityTests } from "./databasePluginCapabilityTests";
import { registerDatabasePluginInsightsTests } from "./databasePluginInsightsTests";
import { registerDatabasePluginOfficialDomainTests } from "./databasePluginOfficialDomainTests";
import { registerDatabasePluginQueryTests } from "./databasePluginQueryTests";
import { registerDatabasePluginRelationTests } from "./databasePluginRelationTests";
import { registerDatabasePluginReleaseCatalogTests } from "./databasePluginReleaseCatalogTests";
import type { DatabasePluginTestLifecycle } from "./databasePluginTestRunner";
import { setupDatabasePluginTestRunner } from "./databasePluginTestRunner";
import type { HttpTestServer } from "./httpTestClient";
import { createReleaseCatalogTestStorage } from "./releaseCatalogHttpFixtures";
import { setupReleaseCatalogTestSuite } from "./setupReleaseCatalogTestSuite";

export type DatabasePluginTestSuiteOptions =
  DatabasePluginTestLifecycle<DatabasePlugin> & {
    readonly createHttpClient: (options: {
      readonly database: DatabasePlugin;
      readonly storage: readonly StoragePlugin[];
    }) => HttpTestServer | Promise<HttpTestServer>;
  };

export const setupDatabasePluginTestSuite = (
  options: DatabasePluginTestSuiteOptions,
): void => {
  setupDatabasePluginTestRunner(options, (state) => {
    registerDatabasePluginBundleTests(state);
    registerDatabasePluginRelationTests(state);
    registerDatabasePluginQueryTests(state);
    registerDatabasePluginReleaseCatalogTests(state);
    registerDatabasePluginCapabilityTests(state);
    registerDatabasePluginOfficialDomainTests(state);
    registerDatabasePluginInsightsTests(state);
    describe("server", () => {
      let client: HttpTestServer | undefined;
      beforeEach(async () => {
        client = await options.createHttpClient({
          database: state.getPlugin(),
          storage: [createReleaseCatalogTestStorage()],
        });
      });
      afterEach(async () => {
        await client?.close();
        client = undefined;
      });
      setupReleaseCatalogTestSuite({
        getClient: () => {
          if (client === undefined)
            throw new Error("HTTP test server has not started");
          return client;
        },
      });
    });
  });
};
