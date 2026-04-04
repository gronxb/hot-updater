import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import type {
  RequestEnvContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { withCloudFrontSignedUrl } from "./withCloudFrontSignedUrl";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://signed.example.com/bundle.zip"),
}));

type TestContext = RequestEnvContext;

const createBaseStorage = (): StoragePlugin<TestContext> => ({
  name: "baseStorage",
  supportedProtocol: "s3",
  async upload(key) {
    return { storageUri: `s3://test-bucket/${key}` };
  },
  async delete() {},
  async getDownloadUrl(storageUri) {
    return {
      fileUrl: storageUri.replace("s3://", "https://s3.example.com/"),
    };
  },
});

describe("withCloudFrontSignedUrl", () => {
  it("signs the CloudFront URL using the request origin", async () => {
    const storage = withCloudFrontSignedUrl<TestContext>(
      () => createBaseStorage(),
      {
        keyPairId: "K123",
        getPrivateKey: async () => "private-key",
        publicBaseUrl: (context) => {
          const request = context?.request;
          if (!request) {
            throw new Error("request is required");
          }
          return new URL(request.url).origin;
        },
        expiresSeconds: 60,
      },
    )();

    await expect(
      storage.getDownloadUrl("s3://test-bucket/releases/bundle.zip", {
        request: new Request(
          "https://d2zkxggbe748dg.cloudfront.net/api/check-update",
        ),
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
