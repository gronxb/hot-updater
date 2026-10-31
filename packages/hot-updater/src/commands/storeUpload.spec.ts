import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, select, isCancel, handleNativeBuildCreate } = vi.hoisted(() => ({
  log: { error: vi.fn(), info: vi.fn() },
  select: vi.fn(),
  isCancel: vi.fn((_answer: unknown) => false),
  handleNativeBuildCreate: vi.fn(
    async (_platform: string, _options: unknown) => ({}),
  ),
}));

// The config, the prompt, and the build handlers are stood in for; which
// scheme a store takes is the helpers' own check, unmocked.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  p: { log, select, isCancel },
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("./buildNative", () => ({ handleNativeBuildCreate }));

import { loadConfig } from "@hot-updater/cli-tools";
import { secret } from "@hot-updater/cli-tools";

import { handleGooglePlayUpload, handleTestFlight } from "./storeUpload";

const IOS_DEVICE = {
  bundleIdentifier: "com.example.app",
  scheme: "App",
  signing: { ascApiKey: secret("asc-api-key") },
};
const ANDROID_RELEASE = {
  packageName: "com.example.app",
  signing: { keystore: secret("release-keystore") },
};

/**
 * Each shortcut, what it builds with, the schemes the store takes and
 * refuses (with the refusal apple-helper or android-helper words), and its
 * words.
 */
const SHORTCUTS = [
  {
    command: "testflight",
    run: handleTestFlight,
    platform: "ios",
    store: "TestFlight",
    upload: "testflight",
    uploadable: IOS_DEVICE,
    refused: {
      simulator: { ...IOS_DEVICE, simulator: true },
      debug: { ...IOS_DEVICE, configuration: "Debug" },
    },
    refusals: [
      "The scheme simulator builds a simulator .app, not an .ipa for TestFlight.",
      "The scheme debug builds Debug; TestFlight takes a release build.",
    ],
    docs: "https://hot-updater.dev/docs/native-builds/testflight#upload-to-testflight",
  },
  {
    command: "google-play upload",
    run: handleGooglePlayUpload,
    platform: "android",
    store: "Google Play",
    upload: "play-internal",
    uploadable: ANDROID_RELEASE,
    refused: {
      apk: { ...ANDROID_RELEASE, aab: false },
      debug: { ...ANDROID_RELEASE, variant: "Debug" },
    },
    refusals: [
      "The scheme apk builds an .apk (aab: false); Google Play takes an .aab.",
      "The scheme debug builds Debug; Google Play takes a release build.",
    ],
    docs: "https://hot-updater.dev/docs/native-builds/google-play#upload-to-google-play",
  },
] as const;

