import { describe, expect, it } from "vitest";

import { createStorageUri, parseStorageUri } from "./parseStorageUri";

describe("storage URI", () => {
  it("round-trips special characters in each key segment", () => {
    const input = {
      protocol: "r2",
      bucket: "updates",
      key: "releases/한글 bundle #100%/bundle.zip",
    } as const;

    const storageUri = createStorageUri(input);

    expect(storageUri).toBe(
      "r2://updates/releases/%ED%95%9C%EA%B8%80%20bundle%20%23100%25/bundle.zip",
    );
    expect(parseStorageUri(storageUri, "r2")).toEqual(input);
  });

  it.each([
    { protocol: "", bucket: "updates", key: "bundle.zip" },
    { protocol: "R2", bucket: "updates", key: "bundle.zip" },
    { protocol: "r2", bucket: "", key: "bundle.zip" },
    { protocol: "r2", bucket: "up dates", key: "bundle.zip" },
    { protocol: "r2", bucket: "updates", key: "" },
    { protocol: "r2", bucket: "updates", key: "/bundle.zip" },
    { protocol: "r2", bucket: "updates", key: "releases//bundle.zip" },
    { protocol: "r2", bucket: "updates", key: "releases/." },
    { protocol: "r2", bucket: "updates", key: "releases/../bundle.zip" },
    { protocol: "r2", bucket: "updates", key: "releases\\bundle.zip" },
  ])("rejects ambiguous create input %#", (input) => {
    expect(() => createStorageUri(input)).toThrow("Invalid storage URI");
  });

  it.each([
    "r2://updates",
    "r2://updates/",
    "r2://updates//bundle.zip",
    "r2://updates/releases/./bundle.zip",
    "r2://updates/releases/%2E%2E/bundle.zip",
    "r2://updates/releases/bundle.zip?version=1",
    "r2://updates/releases/bundle.zip#download",
    "r2://updates/releases/%",
    "r2://updates/releases%2Fbundle.zip",
    "r2://updates/releases%5CbUNDLE.zip",
    "r2://updates/releases/raw space.zip",
  ])("rejects malformed or non-canonical URI %s", (storageUri) => {
    expect(() => parseStorageUri(storageUri, "r2")).toThrow(
      "Invalid storage URI",
    );
  });

  it("rejects a different provider protocol", () => {
    expect(() =>
      parseStorageUri("s3://updates/releases/bundle.zip", "r2"),
    ).toThrow("Expected r2, got s3");
  });
});
