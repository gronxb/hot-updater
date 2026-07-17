import { expect, it } from "vitest";

import { parseFirebaseBundleEventRow } from "./firebaseDatabaseParser";

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

it("parses all three Firebase bundle event variants", () => {
  const unchanged = parseFirebaseBundleEventRow(
    {
      ...bundleEventFields,
      type: "UNCHANGED",
      from_bundle_id: null,
      update_strategy: null,
    },
    "bundle_events/event-1",
  );
  const applied = parseFirebaseBundleEventRow(
    {
      ...bundleEventFields,
      type: "UPDATE_APPLIED",
      from_bundle_id: "bundle-0",
      update_strategy: "appVersion",
    },
    "bundle_events/event-1",
  );
  const recovered = parseFirebaseBundleEventRow(
    {
      ...bundleEventFields,
      type: "RECOVERED",
      from_bundle_id: "bundle-1",
      update_strategy: "fingerprint",
    },
    "bundle_events/event-1",
  );

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

it("rejects mixed Firebase bundle event transition shapes", () => {
  expect(() =>
    parseFirebaseBundleEventRow(
      {
        ...bundleEventFields,
        type: "UNCHANGED",
        from_bundle_id: "bundle-0",
        update_strategy: null,
      },
      "bundle_events/event-1",
    ),
  ).toThrow();
  expect(() =>
    parseFirebaseBundleEventRow(
      {
        ...bundleEventFields,
        type: "RECOVERED",
        from_bundle_id: null,
        update_strategy: "appVersion",
      },
      "bundle_events/event-1",
    ),
  ).toThrow();
  expect(() =>
    parseFirebaseBundleEventRow(
      {
        ...bundleEventFields,
        type: "NOT_AN_EVENT",
        from_bundle_id: null,
        update_strategy: null,
      },
      "bundle_events/event-1",
    ),
  ).toThrow();
});

it("rejects Firebase bundle event rows missing transition fields", () => {
  expect(() =>
    parseFirebaseBundleEventRow(
      {
        ...bundleEventFields,
        type: "UNCHANGED",
        update_strategy: null,
      },
      "bundle_events/event-1",
    ),
  ).toThrow();
});
