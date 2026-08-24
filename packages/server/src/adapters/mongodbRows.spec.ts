import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { parseMongoBundleRow } from "./mongodbRows";

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
});
