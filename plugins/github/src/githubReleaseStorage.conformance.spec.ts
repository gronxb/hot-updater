import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";

import { createFakeGithub, FAKE_GITHUB } from "./github.fixture";
import { githubReleaseStorage } from "./githubReleaseStorage";

setupStorageAdapterTestSuite({
  name: "githubReleaseStorage",
  createStorage: async () => ({
    storage: githubReleaseStorage({
      ...FAKE_GITHUB,
      basePath: "ota",
      fetch: createFakeGithub().fetch,
    }),
    basePath: "ota",
  }),
  operations: [
    "put",
    "get",
    "getDownloadUrl",
    "exists",
    "delete",
    "listObjects",
    "deleteObjects",
  ],
});
