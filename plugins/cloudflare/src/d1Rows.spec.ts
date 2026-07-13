import { expect, it } from "vitest";

import { parseD1Row } from "./d1Rows";

it("parses SQLite booleans and JSON columns into public bundle rows", () => {
  const row = parseD1Row("bundles", {
    id: "bundle-1",
    platform: "android",
    should_force_update: 1,
    enabled: 0,
    file_hash: "hash",
    git_commit_hash: null,
    message: null,
    channel: "production",
    channel_id: "channel-production",
    storage_uri: "storage://bundle",
    target_app_version: null,
    fingerprint_hash: "fingerprint",
    metadata: '{"build":1}',
    rollout_cohort_count: 1000,
    target_cohorts: '["stable","beta"]',
    manifest_storage_uri: null,
    manifest_file_hash: null,
    asset_base_storage_uri: null,
  });

  expect(row).toMatchObject({
    should_force_update: true,
    enabled: false,
    channel: "production",
    channel_id: "channel-production",
    metadata: { build: 1 },
    target_cohorts: ["stable", "beta"],
  });
});

it("parses channel ids and names from D1 rows", () => {
  // Given
  const row = { id: "channel-production", name: "production" };

  // When
  const channel = parseD1Row("channels", row);

  // Then
  expect(channel).toEqual(row);
});
