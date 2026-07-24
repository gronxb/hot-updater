import { beforeAll, describe, expect, it } from "vitest";

let PRIVATE_EDGE_CACHE_CONTROL = "";

beforeAll(async () => {
  globalThis.HotUpdater = {
    API_KEY_SHA256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    CLOUDFRONT_KEY_PAIR_ID: "KTEST",
    SSM_PARAMETER_NAME: "/hot-updater/test",
    SSM_REGION: "us-east-1",
    S3_BUCKET_NAME: "hot-updater-test",
  };

  ({ PRIVATE_EDGE_CACHE_CONTROL } = await import("./index"));
});

describe("cacheControl", () => {
  it("prevents authenticated responses from entering viewer or shared caches", () => {
    // Given: the managed route requires a client API key.
    // When: the Lambda response cache policy is read.
    // Then: neither the browser nor CloudFront may store the response.
    expect(PRIVATE_EDGE_CACHE_CONTROL).toBe("private, no-store");
  });
});
