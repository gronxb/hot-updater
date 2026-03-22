import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awsLambdaEdgeStorage } from "./awsLambdaEdgeStorage";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://signed.example.com/bundle.zip"),
}));

describe("awsLambdaEdgeStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the private key from SSM when storage config provides SSM metadata", async () => {
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

    const storage = awsLambdaEdgeStorage({
      bucketName: "test-bucket",
      region: "us-east-1",
      keyPairId: "K123",
      publicBaseUrl: "https://d111111abcdef8.cloudfront.net",
      ssmRegion: "us-east-1",
      ssmParameterName: "/hot-updater/cloudfront/key-pair",
    })();

    await expect(
      storage.getDownloadUrl("s3://test-bucket/releases/bundle.zip"),
    ).resolves.toEqual({
      fileUrl: "https://signed.example.com/bundle.zip",
    });

    expect(getParameter).toHaveBeenCalledTimes(1);
    expect(getParameter).toHaveBeenCalledWith({
      Name: "/hot-updater/cloudfront/key-pair",
      WithDecryption: true,
    });
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPairId: "K123",
        privateKey: "ssm-private-key",
        url: "https://d111111abcdef8.cloudfront.net/releases/bundle.zip",
      }),
    );
  });

  it("caches the private key fetched from SSM", async () => {
    const getParameter = vi
      .spyOn(SSM.prototype, "getParameter")
      .mockImplementation(
        async () =>
          ({
            Parameter: {
              Value: JSON.stringify({ privateKey: "cached-private-key" }),
            },
          }) as any,
      );

    const storage = awsLambdaEdgeStorage({
      bucketName: "test-bucket",
      region: "us-east-1",
      keyPairId: "K123",
      publicBaseUrl: "https://d111111abcdef8.cloudfront.net",
      ssmRegion: "us-east-1",
      ssmParameterName: "/hot-updater/cloudfront/key-pair/cached",
    })();

    await storage.getDownloadUrl("s3://test-bucket/releases/first.zip");
    await storage.getDownloadUrl("s3://test-bucket/releases/second.zip");

    expect(getParameter).toHaveBeenCalledTimes(1);
  });

  it("still supports a custom private key loader", async () => {
    const getPrivateKey = vi.fn().mockResolvedValue("custom-private-key");

    const storage = awsLambdaEdgeStorage({
      bucketName: "test-bucket",
      region: "us-east-1",
      keyPairId: "K123",
      publicBaseUrl: "https://d111111abcdef8.cloudfront.net",
      getPrivateKey,
    })();

    await storage.getDownloadUrl("s3://test-bucket/releases/bundle.zip");

    expect(getPrivateKey).toHaveBeenCalledTimes(1);
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKey: "custom-private-key",
      }),
    );
  });
});
