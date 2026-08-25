import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { parseMongoBundleRow, parseMongoPatchRow } from "./mongodbRows";

describe("parseMongoBundleRow", () => {
  it("rejects a missing metadata field", () => {
    const { metadata: _metadata, ...row } =
      createBundleRowFixture("missing-metadata");

    expect(() => parseMongoBundleRow(row)).toThrow(
      "Invalid MongoDB plugin data",
    );
  });

  it("rejects explicit null metadata", () => {
    expect(() =>
      parseMongoBundleRow({
        ...createBundleRowFixture("null-metadata"),
        metadata: null,
      }),
    ).toThrow("Invalid MongoDB plugin data");
  });

  it("preserves safe archive sizes above 2 GiB", () => {
    expect(parseMongoBundleRow(createBundleRowFixture("large"))).toMatchObject({
      archive_byte_size: 3_000_000_001,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid archive size %s",
    (archiveByteSize) => {
      expect(() =>
        parseMongoBundleRow({
          ...createBundleRowFixture("invalid-size"),
          archive_byte_size: archiveByteSize,
        }),
      ).toThrow("Invalid MongoDB plugin data");
    },
  );
});

describe("parseMongoPatchRow", () => {
  const row = createBundlePatchRowFixture("large", "bundle", "base");

  it("preserves safe patch sizes above 2 GiB", () => {
    expect(parseMongoPatchRow(row)).toMatchObject({
      patch_byte_size: 3_000_000_002,
    });
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid patch size %s",
    (patchByteSize) => {
      expect(() =>
        parseMongoPatchRow({ ...row, patch_byte_size: patchByteSize }),
      ).toThrow("Invalid MongoDB plugin data");
    },
  );
});
