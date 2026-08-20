import { describe, expect, it } from "vitest";

import { parseStorageUri } from "./parseStorageUri";

describe("parseStorageUri", () => {
  it("decodes percent-encoded object keys", () => {
    expect(
      parseStorageUri("s3://updates/assets/bootsplash/logo-ios%402x.png", "s3"),
    ).toEqual({
      protocol: "s3",
      bucket: "updates",
      key: "assets/bootsplash/logo-ios@2x.png",
    });
  });

  it("leaves invalid percent sequences untouched", () => {
    expect(parseStorageUri("s3://updates/assets/100%-off.png", "s3").key).toBe(
      "assets/100%-off.png",
    );
  });
});
