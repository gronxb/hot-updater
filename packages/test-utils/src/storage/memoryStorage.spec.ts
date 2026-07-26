import { createMemoryStoragePlugin, storageTestContext } from "./memoryStorage";
import { setupStoragePluginTestSuite } from "./setupStoragePluginTestSuite";

setupStoragePluginTestSuite({
  name: "reference memory Storage v2 adapter",
  context: storageTestContext,
  createPlugin: createMemoryStoragePlugin,
});
