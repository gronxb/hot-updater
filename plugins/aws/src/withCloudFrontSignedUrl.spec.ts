import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import type { StoragePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { withCloudFrontSignedUrl } from "./withCloudFrontSignedUrl";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://signed.example.com/bundle.zip"),
}));

const createBaseStorage = (): StoragePlugin => ({
  name: "baseStorage",
  supportedProtocol: "s3",
  async readText({ storageUri }) {
    return storageUri;
  },
  async getDownloadUrl({ storageUri }) {
    return {
      fileUrl: storageUri.replace("s3://", "https://s3.example.com/"),
    };
  },
});

describe("withCloudFrontSignedUrl", () => {
  it("signs the CloudFront URL using the configured public base URL", async () => {
    const storage = withCloudFrontSignedUrl(() => createBaseStorage(), {
      keyPairId: "K123",
      getPrivateKey: async () => "private-key",
      publicBaseUrl: () => "https://d2zkxggbe748dg.cloudfront.net",
      expiresSeconds: 60,
    })();

    if (!storage.getDownloadUrl) {
      throw new Error("expected getDownloadUrl operation");
    }

    await expect(
      storage.getDownloadUrl({
        storageUri: "s3://test-bucket/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      fileUrl: "https://signed.example.com/bundle.zip",
    });

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://d2zkxggbe748dg.cloudfront.net/releases/bundle.zip",
        keyPairId: "K123",
        privateKey: "private-key",
      }),
    );
  });
});
