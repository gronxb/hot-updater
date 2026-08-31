import { describe, expect, it } from "vitest";

import * as signingApi from "./signing";

const { awsKmsSigning, googleCloudKmsSigning, remoteSigning } = signingApi;

describe("signing exports", () => {
  it("exposes only the supported signing plugins", () => {
    expect(Object.keys(signingApi).sort()).toEqual([
      "awsKmsSigning",
      "googleCloudKmsSigning",
      "remoteSigning",
    ]);
  });
});

describe("remoteSigning", () => {
  it("exposes the generic managed signing protocol", () => {
    const signing = remoteSigning({
      endpoint: "https://signer.example.com",
      signingToken: "dedicated-token",
    });

    expect(signing.name).toBe("remoteSigning");
  });
});

describe("managed KMS signing", () => {
  it("creates AWS and Google Cloud signers without loading their SDKs", () => {
    expect(
      awsKmsSigning({
        keyId: "arn:aws:kms:us-east-1:123456789012:key/key-id",
        region: "us-east-1",
      }).name,
    ).toBe("awsKmsSigning");
    expect(
      googleCloudKmsSigning({
        keyVersion:
          "projects/project/locations/global/keyRings/ring/cryptoKeys/key/cryptoKeyVersions/1",
      }).name,
    ).toBe("googleCloudKmsSigning");
  });
});
