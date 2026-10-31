import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createStorageAdapter,
  type NativeBuildRegistration,
  type NativeBuildRow,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveNativeBuildDownloadUrl } from "../utils/native/downloadNativeBuild";
import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";

const {
  installOnAndroidDevice,
  installOnSimulator,
  listAdbDevices,
  listSimulators,
  loadConfig,
  loadServer,
  log,
} = vi.hoisted(() => ({
  installOnAndroidDevice: vi.fn(),
  installOnSimulator: vi.fn(),
  listAdbDevices: vi.fn(),
  listSimulators: vi.fn(),
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
  p: { log },
}));
// What reaches xcrun and adb has its own specs; selecting a device stays real.
vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/android-helper")>()),
  installOnAndroidDevice,
  listAdbDevices,
}));
vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  // ditto is macOS's; the artifact is a zip this reads back.
  extractSimulatorApp: vi.fn(async () => "/extracted/App.app"),
  installOnSimulator,
  listSimulators,
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabaseHarness();

// Built by __fixtures__/generate.sh in @hot-updater/protocol with aapt2, so
// the app ID comes from what a real toolchain wrote, not from a writer here.
const FIXTURES = path.resolve(
  __dirname,
  "../../../protocol/src/nativeArtifact/__fixtures__",
);
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

const zip = async (entries: Record<string, Uint8Array>) => {
  const archive = new JSZip();
  for (const [name, bytes] of Object.entries(entries))
    archive.file(name, bytes);
  return archive.generateAsync({ type: "uint8array" });
};

const BUILD_ID = "01900000-0000-7000-8000-00000000b001";
const MIN_BUNDLE_ID = "01900000-0000-7000-8000-00000000a001";

const apk = (manifest = "release.axml") =>
  zip({
    "AndroidManifest.xml": fixture(manifest),
    "classes.dex": fixture("classes.dex"),
  });
const simulatorApp = () =>
  zip({
    "App.app/Info.plist": fixture("Info.plist"),
    "App.app/App": fixture("App"),
  });

const register = (
  kind: NativeBuildRegistration["artifact"]["kind"],
  byteSize: number,
  fileName: string,
) =>
  databaseHarness.core.registerNativeBuild({
    id: BUILD_ID,
    minBundleId: MIN_BUNDLE_ID,
    platform: kind === "app" || kind === "ipa" ? "ios" : "android",
    channel: "pr-1",
    fingerprintHash: null,
    appVersion: "1.2.0",
    gitCommitHash: null,
    buildKey: null,
    artifact: {
      kind,
      storageUri: `fake://native-builds/${BUILD_ID}/${fileName}`,
      byteSize,
    },
    embeddedBundle: {
      manifestStorageUri: `fake://bundles/${MIN_BUNDLE_ID}/manifest.json`,
      manifestFileHash: "manifest-hash",
      assetBaseStorageUri: "fake://assets",
    },
  } as NativeBuildRegistration);

/** A storage with `get` alone: no download URL, as some providers have. */
const useStorage = (
  bytes: Uint8Array | null,
  extra?: Partial<StorageAdapter>,
) => {
  const get = vi.fn(async () => ({
    response: bytes === null ? null : new Response(Buffer.from(bytes)),
  }));
  loadServer.mockResolvedValue(
    testServer({
      database: databaseHarness.database,
      storage: createStorageAdapter({
        name: "fake",
        protocol: "fake",
        get,
        ...extra,
      }),
    }),
  );
  return get;
};

const output = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

const errorMessage = () =>
  (vi.mocked(console.error).mock.calls[0]?.[0] as string | undefined) ??
  (log.error.mock.calls[0]?.[0] as string | undefined);

