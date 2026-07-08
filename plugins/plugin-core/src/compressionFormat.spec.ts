import { describe, expect, it } from "vitest";

import { getContentType } from "./compressionFormat";

describe("getContentType", () => {
  it("detects archive content types without Node path helpers", () => {
    expect(getContentType("/tmp/bundle.zip")).toBe("application/zip");
    expect(getContentType(String.raw`C:\tmp\bundle.tar.br`)).toBe(
      "application/x-tar",
    );
    expect(getContentType("bundle.unknown")).toBe("application/zip");
  });
});
