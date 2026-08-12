import { expect, it } from "vitest";

import { parseD1Row } from "./d1Rows";

const bundleD1Row = {
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
} as const;

it("parses SQLite booleans and JSON columns into public bundle rows", () => {
  const row = parseD1Row("bundles", bundleD1Row);

  expect(row).toMatchObject({
    should_force_update: true,
    enabled: false,
    channel: "production",
    channel_id: "channel-production",
    metadata: { build: 1 },
    target_cohorts: ["stable", "beta"],
  });
});

it.each([
  ["should_force_update", "false"],
  ["enabled", 2],
] as const)("rejects corrupt SQLite boolean column %s", (field, value) => {
  expect(() =>
    parseD1Row("bundles", { ...bundleD1Row, [field]: value }),
  ).toThrow("D1 returned an invalid bundles row");
});

it("rejects corrupt SQLite metadata JSON", () => {
  expect(() =>
    parseD1Row("bundles", { ...bundleD1Row, metadata: "{" }),
  ).toThrow("D1 returned an invalid bundles row");
});

it.each(["null", "[]", "1", '"metadata"'])(
  "rejects non-object SQLite metadata %s",
  (metadata) => {
    expect(() => parseD1Row("bundles", { ...bundleD1Row, metadata })).toThrow(
      "D1 returned an invalid bundles row",
    );
  },
);
