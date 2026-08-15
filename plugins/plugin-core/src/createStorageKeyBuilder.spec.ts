import { describe, expect, it } from "vitest";

import { createStorageKeyBuilder } from "./createStorageKeyBuilder";

describe("createStorageKeyBuilder", () => {
  it("keeps safe hierarchical keys unchanged", () => {
    const key = createStorageKeyBuilder("releases")(
      "bundle-id",
      "files/assets",
      "logo.png",
    );

    expect(key).toBe("releases/bundle-id/files/assets/logo.png");
  });

  it("removes boundary slashes and empty pieces", () => {
    const key = createStorageKeyBuilder("/releases/")(
      "/bundle-id/",
      "",
      "files//assets/",
    );

    expect(key).toBe("releases/bundle-id/files/assets");
  });

  it.each([".", "..", "files/../bundle.zip", "/./bundle.zip"])(
    "rejects an ambiguous segment in %s",
    (value) => {
      expect(() => createStorageKeyBuilder("releases")(value)).toThrow(
        "must not be '.' or '..'",
      );
    },
  );

  it("rejects a backslash hierarchy separator", () => {
    expect(() =>
      createStorageKeyBuilder("releases")("files\\bundle.zip"),
    ).toThrow("must use '/' as the hierarchy separator");
  });
});
