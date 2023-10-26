import { expect, vi, describe, beforeEach, it } from "vitest";

import { HotUpdater } from "./HotUpdater"; // Adjust the path accordingly
import { S3Client } from "@aws-sdk/client-s3";

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn();
  S3Client.prototype.send = vi.fn().mockImplementation((command) => ({
    Contents: [
      { Key: "Gm/index.bundle" }, // v1/index.bundle
      { Key: "Gm/assets/logo.png" }, // v1/index.bundle
      { Key: "ql/index.bundle" }, // v2/index.bundle
      { Key: "ql/assets/logo.png" }, // v2/index.bundle
    ].filter(
      command.Prefix
        ? (content) => content.Key.startsWith(command.Prefix)
        : Boolean
    ),
  }));

  const ListObjectsV2Command = vi.fn().mockImplementation(({ Prefix }) => {
    return {
      Bucket: "test-bucket",
      Prefix,
    };
  });

  return { S3Client, ListObjectsV2Command };
});

describe("HotUpdater", () => {
  let hotUpdater: HotUpdater;

  const bucketName = "test-bucket";

  beforeEach(() => {
    hotUpdater = new HotUpdater({
      s3Client: new S3Client(),
      bucketName,
    });
  });

  describe("encodeVersion and decodeVersion", () => {
    it("should correctly encode and decode a version", () => {
      const version = 1234;
      const encoded = hotUpdater["encodeVersion"](version);
      const decoded = hotUpdater["decodeVersion"](encoded);
      expect(decoded).toBe(version);
    });
  });

  describe("getListObjectsV2Command", () => {
    it("should retrieve a list of objects from the S3 bucket", async () => {
      const result = await hotUpdater["getListObjectsV2Command"]();
      expect(result).toEqual([
        "Gm/index.bundle",
        "Gm/assets/logo.png",
        "ql/index.bundle",
        "ql/assets/logo.png",
      ]);
    });
  });

  describe("getVersionList", () => {
    it("should retrieve a list of versions", async () => {
      const versions = await hotUpdater.getVersionList();
      expect(versions).toEqual([1, 2]);
    });
  });

  describe("getMetaData", () => {
    it("should retrieve metadata for a given version", async () => {
      const version = 2;

      vi.fn().getMockImplementation;
      const metadata = await hotUpdater.getMetaData(2);
      expect(metadata).toStrictEqual({
        assetPaths: ["ql/index.bundle", "ql/assets/logo.png"],
        version,
      });
    });
  });
});
