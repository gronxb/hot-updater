import { describe, expect, it } from "vitest";
import { rewriteLegacyExactRequestToCanonical } from "./legacyExactRequest";

describe("rewriteLegacyExactRequestToCanonical", () => {
  it("rewrites legacy exact requests to canonical app-version routes", () => {
    const headers = new Headers({
      "x-app-platform": "ios",
      "x-app-version": "1.2.3",
      "x-bundle-id": "bundle-id",
      "x-min-bundle-id": "min-id",
      "x-channel": "production",
      "x-cohort": "qa team",
    });

    const rewritten = rewriteLegacyExactRequestToCanonical({
      basePath: "/hot-updater",
      request: new Request("https://example.com/hot-updater", {
        headers,
      }),
    });

    expect(rewritten).toBeInstanceOf(Request);
    expect((rewritten as Request).url).toBe(
      "https://example.com/hot-updater/app-version/ios/1.2.3/production/min-id/bundle-id/qa%20team",
    );
  });

  it("returns 400 when required legacy headers are missing", async () => {
    const response = rewriteLegacyExactRequestToCanonical({
      basePath: "/hot-updater",
      request: new Request("https://example.com/hot-updater"),
    });

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    await expect((response as Response).json()).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
  });
});
