import { describe, expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { parsePrismaBundleEventRow, parsePrismaBundleRow } from "./prismaRows";

describe("parsePrismaBundleRow", () => {
  it.each([null, [], "metadata"])(
    "rejects non-object metadata from Prisma",
    (metadata) => {
      expect(() =>
        parsePrismaBundleRow({
          ...createBundleRowFixture("invalid-metadata"),
          metadata,
        }),
      ).toThrow("Invalid Prisma plugin state");
    },
  );
});

describe("parsePrismaBundleEventRow", () => {
  it("preserves explicit null Release ids", () => {
    expect(
      parsePrismaBundleEventRow(createBundleEventRowFixture("1", 1)),
    ).toMatchObject({ from_release_id: null, to_release_id: null });
  });

  it.each(["from_release_id", "to_release_id"])(
    "rejects an omitted field: %s",
    (field) => {
      const row: Record<string, unknown> = {
        ...createBundleEventRowFixture("1", 1),
      };
      delete row[field];

      expect(() => parsePrismaBundleEventRow(row)).toThrow(
        "Invalid Prisma plugin state",
      );
    },
  );

  it.each([
    { from_bundle_id: null },
    { to_bundle_id: null },
    { type: "UNCHANGED", from_bundle_id: "bundle-old", update_strategy: null },
  ])("rejects an invalid direction shape", (overrides) => {
    expect(() =>
      parsePrismaBundleEventRow({
        ...createBundleEventRowFixture("1", 1),
        ...overrides,
      }),
    ).toThrow("Invalid Prisma plugin state");
  });
});
