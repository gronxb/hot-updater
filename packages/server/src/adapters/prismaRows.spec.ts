import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import {
  parsePrismaBundleEventRow,
  parsePrismaBundleRow,
  parsePrismaPatchRow,
} from "./prismaRows";

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

  it("preserves safe archive sizes above 2 GiB", () => {
    expect(parsePrismaBundleRow(createBundleRowFixture("large"))).toMatchObject(
      { archive_byte_size: 3_000_000_001 },
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid archive size %s",
    (archiveByteSize) => {
      expect(() =>
        parsePrismaBundleRow({
          ...createBundleRowFixture("invalid-size"),
          archive_byte_size: archiveByteSize,
        }),
      ).toThrow("Invalid Prisma plugin state");
    },
  );
});

describe("parsePrismaPatchRow", () => {
  const row = createBundlePatchRowFixture("large", "bundle", "base");

  it("preserves safe patch sizes above 2 GiB", () => {
    expect(parsePrismaPatchRow(row)).toMatchObject({
      patch_byte_size: 3_000_000_002,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid patch size %s",
    (patchByteSize) => {
      expect(() =>
        parsePrismaPatchRow({ ...row, patch_byte_size: patchByteSize }),
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
