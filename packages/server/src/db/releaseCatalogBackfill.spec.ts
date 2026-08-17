import { describe, expect, it } from "vitest";

import {
  compileLegacyReleaseCatalogBackfill,
  type LegacyBundlePolicyRow,
} from "./releaseCatalogBackfill";

const legacyBundle = (id: string): LegacyBundlePolicyRow => ({
  channel: "production",
  enabled: true,
  fingerprint_hash: null,
  id,
  message: null,
  platform: "ios",
  rollout_cohort_count: 1000,
  should_force_update: false,
  target_app_version: ">=1.0.0",
  target_cohorts: [],
});

describe("Release Catalog backfill", () => {
  it.each([
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-7000-8000-00000000000A",
  ])(
    "rejects legacy Bundle id %s before copying it to Release.id",
    async (id) => {
      await expect(
        compileLegacyReleaseCatalogBackfill({
          authorityId: "project-a",
          rows: [legacyBundle(id)],
        }),
      ).rejects.toThrow("Expected a canonical lowercase UUIDv7");
    },
  );

  it("preserves a canonical UUIDv7 Bundle id as the Release id", async () => {
    const id = "00000000-0000-7000-8000-000000000001";

    const result = await compileLegacyReleaseCatalogBackfill({
      authorityId: "project-a",
      rows: [legacyBundle(id)],
    });

    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]?.row.id).toBe(id);
  });
});
