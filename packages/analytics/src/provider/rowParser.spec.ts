import { describe, expect, it } from "vitest";

import {
  InvalidBundleEventPersistenceRowError,
  parseBundleEventPersistenceRow,
} from "./rowParser";

const validTransitionRow = Object.freeze({
  id: "event-1",
  type: "UPDATE_APPLIED",
  install_id: "install-1",
  user_id: null,
  username: "alice",
  from_bundle_id: "bundle-1",
  to_bundle_id: "bundle-2",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "fingerprint",
  fingerprint_hash: "fingerprint-1",
  sdk_version: "2.0.0",
  received_at_ms: 1_000,
});

describe("parseBundleEventPersistenceRow", () => {
  it("returns a transition row when every persisted field is valid", () => {
    expect(parseBundleEventPersistenceRow(validTransitionRow)).toEqual(
      validTransitionRow,
    );
  });

  it("returns an unchanged row only when transition fields are null", () => {
    const row = {
      ...validTransitionRow,
      type: "UNCHANGED",
      from_bundle_id: null,
      update_strategy: null,
    };

    expect(parseBundleEventPersistenceRow(row)).toEqual(row);
  });

  it.each([
    { ...validTransitionRow, received_at_ms: Number.MAX_SAFE_INTEGER + 1 },
    { ...validTransitionRow, received_at_ms: -1 },
    { ...validTransitionRow, id: "" },
    { ...validTransitionRow, username: "" },
    { ...validTransitionRow, unexpected: true },
    { ...validTransitionRow, type: "UNCHANGED", from_bundle_id: null },
  ])("rejects rows outside the exact persistence contract", (row) => {
    expect(() => parseBundleEventPersistenceRow(row)).toThrow(
      InvalidBundleEventPersistenceRowError,
    );
  });
});
