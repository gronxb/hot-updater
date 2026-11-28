import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log: { info: vi.fn(), warn: vi.fn() } },
}));

import {
  nextBuildNumber,
  patchSandboxArchive,
  patchSandboxSimulatorApp,
} from "./sandboxInfoPlist";

const scheme = {
  hotUpdaterSchemeName: "release",
  bundleIdentifier: "com.example.App",
};
const SANDBOX_URL_TYPE = {
  CFBundleURLName: "hot-updater-sandbox",
  CFBundleURLSchemes: ["hu-sandbox-com-example-app"],
};

describe("nextBuildNumber", () => {
  it.each([
    ["the store has none", "5", null, null],
    ["this build's is already higher", "70", 68, null],
    ["this build's isn't an integer", "1.2.3", 68, null],
  ])("keeps the build number when %s", (_, current, highest, expected) => {
    expect(nextBuildNumber(current, highest)).toBe(expected);
  });

  it.each([
    ["equal", "68", 68, "69"],
    ["lower", "1", 68, "69"],
    ["missing", null, 68, "69"],
  ])(
    "takes the one after the store's when it is %s",
    (_, current, highest, expected) => {
      expect(nextBuildNumber(current, highest)).toBe(expected);
    },
  );
});

// plutil and codesign, the tools the build uses, read the result.
describe.runIf(process.platform === "darwin")("patching with plutil", () => {
  let root: string;
  let archive: string;
  let app: string;
  let appex: string;

  const writePlist = async (file: string, value: unknown) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    // A binary plist, as Xcode packs an app's.
    execFileSync("plutil", ["-convert", "binary1", file]);
  };
  const read = (file: string): Record<string, any> =>
    JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", file], {
        encoding: "utf8",
      }),
    );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-plist-"));
    archive = path.join(root, "App.xcarchive");
    app = path.join(archive, "Products/Applications/App.app");
    appex = path.join(app, "PlugIns/Widget.appex");
    await writePlist(path.join(archive, "Info.plist"), {
      ApplicationProperties: {
        CFBundleShortVersionString: "1.6.2",
        CFBundleVersion: "5",
      },
    });
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      CFBundleShortVersionString: "1.6.2",
      CFBundleVersion: "5",
      HOT_UPDATER_CHANNEL: "production",
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["myapp"] }],
    });
    await writePlist(path.join(appex, "Info.plist"), {
      CFBundleIdentifier: "com.example.App.widget",
      CFBundleShortVersionString: "1.6.2",
      CFBundleVersion: "5",
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("adds the URL scheme after the app's own and its key, and keeps the bundle ID and the project's channel", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
    });

    const info = read(path.join(app, "Info.plist"));
    expect(info).toMatchObject({
      CFBundleIdentifier: "com.example.App",
      HOT_UPDATER_CHANNEL: "production",
      HOT_UPDATER_SANDBOX: true,
      CFBundleURLTypes: [{ CFBundleURLSchemes: ["myapp"] }, SANDBOX_URL_TYPE],
      // Nothing to fit in App Store Connect without a train.
      CFBundleShortVersionString: "1.6.2",
      CFBundleVersion: "5",
    });
    expect(read(path.join(appex, "Info.plist")).HOT_UPDATER_SANDBOX).toBe(
      undefined,
    );
  });

  it("adds what the screen asks the system for, to the app alone", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
    });

    const info = read(path.join(app, "Info.plist"));
    expect(info.NSCameraUsageDescription).toEqual(expect.any(String));
    expect(info.NSLocalNetworkUsageDescription).toEqual(expect.any(String));
    expect(info.NSAppTransportSecurity).toEqual({
      NSAllowsLocalNetworking: true,
    });
    const extension = read(path.join(appex, "Info.plist"));
    expect(extension.NSCameraUsageDescription).toBe(undefined);
    expect(extension.NSAppTransportSecurity).toBe(undefined);
  });

  it("keeps what the app already set, and its nested transport security entries", async () => {
    const domains = {
      "api.example.com": { NSExceptionAllowsInsecureHTTPLoads: true },
    };
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      NSCameraUsageDescription: "The app's own words",
      NSLocalNetworkUsageDescription: "The app's own network words",
      NSAppTransportSecurity: { NSExceptionDomains: domains },
    });

    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
    });

    expect(read(path.join(app, "Info.plist"))).toMatchObject({
      NSCameraUsageDescription: "The app's own words",
      NSLocalNetworkUsageDescription: "The app's own network words",
      NSAppTransportSecurity: {
        NSExceptionDomains: domains,
        NSAllowsLocalNetworking: true,
      },
    });
  });

  it("keeps the app's own local networking value", async () => {
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      NSAppTransportSecurity: { NSAllowsLocalNetworking: false },
    });

    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
    });

    expect(read(path.join(app, "Info.plist")).NSAppTransportSecurity).toEqual({
      NSAllowsLocalNetworking: false,
    });
  });

  it("gives an app with no URL types the sandbox's", async () => {
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      CFBundleShortVersionString: "1.0.0",
    });
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
    });
    expect(read(path.join(app, "Info.plist")).CFBundleURLTypes).toEqual([
      SANDBOX_URL_TYPE,
    ]);
  });

  it("derives the URL scheme from a separate app's ID", async () => {
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App.sandbox",
    });
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: {
        hotUpdaterSchemeName: "release",
        bundleIdentifier: "com.example.App.sandbox",
      },
    });
    expect(read(path.join(app, "Info.plist"))).toMatchObject({
      CFBundleIdentifier: "com.example.App.sandbox",
      CFBundleURLTypes: [
        {
          CFBundleURLName: "hot-updater-sandbox",
          CFBundleURLSchemes: ["hu-sandbox-com-example-app-sandbox"],
        },
      ],
    });
  });

  it("registers the URL scheme the scheme sets, in the URL type the build reads it from", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: { ...scheme, sandboxUrlScheme: "acme-preview" },
    });
    expect(read(path.join(app, "Info.plist")).CFBundleURLTypes).toEqual([
      { CFBundleURLSchemes: ["myapp"] },
      {
        CFBundleURLName: "hot-updater-sandbox",
        CFBundleURLSchemes: ["acme-preview"],
      },
    ]);
  });

  it("patches an app it patched before with one sandbox URL type, the latest", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
    });
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: { ...scheme, sandboxUrlScheme: "acme-preview" },
    });
    expect(read(path.join(app, "Info.plist")).CFBundleURLTypes).toEqual([
      { CFBundleURLSchemes: ["myapp"] },
      {
        CFBundleURLName: "hot-updater-sandbox",
        CFBundleURLSchemes: ["acme-preview"],
      },
    ]);
  });

  it("re-patches with a changed scheme when the sandbox's URL type holds only its own", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: { ...scheme, sandboxUrlScheme: "old-preview" },
    });
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: { ...scheme, sandboxUrlScheme: "new-preview" },
    });
    expect(read(path.join(app, "Info.plist")).CFBundleURLTypes).toEqual([
      { CFBundleURLSchemes: ["myapp"] },
      {
        CFBundleURLName: "hot-updater-sandbox",
        CFBundleURLSchemes: ["new-preview"],
      },
    ]);
  });

  describe("re-patching an app an earlier patch made a sandbox app", () => {
    const appPlist = () => path.join(app, "Info.plist");
    /** A prerelease's patch, which recorded no scheme. */
    const ABSENT = Symbol("absent");
    /** A patched plist: the marker, the recorded scheme unless absent, and these URL types. */
    const patchedPlist = async (
      sandboxTypes: unknown[],
      recorded: unknown = "old-preview",
    ) =>
      writePlist(appPlist(), {
        CFBundleIdentifier: "com.example.App",
        HOT_UPDATER_SANDBOX: true,
        ...(recorded === ABSENT
          ? {}
          : { HOT_UPDATER_SANDBOX_URL_SCHEME: recorded }),
        CFBundleURLTypes: [{ CFBundleURLSchemes: ["myapp"] }, ...sandboxTypes],
      });
    const named = (schemes: string[]) => ({
      CFBundleURLName: "hot-updater-sandbox",
      CFBundleURLSchemes: schemes,
    });
    const patch = (sandboxUrlScheme: string) =>
      patchSandboxArchive({
        archivePath: archive,
        appPath: app,
        schemeConfig: { ...scheme, sandboxUrlScheme },
      });

    const keep = (scheme: string) =>
      `Keep exactly one hot-updater-sandbox URL type, holding only ${scheme}, and move the rest to a URL type of the app's own.`;

    it.each([
      [
        "our scheme, then the app's",
        [named(["old-preview", "app-login"])],
        "The app's hot-updater-sandbox URL type holds old-preview, app-login.",
      ],
      [
        "the app's scheme, then ours",
        [named(["app-login", "old-preview"])],
        "The app's hot-updater-sandbox URL type holds app-login, old-preview.",
      ],
      [
        "two URL types of the name",
        [named([]), named(["app-login"])],
        "The app has 2 hot-updater-sandbox URL types, holding app-login.",
      ],
      [
        "two URL types of the name, each with our scheme",
        [named(["old-preview"]), named(["old-preview"])],
        "The app has 2 hot-updater-sandbox URL types, holding old-preview, old-preview.",
      ],
      [
        "no URL type of the name, though it recorded a scheme",
        [],
        "The app has 0 hot-updater-sandbox URL types.",
      ],
      [
        "an empty list",
        [named([])],
        "The app's hot-updater-sandbox URL type holds no scheme.",
      ],
      [
        "our scheme twice",
        [named(["old-preview", "old-preview"])],
        "The app's hot-updater-sandbox URL type holds old-preview, old-preview.",
      ],
      [
        "another scheme than the one recorded",
        [named(["app-login"])],
        "The app's hot-updater-sandbox URL type holds app-login.",
      ],
    ])(
      "refuses %s, naming what it holds, and patches nothing",
      async (_, sandboxTypes, found) => {
        await patchedPlist(sandboxTypes);
        const before = await fs.readFile(appPlist());
        const message = `${found}\n${keep("old-preview")}`;

        await expect(patch("new-preview")).rejects.toMatchObject({
          message,
          hint: message,
        });
        expect(await fs.readFile(appPlist())).toEqual(before);
      },
    );

    it.each([
      ["an empty string", "", '""', ["hu-sandbox-com-example-app"]],
      [
        "a Kelvin sign",
        "\u212A-preview",
        '"\u212A-preview"',
        ["\u212A-preview"],
      ],
      ["upper case", "Old-Preview", '"Old-Preview"', ["Old-Preview"]],
      ["a number", 42, "42", ["old-preview"]],
    ])(
      "refuses a recorded scheme of %s, with no fallback, and patches nothing",
      async (_, recorded, shown, schemes) => {
        await patchedPlist([named(schemes)], recorded);
        const before = await fs.readFile(appPlist());
        const message = `The app's Info.plist records sandbox URL scheme ${shown} in HOT_UPDATER_SANDBOX_URL_SCHEME, which isn't a URL scheme.\nBuild the app again: a new build records none.`;

        await expect(patch("new-preview")).rejects.toMatchObject({ message });
        expect(await fs.readFile(appPlist())).toEqual(before);
      },
    );

    it("refuses a prerelease's patched plist whose sandbox URL type isn't the derived scheme alone", async () => {
      await patchedPlist([named(["app-login"])], ABSENT);
      const before = await fs.readFile(appPlist());
      const message = `The app's hot-updater-sandbox URL type holds app-login.\n${keep("hu-sandbox-com-example-app")}`;

      await expect(patch("new-preview")).rejects.toMatchObject({ message });
      expect(await fs.readFile(appPlist())).toEqual(before);
    });

    it("re-patches a prerelease's patched plist, which recorded no scheme, from its derived one", async () => {
      await patchedPlist([named(["hu-sandbox-com-example-app"])], ABSENT);
      await patch("new-preview");

      expect(read(appPlist())).toMatchObject({
        HOT_UPDATER_SANDBOX_URL_SCHEME: "new-preview",
        CFBundleURLTypes: [
          { CFBundleURLSchemes: ["myapp"] },
          named(["new-preview"]),
        ],
      });
    });

    it.each([
      ["the same scheme", "old-preview"],
      ["a changed scheme", "new-preview"],
    ])("re-patches with %s, and records it", async (_, urlScheme) => {
      await patchedPlist([named(["old-preview"])]);
      await patch(urlScheme);

      expect(read(appPlist())).toMatchObject({
        HOT_UPDATER_SANDBOX_URL_SCHEME: urlScheme,
        CFBundleURLTypes: [
          { CFBundleURLSchemes: ["myapp"] },
          named([urlScheme]),
        ],
      });
    });

    it("records the scheme of a first patch, and takes its own on the next", async () => {
      await patch("old-preview");
      expect(read(appPlist()).HOT_UPDATER_SANDBOX_URL_SCHEME).toBe(
        "old-preview",
      );
      await patch("old-preview");
      expect(read(appPlist()).CFBundleURLTypes).toEqual([
        { CFBundleURLSchemes: ["myapp"] },
        named(["old-preview"]),
      ]);
    });
  });

  it.each([
    ["holds the sandbox's scheme", ["acme-preview", "app-login"]],
    ["holds another scheme", ["app-login"]],
  ])(
    "refuses an app whose own URL type of the sandbox's name %s, and patches nothing",
    async (_, schemes) => {
      const appPlist = path.join(app, "Info.plist");
      await writePlist(appPlist, {
        CFBundleIdentifier: "com.example.App",
        CFBundleURLTypes: [
          {
            CFBundleURLName: "hot-updater-sandbox",
            CFBundleURLSchemes: schemes,
          },
        ],
      });
      const before = await fs.readFile(appPlist);
      const message =
        "The app has a URL type named hot-updater-sandbox, the name a sandbox build registers its URL scheme under.\nRename the app's URL type.";

      await expect(
        patchSandboxArchive({
          archivePath: archive,
          appPath: app,
          schemeConfig: { ...scheme, sandboxUrlScheme: "acme-preview" },
        }),
      ).rejects.toMatchObject({ message, hint: message });
      expect(await fs.readFile(appPlist)).toEqual(before);
    },
  );

  it.each(["myapp", "MyApp"])(
    "refuses a URL scheme the app registers itself, as %s, and patches nothing",
    async (urlScheme) => {
      const appPlist = path.join(app, "Info.plist");
      const before = await fs.readFile(appPlist);
      const message = `The sandbox scheme release registers URL scheme ${urlScheme}, which the app registers itself.\nSet sandbox.urlScheme to a scheme the app doesn't register.`;

      await expect(
        patchSandboxArchive({
          archivePath: archive,
          appPath: app,
          schemeConfig: { ...scheme, sandboxUrlScheme: urlScheme },
        }),
      ).rejects.toMatchObject({ message, hint: message });
      expect(await fs.readFile(appPlist)).toEqual(before);
    },
  );

  it("refuses an app Xcode built with another ID than bundleIdentifier, and patches nothing", async () => {
    const appPlist = path.join(app, "Info.plist");
    const before = await fs.readFile(appPlist);
    const message =
      "The sandbox scheme release sets bundleIdentifier com.example.App.sandbox, but Xcode built com.example.App.\nSet bundleIdentifier to the ID its configuration builds.";

    await expect(
      patchSandboxArchive({
        archivePath: archive,
        appPath: app,
        schemeConfig: {
          hotUpdaterSchemeName: "release",
          bundleIdentifier: "com.example.App.sandbox",
        },
      }),
    ).rejects.toMatchObject({ message, hint: message });
    expect(await fs.readFile(appPlist)).toEqual(before);

    await expect(
      patchSandboxSimulatorApp(app, {
        hotUpdaterSchemeName: "release",
        bundleIdentifier: "com.example.App.sandbox",
      }),
    ).rejects.toMatchObject({ message });
  });

  it("raises a closed version in the app, its extensions and the archive, with the next build number", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
      plan: {
        updateStrategy: "fingerprint",
        train: { highestClosedVersion: "1.6.2", highestBuildNumber: 68 },
      },
    });

    for (const plist of [app, appex]) {
      expect(read(path.join(plist, "Info.plist"))).toMatchObject({
        CFBundleShortVersionString: "1.6.3",
        CFBundleVersion: "69",
      });
    }
    expect(read(path.join(archive, "Info.plist"))).toMatchObject({
      ApplicationProperties: {
        CFBundleShortVersionString: "1.6.3",
        CFBundleVersion: "69",
      },
    });
  });

  it("keeps an open version, and refuses a closed one under appVersion", async () => {
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
      plan: {
        updateStrategy: "fingerprint",
        train: { highestClosedVersion: "1.6.1", highestBuildNumber: 2 },
      },
    });
    expect(read(path.join(app, "Info.plist"))).toMatchObject({
      CFBundleShortVersionString: "1.6.2",
      CFBundleVersion: "5",
    });

    await expect(
      patchSandboxArchive({
        archivePath: archive,
        appPath: app,
        schemeConfig: scheme,
        plan: {
          updateStrategy: "appVersion",
          train: { highestClosedVersion: "1.6.2", highestBuildNumber: 2 },
        },
      }),
    ).rejects.toThrow("Raise the app version.");
  });

  it("decides a closed train under appVersion by the version the archive holds, not the project's", async () => {
    const plan = {
      updateStrategy: "appVersion",
      train: { highestClosedVersion: "1.0.0", highestBuildNumber: null },
    } as const;
    // An xcconfig built 1.1.0 over a project that declares the closed 1.0.0.
    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      CFBundleShortVersionString: "1.1.0",
    });
    await patchSandboxArchive({
      archivePath: archive,
      appPath: app,
      schemeConfig: scheme,
      plan,
    });
    expect(read(path.join(app, "Info.plist"))).toMatchObject({
      CFBundleShortVersionString: "1.1.0",
    });

    await writePlist(path.join(app, "Info.plist"), {
      CFBundleIdentifier: "com.example.App",
      CFBundleShortVersionString: "1.0.0",
    });
    await expect(
      patchSandboxArchive({
        archivePath: archive,
        appPath: app,
        schemeConfig: scheme,
        plan,
      }),
    ).rejects.toThrow(
      "App Store Connect closed version 1.0.0, so TestFlight refuses 1.0.0.\nRaise the app version.",
    );
  });

  it("signs a patched simulator app again, so its signature verifies", async () => {
    const simulatorApp = path.join(root, "Sim.app");
    await fs.mkdir(simulatorApp);
    // An executable the signature covers: a copy of a system binary.
    await fs.copyFile("/usr/bin/true", path.join(simulatorApp, "Sim"));
    await writePlist(path.join(simulatorApp, "Info.plist"), {
      CFBundleExecutable: "Sim",
      CFBundleIdentifier: "com.example.App",
    });
    execFileSync("codesign", ["--force", "--sign", "-", simulatorApp]);

    await patchSandboxSimulatorApp(simulatorApp, scheme);

    const simulatorInfo = read(path.join(simulatorApp, "Info.plist"));
    expect(simulatorInfo).toMatchObject({
      HOT_UPDATER_SANDBOX: true,
      CFBundleURLTypes: [SANDBOX_URL_TYPE],
    });
    // No channel of its own: the app reports the one it was built with.
    expect(simulatorInfo).not.toHaveProperty("HOT_UPDATER_CHANNEL");
    execFileSync("codesign", ["--verify", "--deep", "--strict", simulatorApp]);
  });
});
