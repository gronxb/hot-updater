import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";

import { mockStorage } from "./mockStorage";

setupStorageAdapterTestSuite({
  name: "mockStorage",
  createStorage: async () => ({ storage: mockStorage({}) }),
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});
