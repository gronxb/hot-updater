import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { NIL_UUID } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";
import { withSignedUrl } from "./withSignedUrl";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://signed.example.com/bundle.zip"),
}));

describe("withSignedUrl", () => {
  it("returns null when there is no update", async () => {
    await expect(
      withSignedUrl({
        data: null,
        reqUrl: "https://d111111abcdef8.cloudfront.net/api/check-update",
        keyPairId: "K123",
        privateKey: "private-key",
      }),
    ).resolves.toBeNull();
  });

  it("returns a null fileUrl for nil or missing storage", async () => {
    await expect(
      withSignedUrl({
        data: {
          id: NIL_UUID,
          storageUri: "s3://hot-updater-storage/test/bundle.zip",
        },
        reqUrl: "https://d111111abcdef8.cloudfront.net/api/check-update",
        keyPairId: "K123",
        privateKey: "private-key",
      }),
    ).resolves.toEqual({
      id: NIL_UUID,
      fileUrl: null,
    });
  });

  it("signs the CloudFront URL using the request origin and storage path", async () => {
    const result = await withSignedUrl({
      data: {
        id: "019cccf6-adf9-76e5-818f-6ab0b77254a1",
        storageUri:
          "s3://hot-updater-storage/019cccf6-adf9-76e5-818f-6ab0b77254a1/bundle.zip",
      },
      reqUrl:
        "https://d2zkxggbe748dg.cloudfront.net/api/check-update/app-version/ios/1.0/production/default/default",
      keyPairId: "K2508MCUU23NDP",
      privateKey: "private-key",
      expiresSeconds: 60,
    });

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://d2zkxggbe748dg.cloudfront.net/019cccf6-adf9-76e5-818f-6ab0b77254a1/bundle.zip",
        keyPairId: "K2508MCUU23NDP",
        privateKey: "private-key",
      }),
    );
    expect(result).toEqual({
      id: "019cccf6-adf9-76e5-818f-6ab0b77254a1",
      fileUrl: "https://signed.example.com/bundle.zip",
    });
  });
});
