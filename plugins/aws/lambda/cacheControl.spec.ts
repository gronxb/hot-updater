import { describe, expect, it } from "vitest";
import {
  NO_STORE_CACHE_CONTROL,
  ONE_YEAR_IN_SECONDS,
  SHARED_EDGE_CACHE_CONTROL,
} from "./cacheControl";

describe("cacheControl", () => {
  it("keeps legacy endpoint uncached", () => {
    expect(NO_STORE_CACHE_CONTROL).toBe("no-store");
  });

  it("caches path endpoints at the edge while forcing viewers to revalidate", () => {
    expect(SHARED_EDGE_CACHE_CONTROL).toBe(
      `public, max-age=0, s-maxage=${ONE_YEAR_IN_SECONDS}, must-revalidate`,
    );
    expect(SHARED_EDGE_CACHE_CONTROL).not.toContain("immutable");
  });
});
