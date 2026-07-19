import {
  createDatabaseClient,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";

import type { DatabaseClientTestContract } from "../src/setupDatabaseClientTestSuite";

export const createInMemoryDatabaseClient = (
  adapter: DatabaseAdapter,
): DatabaseClientTestContract => createDatabaseClient(adapter);
