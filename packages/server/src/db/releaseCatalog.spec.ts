import {
  encodeChannelKey,
  NIL_UUID,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import { createLegacyCatalogResolver } from "./releaseCatalog";

describe("createLegacyCatalogResolver", () => {
  it("uses the full rollback spine for a rollout-ineligible predecessor", async () => {
    const predecessorBundleId = "00000000-0000-7001-8000-000000000002";
    const currentBundleId = "00000000-0000-7001-8000-000000000003";
    const catalog: ReleaseCatalog = {
      authorityId: "project-a",
      catalogHash: `sha256:${"a".repeat(64)}`,
      fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
      generation: 2,
      releases: [],
      rollbackReleases: [
        {
          bundleId: predecessorBundleId,
          kind: "BUNDLE",
          message: "Previous Release",
          releaseId: "00000000-0000-7000-8000-000000000002",
          rolloutCohortCount: 0,
          shouldForceUpdate: false,
          targetCohorts: [],
        },
      ],
      schemaVersion: 1,
      scopeKey: `v1:app-version:project-a:ios:${encodeChannelKey("production")}`,
    };
    const resolve = createLegacyCatalogResolver({
      authorityId: "project-a",
      getArtifact: async (targetBundleId) => ({
        fileHash: "predecessor-hash",
        fileUrl: "https://updates.example.com/predecessor.zip",
        id: targetBundleId,
        message: null,
        shouldForceUpdate: false,
        status: "UPDATE",
      }),
      getCatalog: async () => catalog,
    });

    const result = await resolve({
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: currentBundleId,
      channel: "production",
      cohort: "not-targeted",
      minBundleId: NIL_UUID,
      platform: "ios",
    });

    expect(result).toMatchObject({
      id: predecessorBundleId,
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
  });
});
