import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the built artifact embeds, per test: null for one that can't be read. */
let embedded: string | null = "pr-7";
/** The build type the scheme builds, per test. */
let buildType = "Release";

vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/android-helper")>()),
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
}));
vi.mock("@hot-updater/apple-helper", () => ({
  exportsForRegisteredDevices: vi.fn(async () => false),
  buildIos: vi.fn(async () => ({ logFilePath: null })),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: {
    log: {
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      message: vi.fn(),
    },
  },
  loadConfig: vi.fn(async () => ({})),
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve: vi.fn(), dispose: vi.fn() }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
// The project's own channel, as an Expo config plugin sets it.
vi.mock("@/utils/setChannel", () => ({
  getChannel: vi.fn(async () => ({ value: "production", paths: [] })),
}));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    const iosScheme = { configuration: buildType, simulator: true };
    const androidScheme = { variant: buildType, aab: false };
    await options.beforePrebuild?.({
      scheme: "preview",
      ...(options.platform === "ios" ? { iosScheme } : { androidScheme }),
    });
    return {
      buildAdapter: { name: "expo" },
      config: { cacheDir: null },
      outputPath: "/out",
      scheme: "preview",
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      ...(options.platform === "ios"
        ? { iosSchemeConfig: iosScheme }
        : { androidSchemeConfig: androidScheme }),
    };
  }),
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(
    async ({ platform, minBundleId, builder, readChannel }) => {
      await builder();
      return {
        platform,
        scheme: "preview",
        minBundleId,
        channel: await readChannel(),
        fingerprintHash: null,
        appVersion: "1.0.0",
        artifactPath: platform === "ios" ? "/out/Example.app" : "/out/app.apk",
        artifactKind: platform === "ios" ? "app" : "apk",
      };
    },
  ),
}));
vi.mock("../utils/native/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/sandbox")>()),
  assertBuiltArtifact: vi.fn(async () =>
    embedded === null
      ? null
      : { channel: embedded, appId: null, entry: { sandboxUrlScheme: null } },
  ),
  readBuiltArtifact: vi.fn(async () => {
    if (embedded === null) throw new Error("unreadable");
    return { channel: embedded };
  }),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => null),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(async () => ({
    key: { key: null, components: null, uncacheable: "it is a test" },
    slot: null,
    hit: null,
    report: { hit: null, key: null, uncacheable: "it is a test", changed: [] },
    remember: vi.fn(async () => {}),
  })),
  rememberTrackedBuild: vi.fn(async () => {}),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  isNativeBuildConflict: () => false,
  issueMinBundleId: vi.fn(async () => "019a0b1c-2d3f-7000-8000-000000000000"),
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => ({ id: "row" })),
}));

import { buildAndroid } from "@hot-updater/android-helper";
import { buildIos } from "@hot-updater/apple-helper";
import { p } from "@hot-updater/cli-tools";

import { registerNativeBuild } from "@/utils/native/registerNativeBuild";

import { reuseNativeBuild } from "../utils/native/reuseNativeBuild";
import { handleNativeBuildCreate } from "./buildNative";

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);

describe("native-build ios|android --channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedded = "pr-7";
    buildType = "Release";
  });

  it.each(["ios", "android"] as const)(
    "has the %s build embed the channel, whatever the project's config plugin says, and registers it there",
    async (platform) => {
      await handleNativeBuildCreate(platform, {
        scheme: "preview",
        channel: "pr-7",
      });

      const builder = platform === "ios" ? buildIos : buildAndroid;
      expect(builder).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "pr-7" }),
      );
      expect(reuseNativeBuild).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "pr-7" }),
      );
      expect(registerNativeBuild).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "pr-7" }),
        expect.anything(),
      );
    },
  );

  it("fails a build that doesn't embed it, and records nothing", async () => {
    embedded = "production";
    const exit = mockExit();
    try {
      await expect(
        handleNativeBuildCreate("android", {
          scheme: "preview",
          channel: "pr-7",
        }),
      ).rejects.toThrow("exit");
    } finally {
      exit.mockRestore();
    }
    expect(vi.mocked(p.log.error).mock.calls.flat().join("\n")).toContain(
      "The build embeds the production channel, not pr-7.",
    );
    expect(registerNativeBuild).not.toHaveBeenCalled();
  });

  it("fails a build whose channel can't be read, and records nothing", async () => {
    embedded = null;
    const exit = mockExit();
    try {
      await expect(
        handleNativeBuildCreate("ios", { scheme: "preview", channel: "pr-7" }),
      ).rejects.toThrow("exit");
    } finally {
      exit.mockRestore();
    }
    expect(vi.mocked(p.log.error).mock.calls.flat().join("\n")).toContain(
      "Couldn't read the channel the build embeds, so it can't be checked against --channel pr-7.",
    );
    expect(registerNativeBuild).not.toHaveBeenCalled();
  });

  describe("a Debug build, which is never tracked", () => {
    beforeEach(() => {
      buildType = "Debug";
    });

    it.each([
      [
        "embeds another channel",
        "production",
        "The build embeds the production channel, not pr-7.",
      ],
      [
        "embeds a channel that can't be read",
        null,
        "Couldn't read the channel the build embeds, so it can't be checked against --channel pr-7.",
      ],
    ] as const)("still fails when it %s", async (_, channel, message) => {
      embedded = channel;
      const exit = mockExit();
      try {
        await expect(
          handleNativeBuildCreate("android", {
            scheme: "preview",
            channel: "pr-7",
          }),
        ).rejects.toThrow("exit");
      } finally {
        exit.mockRestore();
      }
      expect(vi.mocked(p.log.error).mock.calls.flat().join("\n")).toContain(
        message,
      );
      expect(registerNativeBuild).not.toHaveBeenCalled();
    });

    it("passes when it embeds the channel, and stays untracked and uncached", async () => {
      await handleNativeBuildCreate("ios", {
        scheme: "preview",
        channel: "pr-7",
      });
      expect(registerNativeBuild).not.toHaveBeenCalled();
      expect(reuseNativeBuild).not.toHaveBeenCalled();
    });
  });

  it("refuses a channel no release can target before it builds", async () => {
    const exit = mockExit();
    try {
      await expect(
        handleNativeBuildCreate("ios", { scheme: "preview", channel: " pr-7" }),
      ).rejects.toThrow("exit");
    } finally {
      exit.mockRestore();
    }
    expect(vi.mocked(p.log.error).mock.calls.flat().join("\n")).toContain(
      "--channel  pr-7 is no channel a release can target",
    );
    expect(buildIos).not.toHaveBeenCalled();
  });

  it("builds the project's channel without it, as before", async () => {
    embedded = "production";
    await handleNativeBuildCreate("ios", { scheme: "preview" });

    expect(buildIos).toHaveBeenCalledWith(
      expect.not.objectContaining({ channel: expect.anything() }),
    );
    expect(registerNativeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "production" }),
      expect.anything(),
    );
  });
});