describe("native-build download and install", () => {
  let directory: string;
  const serial = process.env["ANDROID_SERIAL"];

  beforeEach(async () => {
    vi.clearAllMocks();
    databaseHarness.reset();
    delete process.env["ANDROID_SERIAL"];
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "download-"));
    loadConfig.mockResolvedValue({});
    listSimulators.mockResolvedValue([
      { udid: "SIM-A", name: "iPhone A", state: "Booted" },
    ]);
    listAdbDevices.mockResolvedValue([
      { serial: "emulator-5560", state: "device" },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (serial !== undefined) process.env["ANDROID_SERIAL"] = serial;
    await fs.promises.rm(directory, { force: true, recursive: true });
  });

  describe("download", () => {
    it("writes the artifact through storage.get, on a storage with no download URL", async () => {
      const bytes = await apk();
      await register("apk", bytes.byteLength, "app-release.apk");
      const get = useStorage(bytes);
      const { handleNativeBuildDownload } = await import("./nativeBuild");
      const file = path.join(directory, "nested/out.apk");

      await handleNativeBuildDownload(BUILD_ID, { json: true, output: file });

      expect(get).toHaveBeenCalledWith({
        storageUri: `fake://native-builds/${BUILD_ID}/app-release.apk`,
      });
      expect(output()).toEqual({
        id: BUILD_ID,
        platform: "android",
        kind: "apk",
        path: file,
        byteSize: bytes.byteLength,
      });
      expect(Buffer.compare(fs.readFileSync(file), bytes)).toBe(0);
    });

    it("writes into a directory under the artifact's own name, which holds no path", async () => {
      const bytes = await apk();
      await register("apk", bytes.byteLength, "..%2F..%2Fevil.apk");
      useStorage(bytes);
      const { handleNativeBuildDownload } = await import("./nativeBuild");

      await handleNativeBuildDownload(BUILD_ID, {
        json: true,
        output: directory,
      });

      expect(output().path).toBe(path.join(directory, "evil.apk"));
      expect(fs.readdirSync(directory)).toEqual(["evil.apk"]);
    });

    it("leaves nothing behind when the download comes up short", async () => {
      const bytes = await apk();
      await register("apk", bytes.byteLength + 1, "app-release.apk");
      useStorage(bytes);
      const { handleNativeBuildDownload } = await import("./nativeBuild");
      const file = path.join(directory, "out.apk");

      await expect(
        handleNativeBuildDownload(BUILD_ID, { json: true, output: file }),
      ).rejects.toThrow("process.exit");

      expect(errorMessage()).toContain(`is ${bytes.byteLength} bytes`);
      expect(fs.readdirSync(directory)).toEqual([]);
    });

    it("says the artifact is gone, with one next step", async () => {
      await register("apk", 1, "app-release.apk");
      useStorage(null);
      const { handleNativeBuildDownload } = await import("./nativeBuild");

      await expect(
        handleNativeBuildDownload(BUILD_ID, {
          output: path.join(directory, "out.apk"),
        }),
      ).rejects.toThrow("process.exit");

      expect(errorMessage()).toBe(
        `The artifact isn't in storage: fake://native-builds/${BUILD_ID}/app-release.apk\nDelete the build: npx hot-updater native-build delete ${BUILD_ID}`,
      );
    });

    it("keeps stdout empty under --json when no build has the ID", async () => {
      useStorage(null);
      const { handleNativeBuildDownload } = await import("./nativeBuild");

      await expect(
        handleNativeBuildDownload(BUILD_ID, { json: true }),
      ).rejects.toThrow("process.exit");

      expect(console.log).not.toHaveBeenCalled();
      expect(errorMessage()).toContain(`No native build ${BUILD_ID}.`);
    });
  });

  describe("the URL find --json gives", () => {
    const row = {
      id: BUILD_ID,
      artifact_kind: "apk",
      artifact_storage_uri: `fake://native-builds/${BUILD_ID}/app.apk`,
    } as NativeBuildRow;
    const adapter = (getDownloadUrl?: StorageAdapter["getDownloadUrl"]) =>
      createStorageAdapter({
        name: "fake",
        protocol: "fake",
        ...(getDownloadUrl === undefined ? {} : { getDownloadUrl }),
      });

    it("is the storage's, when a script can fetch it", async () => {
      const url = "https://cdn.example.com/signed";

      await expect(
        resolveNativeBuildDownloadUrl(
          adapter(async () => ({ url })),
          row,
        ),
      ).resolves.toBe(url);
    });

    it("is null when only the storage can read it, or it gives none", async () => {
      await expect(
        resolveNativeBuildDownloadUrl(
          adapter(async () => ({ url: "fake://only-the-storage" })),
          row,
        ),
      ).resolves.toBeNull();
      await expect(
        resolveNativeBuildDownloadUrl(adapter(), row),
      ).resolves.toBeNull();
    });

    it("is null when the storage can't sign, and stderr says why", async () => {
      await expect(
        resolveNativeBuildDownloadUrl(
          adapter(async () => {
            throw new Error("no signing credential");
          }),
          row,
        ),
      ).resolves.toBeNull();

      expect(errorMessage()).toBe(
        "fake gave no download URL: no signing credential",
      );
    });

    it("is a public artifact's own URL, which no storage owns", async () => {
      const uri = "https://cdn.example.com/app.apk";

      await expect(
        resolveNativeBuildDownloadUrl(adapter(), {
          ...row,
          artifact_storage_uri: uri,
        }),
      ).resolves.toBe(uri);
    });
  });

  describe("install", () => {
    it("installs a simulator build on the booted simulator and opens the app the artifact names", async () => {
      const bytes = await simulatorApp();
      await register("app", bytes.byteLength, "App.app.zip");
      useStorage(bytes);
      const { handleNativeBuildInstall } = await import("./nativeBuild");

      await handleNativeBuildInstall(BUILD_ID, { json: true });

      expect(installOnSimulator).toHaveBeenCalledWith({
        udid: "SIM-A",
        appPath: "/extracted/App.app",
        appId: "com.example.app",
      });
      expect(output()).toEqual({
        id: BUILD_ID,
        platform: "ios",
        device: "SIM-A",
        appId: "com.example.app",
      });
    });

    it("installs an APK on the connected device", async () => {
      const bytes = await apk();
      await register("apk", bytes.byteLength, "app-release.apk");
      useStorage(bytes);
      const { handleNativeBuildInstall } = await import("./nativeBuild");

      await handleNativeBuildInstall(BUILD_ID, {});

      expect(installOnAndroidDevice).toHaveBeenCalledWith({
        serial: "emulator-5560",
        apkPath: expect.stringMatching(/artifact\.apk$/u),
        appId: "com.example.app",
      });
      expect(log.success.mock.calls[0]?.[0]).toContain(
        "Native build installed and opened",
      );
    });

    it("opens a sandbox APK by its own .sandbox application ID, the same way", async () => {
      const bytes = await apk("sandbox.axml");
      await register("apk", bytes.byteLength, "app-sandbox.apk");
      useStorage(bytes);
      const { handleNativeBuildInstall } = await import("./nativeBuild");

      await handleNativeBuildInstall(BUILD_ID, { device: "emulator-5560" });

      expect(installOnAndroidDevice).toHaveBeenCalledWith(
        expect.objectContaining({ appId: "com.example.app.sandbox" }),
      );
    });

    it("removes the download once installed", async () => {
      const bytes = await apk();
      await register("apk", bytes.byteLength, "app-release.apk");
      useStorage(bytes);
      const { handleNativeBuildInstall } = await import("./nativeBuild");
      let apkPath = "";
      installOnAndroidDevice.mockImplementation(async (input) => {
        apkPath = input.apkPath;
        expect(fs.existsSync(apkPath)).toBe(true);
      });

      await handleNativeBuildInstall(BUILD_ID, { json: true });

      expect(fs.existsSync(path.dirname(apkPath))).toBe(false);
    });

    it("downloads nothing when no device is there, and gives one next step", async () => {
      await register("app", 1, "App.app.zip");
      const get = useStorage(new Uint8Array(1));
      listSimulators.mockResolvedValue([]);
      const { handleNativeBuildInstall } = await import("./nativeBuild");

      await expect(handleNativeBuildInstall(BUILD_ID, {})).rejects.toThrow(
        "process.exit",
      );

      expect(errorMessage()).toBe(
        "No iOS Simulator is booted.\nBoot one: open -a Simulator",
      );
      expect(get).not.toHaveBeenCalled();
    });

    it("refuses a device flag of the other platform", async () => {
      await register("apk", 1, "app-release.apk");
      const get = useStorage(new Uint8Array(1));
      const { handleNativeBuildInstall } = await import("./nativeBuild");

      await expect(
        handleNativeBuildInstall(BUILD_ID, { simulator: "SIM-A" }),
      ).rejects.toThrow("process.exit");

      expect(errorMessage()).toBe(
        "This is an Android build, and --simulator picks an iOS Simulator.\nPick a device with --device <serial>.",
      );
      expect(get).not.toHaveBeenCalled();
    });

    it.each([
      ["ipa", "App.ipa", "For testers: npx hot-updater testflight"],
      ["aab", "app.aab", "For testers: npx hot-updater google-play upload"],
    ] as const)(
      "points an .%s at what installs it, and downloads nothing",
      async (kind, fileName, nextStep) => {
        await register(kind, 1, fileName);
        const get = useStorage(new Uint8Array(1));
        const { handleNativeBuildInstall } = await import("./nativeBuild");

        await expect(handleNativeBuildInstall(BUILD_ID, {})).rejects.toThrow(
          "process.exit",
        );

        expect(errorMessage()).toContain(nextStep);
        expect(get).not.toHaveBeenCalled();
      },
    );
  });
});
