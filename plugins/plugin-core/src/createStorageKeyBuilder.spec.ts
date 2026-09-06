import { describe, expect, it } from "vitest";

import { createStorageKeyBuilder } from "./createStorageKeyBuilder";

describe("createStorageKeyBuilder", () => {
  it("builds keys under the base path", () => {
    expect(
      createStorageKeyBuilder("releases")("bundles/id", "bundle.zip"),
    ).toBe("releases/bundles/id/bundle.zip");
  });

  it("strips surrounding slashes from the base path", () => {
    expect(
      createStorageKeyBuilder("/releases/")("bundles/id", "bundle.zip"),
    ).toBe("releases/bundles/id/bundle.zip");
  });

  it("omits the base path when it is empty or only slashes", () => {
    expect(createStorageKeyBuilder(undefined)("bundles/id")).toBe("bundles/id");
    expect(createStorageKeyBuilder("")("bundles/id")).toBe("bundles/id");
    expect(createStorageKeyBuilder("/")("bundles/id")).toBe("bundles/id");
  });
});
