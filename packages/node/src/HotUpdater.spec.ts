import { expect, vi, describe, beforeEach, it } from "vitest";

import { HotUpdater } from "./HotUpdater"; // Adjust the path accordingly
import { S3Client } from "@aws-sdk/client-s3";

vi.mock("@aws-sdk/client-s3", () => {
  const S3Client = vi.fn();
  S3Client.prototype.send = vi.fn().mockImplementation((command) => ({
    Contents: [
      { Key: "MhpYhz/index.bundle" }, // 1.0.0/index.bundle
      { Key: "MhpYhz/assets/logo.png" }, // 1.0.0/index.bundle
      { Key: "IQhQ8B/index.bundle" }, // 1.0.1/index.bundle
      { Key: "IQhQ8B/assets/logo.png" }, // 1.0.1/index.bundle
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
      const version = "1.0.0";
      const encoded = hotUpdater["encodeVersion"](version);
      const decoded = hotUpdater["decodeVersion"](encoded);
      expect(decoded).toBe(version);
    });
  });

  describe("getListObjectsV2Command", () => {
    it("should retrieve a list of objects from the S3 bucket", async () => {
      const result = await hotUpdater["getListObjectsV2Command"]();
      expect(result).toEqual([
        "MhpYhz/index.bundle",
        "MhpYhz/assets/logo.png",
        "IQhQ8B/index.bundle",
        "IQhQ8B/assets/logo.png",
      ]);
    });
  });

  describe("getVersionList", () => {
    it("should retrieve a list of versions", async () => {
      const versions = await hotUpdater.getVersionList();
      expect(versions).toEqual(["1.0.0", "1.0.1"]);
    });
  });

  describe("getMetaData", () => {
    it("should retrieve metadata for a given version", async () => {
      const version = "1.0.1";

      const metadata = await hotUpdater.getMetaData(version);
      expect(metadata).toStrictEqual({
        files: ["IQhQ8B/index.bundle", "IQhQ8B/assets/logo.png"],
        version,
      });
    });
  });
});
