import { describe, expect, it } from "vitest";

import { resolveUpdateCheckRequestBundleId } from "./update-check-request-bundle-id.ts";

describe("update-check request bundle id", () => {
  it("uses NIL_UUID before any OTA bundle is staged", () => {
    expect(
      resolveUpdateCheckRequestBundleId({
        stagingBundleId: null,
      }),
    ).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("uses the staged bundle id once the app has OTA metadata", () => {
    expect(
      resolveUpdateCheckRequestBundleId({
        stagingBundleId: "019e9db0-ea64-7610-be5a-4a62d8299a7c",
      }),
    ).toBe("019e9db0-ea64-7610-be5a-4a62d8299a7c");
  });
});
