import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";

import type { DatabaseClientTestContract } from "../src/setupDatabaseClientTestSuite";

export const createInMemoryDatabaseClient = (
  adapter: DatabasePlugin,
): DatabaseClientTestContract<unknown> => createDatabaseClient(adapter);
