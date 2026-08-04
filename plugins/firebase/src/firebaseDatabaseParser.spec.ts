import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { parseFirebaseBundleRow } from "./firebaseDatabaseParser";

describe("parseFirebaseBundleRow", () => {
  it("keeps compatibility for a missing legacy metadata field", () => {
    const { metadata: _metadata, ...row } =
      createBundleRowFixture("missing-metadata");

    expect(parseFirebaseBundleRow(row, "bundles/legacy").metadata).toEqual({});
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
