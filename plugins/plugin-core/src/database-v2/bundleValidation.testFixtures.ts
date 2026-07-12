import { IN_MEMORY_TEST_IDS } from "./inMemoryConnector.testFixtures";
import { createRuntimeBundle } from "./sessionRuntime.testFixtures";

export const createCompleteBundle = () => ({
  ...createRuntimeBundle(IN_MEMORY_TEST_IDS.first),
  metadata: { app_version: "1.0.0" },
  manifestStorageUri: "memory://manifest",
  manifestFileHash: "manifest-hash",
  assetBaseStorageUri: "memory://assets",
  patches: [
    {
      baseBundleId: IN_MEMORY_TEST_IDS.second,
      baseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "memory://patch",
    },
  ],
  patchBaseBundleId: IN_MEMORY_TEST_IDS.second,
  patchBaseFileHash: "base-hash",
  patchFileHash: "patch-hash",
  patchStorageUri: "memory://patch",
  rolloutCohortCount: 500,
  targetCohorts: ["internal", "beta"],
});

export const createPutChangeSet = (value: unknown) => ({
  id: "10000000-0000-4000-8000-000000000193",
  changes: [{ type: "put", value, precondition: { state: "absent" } }],
});