const withTTY = async <T>(isTTY: boolean, run: () => Promise<T>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

describe.each(SHORTCUTS)("hot-updater $command", (shortcut) => {
  const { platform, store, upload } = shortcut;
  const configure = (schemes: Record<string, unknown>) => {
    vi.mocked(loadConfig).mockResolvedValue({
      nativeBuild: {
        ios: {},
        android: {},
        [platform]: schemes,
      },
    } as never);
  };
  /** The platform and options native-build's handler is called with. */
  const built = () => handleNativeBuildCreate.mock.calls;
  const full = shortcut.upload === "testflight" ? "ios" : "android";

  it(`runs native-build ${platform}'s handler with --submit ${upload} for the scheme given, tracking it, without reading the config`, async () => {
    await withTTY(false, () => shortcut.run({ scheme: "release" }));

    expect(loadConfig).not.toHaveBeenCalled();
    expect(built()).toEqual([[full, { scheme: "release", submit: upload }]]);
  });

  it(`uses the only scheme ${store} takes, skipping the others, and says which`, async () => {
    configure({ release: shortcut.uploadable, ...shortcut.refused });

    await withTTY(false, () => shortcut.run({}));

    expect(loadConfig).toHaveBeenCalledWith({ platform, channel: "" });
    expect(process.exitCode).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `Using release, the only nativeBuild.${platform} scheme for ${store}.`,
    );
    expect(built()).toEqual([[full, { scheme: "release", submit: upload }]]);
  });

  it(`asks which scheme at a terminal when several upload to ${store}`, async () => {
    configure({
      staging: shortcut.uploadable,
      release: shortcut.uploadable,
      ...shortcut.refused,
    });
    select.mockResolvedValueOnce("staging");

    await withTTY(true, () => shortcut.run({}));

    expect(select).toHaveBeenCalledWith({
      message: `Which scheme do you upload to ${store}?`,
      options: [
        { value: "release", label: "release" },
        { value: "staging", label: "staging" },
      ],
    });
    expect(built()).toEqual([[full, { scheme: "staging", submit: upload }]]);
  });

  it.each([
    ["without a terminal", false, "", "without a terminal"],
    ["in CI, even at a terminal", true, "true", "in CI (CI is set)"],
  ])(
    "refuses several schemes %s, listing them and the --scheme form",
    async (_case, isTTY, ci, reason) => {
      vi.stubEnv("CI", ci);
      configure({ staging: shortcut.uploadable, release: shortcut.uploadable });

      await withTTY(isTTY, () => shortcut.run({}));

      expect(process.exitCode).toBe(1);
      expect(select).not.toHaveBeenCalled();
      expect(handleNativeBuildCreate).not.toHaveBeenCalled();
      expect(
        stripVTControlCharacters(String(log.error.mock.calls[0]![0])),
      ).toBe(
        `Several nativeBuild.${platform} schemes upload to ${store}: release, staging.\nCan't ask which one ${reason}.\nPick one: npx hot-updater ${shortcut.command} --scheme <release | staging>`,
      );
    },
  );

  it(`refuses when no scheme uploads to ${store}, saying why each does not and how to add one`, async () => {
    configure(shortcut.refused);

    await withTTY(true, () => shortcut.run({}));

    expect(process.exitCode).toBe(1);
    expect(handleNativeBuildCreate).not.toHaveBeenCalled();
    const [message] = log.error.mock.calls[0]!;
    expect(message).toContain(
      `No nativeBuild.${platform} scheme uploads to ${store}.`,
    );
    for (const refusal of shortcut.refusals) {
      expect(message).toContain(refusal);
    }
    expect(message).toContain(shortcut.docs);
  });

  it("refuses a config without schemes for the platform", async () => {
    configure({});

    await withTTY(true, () => shortcut.run({}));

    expect(process.exitCode).toBe(1);
    expect(handleNativeBuildCreate).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(shortcut.docs),
    );
  });

  it("builds nothing when the scheme prompt is cancelled", async () => {
    configure({ staging: shortcut.uploadable, release: shortcut.uploadable });
    const cancel = Symbol("cancel");
    select.mockResolvedValueOnce(cancel);
    isCancel.mockImplementationOnce((answer) => answer === cancel);

    await withTTY(true, () => shortcut.run({}));

    expect(process.exitCode).toBe(1);
    expect(handleNativeBuildCreate).not.toHaveBeenCalled();
  });
});

describe("hot-updater testflight scheme eligibility", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "testflight-schemes-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips an unsigned scheme with development export options, so CI builds the one App Store scheme", async () => {
    // QA #14: deviceUnsigned exports for development with code signing off.
    const development = path.join(dir, "Development.plist");
    await fs.writeFile(
      development,
      "<plist><dict><key>method</key><string>development</string></dict></plist>",
    );
    vi.mocked(loadConfig).mockResolvedValue({
      nativeBuild: {
        android: {},
        ios: {
          release: IOS_DEVICE,
          deviceUnsigned: {
            bundleIdentifier: "com.example.app",
            scheme: "App",
            exportOptionsPlist: development,
            extraParams: [
              "CODE_SIGNING_ALLOWED=NO",
              "CODE_SIGNING_REQUIRED=NO",
            ],
          },
        },
      },
    } as never);

    await withTTY(false, () => handleTestFlight({}));

    expect(process.exitCode).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "Using release, the only nativeBuild.ios scheme for TestFlight.",
    );
    expect(handleNativeBuildCreate.mock.calls).toEqual([
      ["ios", { scheme: "release", submit: "testflight" }],
    ]);
  });

  it("says why each refused scheme can't upload when none can", async () => {
    const development = path.join(dir, "Development.plist");
    await fs.writeFile(
      development,
      "<plist><dict><key>method</key><string>development</string></dict></plist>",
    );
    vi.mocked(loadConfig).mockResolvedValue({
      nativeBuild: {
        android: {},
        ios: {
          deviceUnsigned: {
            ...IOS_DEVICE,
            extraParams: ["CODE_SIGNING_ALLOWED=NO"],
          },
          development: { ...IOS_DEVICE, exportOptionsPlist: development },
        },
      },
    } as never);

    await withTTY(false, () => handleTestFlight({}));

    expect(process.exitCode).toBe(1);
    const [message] = log.error.mock.calls[0]!;
    expect(message).toContain(
      "The scheme deviceUnsigned turns code signing off:\nCODE_SIGNING_ALLOWED=NO in extraParams",
    );
    expect(message).toContain(
      "The scheme development's exportOptionsPlist uses method development.",
    );
  });
});
