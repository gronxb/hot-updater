import { describe, expect, it } from "vitest";
import { getBundleZipTargets } from "./getBundleZipTargets";

describe("getBundleZipTargets", () => {
  it("should select only HBC bundle files and remove the extension when HBC bundles are present (iOS)", async () => {
    const files = [
      "/path/to/assets/src/logo.png",
      "/path/to/BUNDLE_ID",
      "/path/to/index.ios.bundle",
      "/path/to/index.ios.bundle.map",
      "/path/to/index.ios.bundle.hbc",
      "/path/to/index.ios.bundle.hbc.map",
    ];

    const result = await getBundleZipTargets("/path/to/", files);

    expect(result).toEqual(
      expect.arrayContaining([
        { path: "/path/to/assets/src/logo.png", name: "assets/src/logo.png" },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        { path: "/path/to/index.ios.bundle.hbc", name: "index.ios.bundle" },
      ]),
    );
  });

  it("should use regular bundle files when no HBC bundle files are present (iOS)", async () => {
    const files = [
      "/path/to/assets/src/logo.png",
      "/path/to/BUNDLE_ID2",
      "/path/to/BUNDLE_ID",
      "/path/to/index.ios.bundle",
      "/path/to/index.ios.bundle.map",
    ];

    const result = await getBundleZipTargets("/path/to/", files);

    expect(result).toEqual(
      expect.arrayContaining([
        { path: "/path/to/assets/src/logo.png", name: "assets/src/logo.png" },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        { path: "/path/to/BUNDLE_ID2", name: "BUNDLE_ID2" },
        { path: "/path/to/index.ios.bundle", name: "index.ios.bundle" },
      ]),
    );
  });

  it("should select only HBC bundle files and remove the extension when HBC bundles are present (Android)", async () => {
    const files = [
      "/path/to/drawables/src/logo.png",
      "/path/to/drawables/image.png",
      "/path/to/BUNDLE_ID",
      "/path/to/index.android.bundle",
      "/path/to/index.android.bundle.map",
      "/path/to/index.android.bundle.hbc",
      "/path/to/index.android.bundle.hbc.map",
    ];

    const result = await getBundleZipTargets("/path/to/", files);

    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: "/path/to/drawables/src/logo.png",
          name: "drawables/src/logo.png",
        },
        {
          path: "/path/to/drawables/image.png",
          name: "drawables/image.png",
        },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        {
          path: "/path/to/index.android.bundle.hbc",
          name: "index.android.bundle",
        },
      ]),
    );
  });

  it("should use regular bundle files when no HBC bundle files are present (Android)", async () => {
    const files = [
      "/path/to/drawables/src/logo.png",
      "/path/to/drawables/image.png",
      "/path/to/BUNDLE_ID2",
      "/path/to/BUNDLE_ID",
      "/path/to/index.android.bundle",
      "/path/to/index.android.bundle.map",
    ];

    const result = await getBundleZipTargets("/path/to/", files);

    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: "/path/to/drawables/src/logo.png",
          name: "drawables/src/logo.png",
        },
        {
          path: "/path/to/drawables/image.png",
          name: "drawables/image.png",
        },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        { path: "/path/to/BUNDLE_ID2", name: "BUNDLE_ID2" },
        { path: "/path/to/index.android.bundle", name: "index.android.bundle" },
      ]),
    );
  });
});
