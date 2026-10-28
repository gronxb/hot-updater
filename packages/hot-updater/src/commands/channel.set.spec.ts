import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cwd, log } = vi.hoisted(() => ({
  cwd: { current: "" },
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => cwd.current,
  loadConfig: vi.fn(async () => ({
    platform: {
      android: { androidManifestPaths: [MANIFEST] },
      ios: { infoPlistPaths: [INFO_PLIST] },
    },
  })),
  p: { log },
}));

// The real modules: the spec checks the files they write.
vi.mock("@/utils/expoDetection", () => import("../utils/expoDetection"));
vi.mock("@/utils/setChannel", () => import("../utils/setChannel"));
vi.mock("@/utils/loadServer", () => ({ loadServer: vi.fn() }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

import { handleSetChannel } from "./channel";

const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const INFO_PLIST = "ios/App/Info.plist";

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication">
  </application>
</manifest>
`;
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>App</string>
</dict>
</plist>
`;

const write = async (file: string, contents: string) => {
  const target = path.join(cwd.current, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
};

const expoProject = async (configFile: "app.json" | "app.config.ts") => {
  await write(
    "package.json",
    JSON.stringify({ dependencies: { expo: "^54.0.0" } }),
  );
  await write(
    configFile,
    configFile === "app.json"
      ? JSON.stringify({ expo: { name: "App" } })
      : "export default { expo: { name: 'App' } };\n",
  );
};

/** Everything the command logged, at every level, as one text. */
const output = () =>
  Object.values(log)
    .flatMap((level) => level.mock.calls.map((call) => String(call[0])))
    .join("\n");

beforeEach(async () => {
  vi.clearAllMocks();
  cwd.current = await mkdtemp(path.join(tmpdir(), "hot-updater-channel-"));
  await write("package.json", JSON.stringify({ dependencies: {} }));
});

afterEach(async () => {
  await rm(cwd.current, { force: true, recursive: true });
});

describe("handleSetChannel", () => {
  it("writes the channel into a bare project's native files and says so", async () => {
    await write(MANIFEST, manifest);
    await write(INFO_PLIST, infoPlist);

    await handleSetChannel("pr-130");

    expect(await readFile(path.join(cwd.current, MANIFEST), "utf8")).toContain(
      'android:value="pr-130"',
    );
    expect(
      await readFile(path.join(cwd.current, INFO_PLIST), "utf8"),
    ).toContain("<string>pr-130</string>");
    const successes = log.success.mock.calls.map((call) => String(call[0]));
    expect(successes).toHaveLength(2);
    expect(successes[0]).toMatch(/Set .*Android.* .*pr-130/);
    expect(successes[1]).toMatch(/Set .*iOS.* .*pr-130/);
    expect(log.warn).toHaveBeenCalledWith(
      "Rebuild native app after changing channel.",
    );
    expect(output()).not.toContain("@hot-updater/expo");
  });

  it("says which platform it wrote nothing for", async () => {
    await write(MANIFEST, manifest);

    await handleSetChannel("pr-130");

    expect(log.success).toHaveBeenCalledOnce();
    expect(String(log.success.mock.calls[0]![0])).toMatch(/Android/);
    expect(output()).toMatch(/No Info\.plist found: nothing was written for/);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("writes nothing in an Expo CNG project, says so, and shows the dynamic config's plugin option read from an environment variable", async () => {
    await expoProject("app.config.ts");

    await handleSetChannel("pr-130");

    // No success line, and no rebuild advice, for a run that wrote nothing.
    expect(log.success).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(output()).toMatch(
      /No AndroidManifest\.xml found: nothing was written for/,
    );
    expect(output()).toMatch(/No Info\.plist found: nothing was written for/);
    expect(output()).toContain(
      "take the channel from the @hot-updater/expo plugin's `channel` option in app.config.ts",
    );
    // The user's own environment variable, as the preview guide reads it,
    // never a channel to hardcode.
    expect(output()).toContain(
      'plugins: [["@hot-updater/expo", { channel: process.env.PREVIEW_CHANNEL ?? "production" }]]',
    );
    expect(output()).toContain("Then build with PREVIEW_CHANNEL=pr-130.");
    expect(output()).not.toContain('channel: "pr-130"');
    await expect(
      readFile(path.join(cwd.current, MANIFEST), "utf8"),
    ).rejects.toThrow();
  });

  it("shows the plugin option set to the channel, as JSON, for a static app.json", async () => {
    await expoProject("app.json");

    await handleSetChannel("pr-7");

    expect(output()).toContain(
      '"plugins": [["@hot-updater/expo", { "channel": "pr-7" }]]',
    );
    expect(output()).toContain("option in app.json");
    // JSON has no environment.
    expect(output()).not.toContain("process.env");
  });

  it("shows the environment form for an app.config.js too", async () => {
    await write(
      "package.json",
      JSON.stringify({ dependencies: { expo: "^54.0.0" } }),
    );
    await write("app.config.js", "module.exports = { expo: {} };\n");

    await handleSetChannel("pr-9");

    expect(output()).toContain("option in app.config.js");
    expect(output()).toContain(
      'plugins: [["@hot-updater/expo", { channel: process.env.PREVIEW_CHANNEL ?? "production" }]]',
    );
    expect(output()).toContain("Then build with PREVIEW_CHANNEL=pr-9.");
  });

  it("names the dynamic config, which overrides app.json, when a project has both", async () => {
    await expoProject("app.json");
    await write("app.config.ts", "export default ({ config }) => config;\n");

    await handleSetChannel("pr-7");

    expect(output()).toContain("option in app.config.ts");
    expect(output()).toContain(
      'plugins: [["@hot-updater/expo", { channel: process.env.PREVIEW_CHANNEL ?? "production" }]]',
    );
    expect(output()).toContain("Then build with PREVIEW_CHANNEL=pr-7.");
  });

  it("says that prebuild replaces what it wrote into an Expo project's generated files", async () => {
    await expoProject("app.config.ts");
    await write(MANIFEST, manifest);
    await write(INFO_PLIST, infoPlist);

    await handleSetChannel("pr-130");

    expect(log.success).toHaveBeenCalledTimes(2);
    expect(output()).toContain("replacing what was written here");
    expect(output()).toContain(
      'plugins: [["@hot-updater/expo", { channel: process.env.PREVIEW_CHANNEL ?? "production" }]]',
    );
  });
});
