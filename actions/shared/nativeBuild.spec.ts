import { describe, expect, it } from "vitest";

import { nativeBuildVersionLabel } from "./nativeBuild.mjs";

describe("nativeBuildVersionLabel", () => {
  it("is the store's own label once a store took the build", () => {
    expect(
      nativeBuildVersionLabel({
        submitted_version: "1.7.0 (66)",
        native_app_version: "1.7.1",
        build_number: "67",
      }),
    ).toBe("1.7.0 (66)");
  });

  it("is the native version and build number, else the app version's", () => {
    expect(
      nativeBuildVersionLabel({
        native_app_version: "1.7.0",
        app_version: "1.x.x",
        build_number: "66",
      }),
    ).toBe("1.7.0 (66)");
    expect(
      nativeBuildVersionLabel({ app_version: "1.7.0", build_number: "66" }),
    ).toBe("1.7.0 (66)");
    expect(nativeBuildVersionLabel({ build_number: "66" })).toBe("66");
  });

  it("is null without a build number", () => {
    expect(nativeBuildVersionLabel({ app_version: "1.7.0" })).toBeNull();
  });
});
