import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  applyTestFlightGroup,
  readTestFlightBuildStatus,
  readPlayInternalRelease,
} = vi.hoisted(() => ({
  applyTestFlightGroup: vi.fn(),
  readTestFlightBuildStatus: vi.fn(),
  readPlayInternalRelease: vi.fn(),
}));

vi.mock("@hot-updater/android-helper", () => ({
  playTestingUrl: (name: string) => `https://play.test/${name}`,
  readPlayInternalRelease,
  resolvePlayUploadServiceAccount: () => ({
    kind: "play-service-account",
    name: "play-service-account",
  }),
}));
vi.mock("@hot-updater/apple-helper", () => ({
  applyTestFlightGroup,
  readTestFlightBuildStatus,
  resolveTestFlightUploadKey: async () => ({
    kind: "asc-api-key",
    name: "asc-api-key",
  }),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  readLoadedHotUpdaterEnv: async () => ({}),
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve: vi.fn(async () => ({})), dispose: vi.fn() }),
  ),
}));
vi.mock("../version/getAndroidVersion", () => ({
  resolveSandboxApplicationId: vi.fn(async () => "com.example.app.sandbox"),
}));

import {
  applyStoreTestFlightGroup,
  isStoreBuildReusable,
  readStoreStatus,
} from "./storeStatus";

const DAY = 24 * 60 * 60 * 1_000;

const config = {
  nativeBuild: {
    ios: { sandbox: { bundleIdentifier: "com.example.app", sandbox: true } },
    android: { sandbox: { packageName: "com.example.app", sandbox: true } },
  },
} as never;

const row = (overrides: Partial<NativeBuildRow>) =>
  ({
    id: "build-1",
    submitted_to: "testflight",
    submitted_version: "1.7.0 (66)",
    build_number: "66",
    ...overrides,
  }) as NativeBuildRow;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isStoreBuildReusable", () => {
  const now = 1_000 * DAY;

  it.each(["failed", "expired", "replaced", "missing"] as const)(
    "needs a new build once it is %s",
    (state) => {
      expect(isStoreBuildReusable(state, null, now)).toBe(false);
    },
  );

  it.each([
    "processing",
    "ready",
    "missing-compliance",
    "draft",
    null,
  ] as const)("reuses a build in state %s", (state) => {
    expect(isStoreBuildReusable(state, null, now)).toBe(true);
  });

  it("builds again within a week of its expiry", () => {
    expect(isStoreBuildReusable("ready", now + 8 * DAY, now)).toBe(true);
    expect(isStoreBuildReusable("ready", now + 6 * DAY, now)).toBe(false);
  });
});

describe("readStoreStatus", () => {
  const read = (platform: "ios" | "android", build: NativeBuildRow) => {
    const onError = vi.fn();
    return {
      onError,
      status: readStoreStatus(config, {
        platform,
        scheme: "sandbox",
        build,
        onError,
      }),
    };
  };

  it("asks App Store Connect by the recorded version and number", async () => {
    const expiresAtMs = Date.now() + 60 * DAY;
    readTestFlightBuildStatus.mockResolvedValue({
      testFlightUrl: "https://asc.test/apps/1/testflight/ios",
      status: { state: "processing", expiresAtMs },
    });

    await expect(read("ios", row({})).status).resolves.toEqual({
      destination: "testflight",
      url: "https://asc.test/apps/1/testflight/ios",
      version: "1.7.0 (66)",
      state: "processing",
      expiresAtMs,
      reusable: true,
    });
    expect(readTestFlightBuildStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleId: "com.example.app",
        shortVersion: "1.7.0",
        bundleVersion: "66",
      }),
    );
  });

  it("needs a new build once App Store Connect no longer lists it", async () => {
    readTestFlightBuildStatus.mockResolvedValue({
      testFlightUrl: "https://asc.test",
      status: null,
    });
    await expect(read("ios", row({})).status).resolves.toMatchObject({
      state: "missing",
      reusable: false,
    });
  });

  it.each([
    ["completed", "ready", true],
    ["inProgress", "ready", true],
    ["draft", "draft", true],
    [null, "replaced", false],
  ])(
    "maps Google Play's release %s to %s",
    async (release, state, reusable) => {
      readPlayInternalRelease.mockResolvedValue(release);
      await expect(
        read(
          "android",
          row({
            submitted_to: "play-internal",
            submitted_version: "1.7.0 (42)",
          }),
        ).status,
      ).resolves.toEqual({
        destination: "play-internal",
        url: "https://play.test/com.example.app.sandbox",
        version: "1.7.0 (42)",
        state,
        expiresAtMs: null,
        reusable,
      });
      expect(readPlayInternalRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          versionCode: 42,
          packageName: "com.example.app.sandbox",
        }),
      );
    },
  );

  it("falls back on the record, and says why, when the store can't be read", async () => {
    const failure = new Error("App Store Connect refused the API key.");
    readTestFlightBuildStatus.mockRejectedValue(failure);
    const { status, onError } = read("ios", row({}));
    await expect(status).resolves.toEqual({
      destination: "testflight",
      url: null,
      version: "1.7.0 (66)",
      state: null,
      expiresAtMs: null,
      reusable: true,
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe("applyStoreTestFlightGroup", () => {
  const apply = () =>
    applyStoreTestFlightGroup(config, {
      scheme: "sandbox",
      build: row({}),
      group: "QA",
    });

  it("applies the group to the recorded version and number, and prints the store's word", async () => {
    const expiresAtMs = Date.now() + 60 * DAY;
    applyTestFlightGroup.mockResolvedValue({
      testFlightUrl: "https://asc.test/apps/1/testflight/ios",
      status: { state: "ready", expiresAtMs },
      outcome: "added",
    });

    await expect(apply()).resolves.toEqual({
      destination: "testflight",
      url: "https://asc.test/apps/1/testflight/ios",
      version: "1.7.0 (66)",
      state: "ready",
      expiresAtMs,
      reusable: true,
      group: "added",
    });
    expect(applyTestFlightGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleId: "com.example.app",
        shortVersion: "1.7.0",
        bundleVersion: "66",
        name: "QA",
      }),
    );
  });

  it("takes only a build a tester can still get for long enough", async () => {
    applyTestFlightGroup.mockResolvedValue({
      testFlightUrl: "https://asc.test",
      status: null,
      outcome: "not-offered",
    });
    await expect(apply()).resolves.toMatchObject({
      state: "missing",
      reusable: false,
      group: "not-offered",
    });
    const { isOffered } = applyTestFlightGroup.mock.calls[0]![0];
    expect(isOffered(null)).toBe(false);
    expect(
      isOffered({ state: "ready", expiresAtMs: Date.now() + 60 * DAY }),
    ).toBe(true);
    expect(isOffered({ state: "processing", expiresAtMs: null })).toBe(true);
    expect(isOffered({ state: "ready", expiresAtMs: Date.now() + DAY })).toBe(
      false,
    );
    expect(isOffered({ state: "expired", expiresAtMs: null })).toBe(false);
  });

  it("fails when the group can't be applied: it was asked for", async () => {
    applyTestFlightGroup.mockRejectedValue(
      new Error("TestFlight group QA is external"),
    );
    await expect(apply()).rejects.toThrow("TestFlight group QA is external");
  });
});
