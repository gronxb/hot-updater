import { describe, expect, it } from "vitest";

import {
  createStorageDownloadPath,
  createStorageDownloadUrl,
  parseStorageDownloadPath,
} from "./storageDownloadPath";

describe("storage download paths", () => {
  it("round-trips a storage URI and URL-unsafe signature", () => {
    const path = createStorageDownloadPath(
      "r2://updates/releases/한글 bundle.zip",
      "signature/with spaces",
    );

    expect(parseStorageDownloadPath(path)).toEqual({
      signature: "signature/with spaces",
      storageUri: "r2://updates/releases/한글 bundle.zip",
    });
  });

  it("rejects malformed download paths", () => {
    expect(
      parseStorageDownloadPath("/storage/not-base64/signature"),
    ).toBeNull();
    expect(parseStorageDownloadPath("/other/path")).toBeNull();
  });

  it("creates a stable signed URL without exposing the signing key", async () => {
    const getDownloadUrl = createStorageDownloadUrl("test-signing-key");

    const first = await getDownloadUrl({
      storageUri: "r2://updates/releases/bundle.zip",
    });
    const second = await getDownloadUrl({
      storageUri: "r2://updates/releases/bundle.zip",
    });

    expect(first).toEqual(second);
    expect(first.url).not.toContain("test-signing-key");
  });
});
