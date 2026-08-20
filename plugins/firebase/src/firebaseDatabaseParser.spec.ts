import { describe, expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  parseFirebaseBundleEventRow,
  parseFirebaseBundleRow,
} from "./firebaseDatabaseParser";

describe("parseFirebaseBundleRow", () => {
  it("rejects a missing metadata field", () => {
    const { metadata: _metadata, ...row } =
      createBundleRowFixture("missing-metadata");

    expect(() =>
      parseFirebaseBundleRow(row, "bundles/missing-metadata"),
    ).toThrow("Invalid Firebase database data");
  });

  it("rejects explicit null metadata", () => {
    expect(() =>
      parseFirebaseBundleRow(
        {
          ...createBundleRowFixture("null-metadata"),
          metadata: null,
        },
        "bundles/null-metadata",
      ),
    ).toThrow("Invalid Firebase database data");
  });
});

describe("parseFirebaseBundleEventRow", () => {
  it("preserves explicit null Release ids", () => {
    expect(
      parseFirebaseBundleEventRow(
        createBundleEventRowFixture("1", 1),
        "bundle_events/event-1",
      ),
    ).toMatchObject({ from_release_id: null, to_release_id: null });
  });

  it.each(["from_release_id", "to_release_id"])(
    "rejects an omitted field: %s",
    (field) => {
      const row: Record<string, unknown> = {
        ...createBundleEventRowFixture("1", 1),
      };
      delete row[field];

      expect(() =>
        parseFirebaseBundleEventRow(row, "bundle_events/event-1"),
      ).toThrow("Invalid Firebase database data");
    },
  );

  it.each([
    { from_bundle_id: null },
    { to_bundle_id: null },
    { type: "UNCHANGED", from_bundle_id: "bundle-old", update_strategy: null },
  ])("rejects an invalid direction shape", (overrides) => {
    expect(() =>
      parseFirebaseBundleEventRow(
        { ...createBundleEventRowFixture("1", 1), ...overrides },
        "bundle_events/event-1",
      ),
    ).toThrow("Invalid Firebase database data");
  });
});
