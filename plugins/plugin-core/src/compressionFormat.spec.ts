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

  it("falls back to application/octet-stream for non-archive uploads", () => {
    // Brotli compressed JS bundle stored under the content addressed asset root
    expect(getContentType("assets/sha256/ab/abcd1234.br")).toBe(
      "application/octet-stream",
    );
    // Content addressed asset whose source path carried no extension
    expect(getContentType("assets/sha256/ab/abcd1234")).toBe(
      "application/octet-stream",
    );
    // bsdiff patch produced by createBundleDiff
    expect(getContentType("patches/index.android.bundle.bsdiff")).toBe(
      "application/octet-stream",
    );
  });

  it("keeps types that mime already resolves", () => {
    expect(getContentType("assets/sha256/ab/abcd1234.png")).toBe("image/png");
    expect(getContentType("build/update.json")).toBe("application/json");
    expect(getContentType("build/bundle.zip")).toBe("application/zip");
  });
});
