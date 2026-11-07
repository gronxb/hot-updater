import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";

const { getCwd, loadConfig, loadServer } = vi.hoisted(() => ({
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd,
  loadConfig,
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const databaseHarness = createDatabaseHarness();

const infoPlist = (version: string, channel: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>HOT_UPDATER_CHANNEL</key>
  <string>${channel}</string>
</dict>
</plist>
`;

const androidManifest = (channel: string) =>
  `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <meta-data android:name="com.hotupdater.CHANNEL" android:value="${channel}" />
  </application>
</manifest>
`;

/** Every file under `dir` with a hash of its contents. */
const hashTree = async (dir: string): Promise<Record<string, string>> => {
  const entries = await fs.readdir(dir, {
    recursive: true,
    withFileTypes: true,
  });
  const tree: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    tree[path.relative(dir, file)] = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  }
  return tree;
};

let cwd: string;
// A prebuild that regenerates the native projects from another environment,
// as `expo prebuild` did in the report.
const prebuild = vi.fn(async () => {
  await fs.writeFile(
    path.join(cwd, "ios/App/Info.plist"),
    infoPlist("9.9.9", "production"),
  );
  await fs.writeFile(
    path.join(cwd, "android/app/src/main/AndroidManifest.xml"),
    androidManifest("production"),
  );
});

describe("native-build find on a native project", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    databaseHarness.reset();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "native-build-find-"));
    await fs.mkdir(path.join(cwd, "ios/App.xcodeproj"), { recursive: true });
    await fs.writeFile(path.join(cwd, "ios/App.xcodeproj/project.pbxproj"), "");
    await fs.mkdir(path.join(cwd, "ios/App"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "ios/App/Info.plist"),
      infoPlist("2.3.4", "qa"),
    );
    await fs.mkdir(path.join(cwd, "android/app/src/main"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "android/app/src/main/AndroidManifest.xml"),
      androidManifest("qa"),
    );
    await fs.writeFile(
      path.join(cwd, "android/app/build.gradle"),
      `android {\n  defaultConfig {\n    versionName "2.3.5"\n  }\n}\n`,
    );
    getCwd.mockReturnValue(cwd);
    loadConfig.mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild: { android: {}, ios: {} },
      platform: {
        ios: { infoPlistPaths: ["ios/App/Info.plist"] },
        android: {
          androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
        },
      },
      build: async () => ({ name: "bare", nativeBuild: { prebuild } }),
    });
    loadServer.mockResolvedValue(
      testServer({ database: databaseHarness.database }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it.each([
    ["ios", "2.3.4"],
    ["android", "2.3.5"],
  ] as const)(
    "reads the %s app version and channel without writing the project",
    async (platform, appVersion) => {
      const before = await hashTree(cwd);
      const { handleNativeBuildFind } = await import("./nativeBuild");

      await handleNativeBuildFind({ platform, json: true });

      expect(
        JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])),
      ).toMatchObject({ platform, channel: "qa", appVersion });
      expect(prebuild).not.toHaveBeenCalled();
      expect(await hashTree(cwd)).toEqual(before);
    },
  );

  it("keeps a product flavor's own version over what an Expo-style prebuild writes", async () => {
    // The prebuild rewrites defaultConfig's versionName and the app's
    // Info.plist; a flavor's versionName stays, and a build of it reads it.
    await fs.writeFile(
      path.join(cwd, "android/app/build.gradle"),
      `android {
  defaultConfig {
    versionName "1.0.0-stale"
  }
  productFlavors {
    staging {
      versionName "5.5.1"
    }
    production {
    }
  }
}
`,
    );
    loadConfig.mockResolvedValue({
      ...(await loadConfig()),
      nativeBuild: {
        android: {
          staging: { variant: "stagingRelease" },
          production: { variant: "productionRelease" },
        },
        ios: { release: { scheme: "App" } },
      },
      build: async () => ({
        name: "expo",
        nativeBuild: {
          prebuild,
          getNativeProjectValues: async () => ({ appVersion: "3.0.0" }),
        },
      }),
    });
    const before = await hashTree(cwd);
    const { handleNativeBuildFind } = await import("./nativeBuild");
    const find = async (platform: "ios" | "android", scheme: string) => {
      await handleNativeBuildFind({ platform, scheme, json: true });
      return JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
        .appVersion;
    };

    expect(await find("android", "staging")).toBe("5.5.1");
    expect(await find("android", "production")).toBe("3.0.0");
    // Info.plist says 2.3.4 until the prebuild writes 3.0.0.
    expect(await find("ios", "release")).toBe("3.0.0");
    expect(prebuild).not.toHaveBeenCalled();
    expect(await hashTree(cwd)).toEqual(before);
  });
});
