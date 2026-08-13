import { describe, expect, it } from "vitest";

import {
  assertCatalogUrlHasNoDeviceState,
  buildReleaseCatalogUrl,
} from "./release-catalog-url.ts";

describe("Release catalog request URL", () => {
  it("is shared by a scope and excludes install decision state", () => {
    const url = buildReleaseCatalogUrl({
      appVersion: "1.0",
      authorityId: "project-a",
      baseUrl: "https://updates.example.com/hot-updater/",
      channel: "production",
      platform: "ios",
    });
    const deviceState = [
      "current-release",
      "current-bundle",
      "minimum-release",
      "install-id",
      "qa-cohort",
      "crashed-bundle",
    ];

    expect(url).toBe(
      "https://updates.example.com/hot-updater/v2/release-catalogs/app-version/project-a/ios/cHJvZHVjdGlvbg/1.0.0",
    );
    expect(() =>
      assertCatalogUrlHasNoDeviceState(url, deviceState),
    ).not.toThrow();
    for (const value of deviceState) expect(url).not.toContain(value);
  });

  it("rejects an app version that cannot identify a canonical catalog", () => {
    expect(() =>
      buildReleaseCatalogUrl({
        appVersion: "not-a-version",
        authorityId: "project-a",
        baseUrl: "https://updates.example.com/hot-updater",
        channel: "production",
        platform: "android",
      }),
    ).toThrow("Invalid Release catalog app version: not-a-version");
  });

  it("rejects a fixture URL that leaks any device decision input", () => {
    expect(() =>
      assertCatalogUrlHasNoDeviceState(
        "https://updates.example.com/catalog?cohort=qa-cohort",
        ["qa-cohort"],
      ),
    ).toThrow("Release catalog URL exposes device state: qa-cohort");
  });
});
