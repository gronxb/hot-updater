import type { UpdateSource } from "@hot-updater/internal";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "./checkForUpdate";
import * as natives from "./native";

vi.mock("./native", () => ({
  getAppVersion: async () => "1.0",
  getBundleVersion: async () => 1,
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

describe("appVersion 1.0, bundleVersion null", async () => {
  beforeAll(() => {
    vi.spyOn(natives, "getAppVersion").mockImplementation(async () => "1.0");
    vi.spyOn(natives, "getBundleVersion").mockImplementation(async () => 0);
  });

  it("should return null if no update information is available", async () => {
    const updateSources: UpdateSource[] = [];

    const update = await checkForUpdate(updateSources);
    expect(update).toBeNull();
  });

  it("should return null if no update is available when the app version is higher", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.1",
        enabled: true,
        bundleVersion: 1,
        forceUpdate: false,
        files: [],
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toBeNull();
  });

  it("should update if a higher bundle with semver version exists", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.x.x",
        enabled: true,
        bundleVersion: 1,
        forceUpdate: false,
        files: [],
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        enabled: true,
        bundleVersion: 2,
        forceUpdate: false,
        files: [],
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      bundleVersion: 2,
      forceUpdate: false,
      status: "UPDATE",
      files: [],
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to true", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        enabled: true,
        bundleVersion: 1,
        forceUpdate: true,
        files: [],
      },
    ];
    const update = await checkForUpdate(updateSources);

    expect(update).toStrictEqual({
      bundleVersion: 1,
      forceUpdate: true,
      status: "UPDATE",
      files: [],
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        enabled: true,
        bundleVersion: 1,
        forceUpdate: false,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 1,
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 5,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      bundleVersion: 5,
      forceUpdate: false,
      status: "UPDATE",
      files: [],
    });
  });

  it("should update if the latest version is not available but a previous version is available", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: true,
        enabled: false, // Disabled
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 1,
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should not update if all updates are disabled", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: true,
        enabled: false, // Disabled
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: false, // Disabled
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toBeNull();
  });
});

describe("appVersion 1.0, bundleVersion v2", async () => {
  beforeAll(() => {
    vi.spyOn(natives, "getAppVersion").mockImplementation(async () => "1.0");
    vi.spyOn(natives, "getBundleVersion").mockImplementation(async () => 2);
  });

  it("should return null if no update information is available", async () => {
    const updateSources: UpdateSource[] = [];

    const update = await checkForUpdate(updateSources);
    expect(update).toBeNull();
  });

  it("should return null if no update is available when the app version is higher", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toBeNull();
  });

  it("should rollback if the latest bundle is deleted", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 1,
      forceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 3,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 3,
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 5, // Higher than the current version
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 4,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 3,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 5,
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should not update if the latest version is disabled and matches the current version", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: true,
        enabled: false, // Disabled
        bundleVersion: 3,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: true,
        enabled: true,
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toBeNull();
  });

  it("should rollback to a previous version if the current version is disabled", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: true,
        enabled: false, // Disabled
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: true,
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 1,
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("should rollback to the original bundle when receiving the latest bundle but all updates are disabled", async () => {
    const updateSources: UpdateSource[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: true,
        enabled: false, // Disabled
        bundleVersion: 2,
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        files: [],
        forceUpdate: false,
        enabled: false, // Disabled
        bundleVersion: 1,
      },
    ];

    const update = await checkForUpdate(updateSources);
    expect(update).toStrictEqual({
      files: [],
      bundleVersion: 0,
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });
});
