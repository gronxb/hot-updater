import { describe, expect, it } from "vitest";

import { getContentType } from "./contentType";

describe("getContentType", () => {
  it("uses manifest and asset MIME types with a binary fallback", () => {
    expect(getContentType("manifest.json")).toBe("application/json");
    expect(getContentType("assets/icon.png")).toBe("image/png");
    expect(getContentType("index.ios.bundle.hbc")).toBe(
      "application/octet-stream",
    );
  });
});
