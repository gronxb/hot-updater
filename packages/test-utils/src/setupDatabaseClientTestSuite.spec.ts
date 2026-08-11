import { createInMemoryDatabaseClient } from "../test/inMemoryDatabaseClient";
import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabasePlugin";
import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";

const harness = createInMemoryDatabaseHarness();
const sequentialHarness = createInMemoryDatabaseHarness();

setupDatabaseClientTestSuite({
  name: "in-memory database aggregate client",
  createPlugin: () => harness.plugin,
  createClient: createInMemoryDatabaseClient,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "in-memory sequential database aggregate client",
  createPlugin: () => ({
    ...sequentialHarness.plugin,
    commit: (input) => {
      if (
        input.mutations.length > 1 ||
        input.mutations.some(({ changes }) => changes.length > 1)
      ) {
        throw new DatabaseAtomicCommitUnsupportedError(
          sequentialHarness.plugin.name,
        );
      }
      return sequentialHarness.plugin.commit(input);
    },
  }),
  createClient: createInMemoryDatabaseClient,
  migrate: () => undefined,
  reset: () => sequentialHarness.reset(),
  dispose: () => undefined,
});
import { DatabaseAtomicCommitUnsupportedError } from "@hot-updater/plugin-core";
