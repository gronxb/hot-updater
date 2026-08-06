import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { parsePrismaBundleRow } from "./prismaRows";

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
