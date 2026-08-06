import { describe, expect, it } from "vitest";

import { getContentType } from "./compressionFormat";

describe("getContentType", () => {
  it("returns the compression MIME type for a bundle archive", () => {
    expect(getContentType("build/bundle.tar.br")).toBe("application/x-tar");
  });

  it("supports Windows bundle paths", () => {
    expect(getContentType("build\\bundle.tar.br")).toBe("application/x-tar");
  });

  it("ignores trailing path separators", () => {
    expect(getContentType("build/bundle.tar.br/")).toBe("application/x-tar");
    expect(getContentType("build\\bundle.tar.br\\")).toBe("application/x-tar");
  });
});
