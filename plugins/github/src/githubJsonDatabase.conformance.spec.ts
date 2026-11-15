import { createKvAdapter } from "@hot-updater/plugin-core";
import {
  setupDatabaseAdapterConformanceSuite,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";

import { createFakeGithub, FAKE_GITHUB } from "./github.fixture";
import { createGithubJsonStore } from "./githubJsonStore";

const createAdapter = async () => ({
  adapter: createKvAdapter({
    store: createGithubJsonStore({
      ...FAKE_GITHUB,
      fetch: createFakeGithub().fetch,
    }),
  }),
});

setupDatabaseAdapterConformanceSuite({
  name: "githubJsonDatabase",
  // A commit takes 300 items, and a conformance insert is 3: a row and 2
  // index items. 100 inserts fit; 101 are 303 items.
  maxOps: 100,
  // A write drops the items that expired before it; nothing prunes on demand.
  retention: "ttl",
  createAdapter,
});

setupReadBudgetTestSuite({
  name: "githubJsonDatabase",
  createAdapter: async () => ({
    ...(await createAdapter()),
    indexCopies: true,
  }),
});
