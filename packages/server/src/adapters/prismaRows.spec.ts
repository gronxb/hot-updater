import { expect, it } from "vitest";

import { parsePrismaAppendOnlyRow } from "./prismaRows";

const appendOnlyFields = {
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

it("parses all three Prisma append-only row variants", () => {
  const unchanged = parsePrismaAppendOnlyRow({
    ...appendOnlyFields,
    type: "UNCHANGED",
    from_bundle_id: null,
    update_strategy: null,
  });
  const applied = parsePrismaAppendOnlyRow({
    ...appendOnlyFields,
    type: "UPDATE_APPLIED",
    from_bundle_id: "bundle-0",
    update_strategy: "appVersion",
  });
  const recovered = parsePrismaAppendOnlyRow({
    ...appendOnlyFields,
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

it("rejects mixed Prisma append-only transition shapes", () => {
  expect(() =>
    parsePrismaAppendOnlyRow({
      ...appendOnlyFields,
      type: "UNCHANGED",
      from_bundle_id: "bundle-0",
      update_strategy: null,
    }),
  ).toThrow();
  expect(() =>
    parsePrismaAppendOnlyRow({
      ...appendOnlyFields,
      type: "RECOVERED",
      from_bundle_id: null,
      update_strategy: "appVersion",
    }),
  ).toThrow();
  expect(() =>
    parsePrismaAppendOnlyRow({
      ...appendOnlyFields,
      type: "NOT_AN_EVENT",
      from_bundle_id: null,
      update_strategy: null,
    }),
  ).toThrow();
});
