import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudFrontDownloadUrl } from "./cloudFrontDownloadUrl";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://signed.example.com/bundle.zip"),
}));

describe("cloudFrontDownloadUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves an S3 URI through the configured CloudFront origin", async () => {
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      getPrivateKey: async () => "private-key",
      publicBaseUrl: "https://d2zkxggbe748dg.cloudfront.net",
      expiresSeconds: 60,
    });

    await expect(
      getDownloadUrl({
        storageUri: "s3://test-bucket/releases/bundle.zip",
      }),
    ).resolves.toEqual({ url: "https://signed.example.com/bundle.zip" });
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPairId: "K123",
        privateKey: "private-key",
        url: "https://d2zkxggbe748dg.cloudfront.net/releases/bundle.zip",
      }),
    );
  });

  it("loads and caches the private key from SSM", async () => {
    const getParameter = vi
      .spyOn(SSM.prototype, "getParameter")
      .mockImplementation(
        async () =>
          ({
            Parameter: {
              Value: JSON.stringify({ privateKey: "ssm-private-key" }),
            },
          }) as any,
      );
    const getDownloadUrl = cloudFrontDownloadUrl({
      keyPairId: "K123",
      publicBaseUrl: "https://d111111abcdef8.cloudfront.net",
      ssmRegion: "us-east-1",
      ssmParameterName: "/hot-updater/cloudfront/key-pair/download-url",
    });

    await getDownloadUrl({
      storageUri: "s3://test-bucket/releases/first.zip",
    });
    await getDownloadUrl({
      storageUri: "s3://test-bucket/releases/second.zip",
    });

    expect(getParameter).toHaveBeenCalledOnce();
  });
});
