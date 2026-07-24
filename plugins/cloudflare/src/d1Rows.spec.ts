import { expect, it } from "vitest";

import { parseD1Row } from "./d1Rows";

const bundleEventFields = {
  id: "event-1",
  install_id: "install-1",
  user_id: "user-1",
  username: "name-1",
  to_bundle_id: "bundle-1",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  sdk_version: "0.37.0",
  received_at_ms: 1_725_000_000_000,
} as const;

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
    metadata: { build: 1 },
    target_cohorts: ["stable", "beta"],
  });
});

it("parses all three bundle event variants and nullable transition fields", () => {
  const unchanged = parseD1Row("bundle_events", {
    ...bundleEventFields,
    type: "UNCHANGED",
    from_bundle_id: null,
    update_strategy: null,
  });
  const applied = parseD1Row("bundle_events", {
    ...bundleEventFields,
    type: "UPDATE_APPLIED",
    from_bundle_id: "bundle-0",
    update_strategy: "appVersion",
  });
  const recovered = parseD1Row("bundle_events", {
    ...bundleEventFields,
    type: "RECOVERED",
    from_bundle_id: "bundle-1",
    update_strategy: "fingerprint",
  });

  expect(unchanged).toMatchObject({
    type: "UNCHANGED",
    from_bundle_id: null,
    update_strategy: null,
  });
  expect(applied).toMatchObject({
    type: "UPDATE_APPLIED",
    from_bundle_id: "bundle-0",
    update_strategy: "appVersion",
  });
  expect(recovered).toMatchObject({
    type: "RECOVERED",
    from_bundle_id: "bundle-1",
    update_strategy: "fingerprint",
  });
});

it("rejects mixed bundle event transition shapes", () => {
  expect(() =>
    parseD1Row("bundle_events", {
      ...bundleEventFields,
      type: "UNCHANGED",
      from_bundle_id: "bundle-0",
      update_strategy: null,
    }),
  ).toThrow();
  expect(() =>
    parseD1Row("bundle_events", {
      ...bundleEventFields,
      type: "RECOVERED",
      from_bundle_id: null,
      update_strategy: "appVersion",
    }),
  ).toThrow();
  expect(() =>
    parseD1Row("bundle_events", {
      ...bundleEventFields,
      type: "NOT_AN_EVENT",
      from_bundle_id: null,
      update_strategy: null,
    }),
  ).toThrow();
});

it("rejects malformed bundle event rows", () => {
  expect(() =>
    parseD1Row("bundle_events", {
      id: "event-1",
      type: "UNCHANGED",
      install_id: "install-1",
      user_id: null,
      username: null,
      from_bundle_id: null,
      to_bundle_id: undefined,
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort: "default",
      update_strategy: null,
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: 1_725_000_000_000,
    }),
  ).toThrow();
});
