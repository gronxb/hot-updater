import { beforeAll, describe, expect, it } from "vitest";

let ONE_YEAR_IN_SECONDS = 0;
let SHARED_EDGE_CACHE_CONTROL = "";

beforeAll(async () => {
  globalThis.HotUpdater = {
    CLOUDFRONT_KEY_PAIR_ID: "KTEST",
    SSM_PARAMETER_NAME: "/hot-updater/test",
    SSM_REGION: "us-east-1",
    S3_BUCKET_NAME: "hot-updater-test",
  };

  ({ ONE_YEAR_IN_SECONDS, SHARED_EDGE_CACHE_CONTROL } =
    await import("./index"));
});

describe("cacheControl", () => {
  it("caches path endpoints at the edge while forcing viewers to revalidate", () => {
    expect(SHARED_EDGE_CACHE_CONTROL).toBe(
      `public, max-age=0, s-maxage=${ONE_YEAR_IN_SECONDS}, must-revalidate`,
    );
    expect(SHARED_EDGE_CACHE_CONTROL).not.toContain("immutable");
  });
});
