import { expect, it } from "vitest";

import { parseBlobDatabaseSnapshot } from "./blobDatabaseSnapshot";

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

const snapshot = (bundle_events: readonly object[]) => ({
  version: 2,
  bundles: [],
  bundle_patches: [],
  bundle_events,
});

it("round-trips a valid UNCHANGED blob event row", () => {
  const row = parseBlobDatabaseSnapshot(
    snapshot([
      {
        ...bundleEventFields,
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      },
    ]),
  ).bundle_events[0];

  expect(row).toMatchObject({
    type: "UNCHANGED",
    from_bundle_id: null,
    update_strategy: null,
  });
});

it("rejects mixed blob event transition shapes", () => {
  expect(() =>
    parseBlobDatabaseSnapshot(
      snapshot([
        {
          ...bundleEventFields,
          type: "UNCHANGED",
          from_bundle_id: "bundle-0",
          update_strategy: null,
        },
      ]),
    ),
  ).toThrow();
});

it("rejects blob event rows missing transition fields", () => {
  expect(() =>
    parseBlobDatabaseSnapshot(
      snapshot([
        {
          ...bundleEventFields,
          type: "UNCHANGED",
          update_strategy: null,
        },
      ]),
    ),
  ).toThrow();
});
