import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mergeManifestTask,
  readMergedManifest,
  resolveSandboxLauncher,
  sandboxManifestOverlay,
} from "./sandboxManifest";

const LAUNCHER_FILTER = `<intent-filter>
  <action android:name="android.intent.action.MAIN" />
  <category android:name="android.intent.category.LAUNCHER" />
</intent-filter>`;

const merged = (components: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
  <application android:label="@string/app_name">
    ${components}
  </application>
</manifest>`;

const activity = (attributes = "", children = LAUNCHER_FILTER) =>
  `<activity android:name="com.example.app.MainActivity" ${attributes}>${children}</activity>`;

describe("resolveSandboxLauncher", () => {
  it("finds an activity's launcher entry, and keeps a singleTask host's as it is", () => {
    expect(
      resolveSandboxLauncher(
        merged(activity('android:launchMode="singleTask"')),
      ),
    ).toEqual({
      kind: "activity",
      name: "com.example.app.MainActivity",
      filter: {
        attributes: {},
        actions: [{ "android:name": "android.intent.action.MAIN" }],
        categories: [{ "android:name": "android.intent.category.LAUNCHER" }],
        data: [],
      },
    });
  });

  it("takes a launcher with an extra category whole, so the merger can match it", () => {
    const { filter } = resolveSandboxLauncher(
      merged(
        activity(
          "",
          `<intent-filter android:priority="1">
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
            <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
          </intent-filter>`,
        ),
      ),
    );
    expect(filter.categories).toHaveLength(2);
    expect(filter.attributes).toEqual({ "android:priority": "1" });
  });

  it("takes an alias's label, icon and shortcuts, and leaves its target alone", () => {
    expect(
      resolveSandboxLauncher(
        merged(`${activity("", "")}
        <activity-alias android:name="com.example.app.Launcher" android:targetActivity="com.example.app.MainActivity" android:label="@string/alias" android:icon="@mipmap/alias" android:roundIcon="@mipmap/alias_round">
          ${LAUNCHER_FILTER}
          <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />
        </activity-alias>`),
      ),
    ).toMatchObject({
      kind: "activity-alias",
      name: "com.example.app.Launcher",
      targetActivity: "com.example.app.MainActivity",
      label: "@string/alias",
      icon: "@mipmap/alias",
      roundIcon: "@mipmap/alias_round",
      shortcuts: "@xml/shortcuts",
    });
  });

  it.each([
    [
      "no launcher",
      merged(activity("", "")),
      "A sandbox build needs a launcher, and this variant's manifest has none.\nAdd a MAIN + LAUNCHER intent filter to an activity.",
    ],
    [
      "two launchers",
      merged(`${activity()}
        <activity-alias android:name="com.example.app.Launcher" android:targetActivity="com.example.app.MainActivity">${LAUNCHER_FILTER}</activity-alias>`),
      "A sandbox build needs one launcher, and this variant has 2: com.example.app.MainActivity, com.example.app.Launcher.\nKeep one for this build variant.",
    ],
    [
      "two launcher filters on one activity",
      merged(activity("", LAUNCHER_FILTER + LAUNCHER_FILTER)),
      "The launcher com.example.app.MainActivity has 2 MAIN + LAUNCHER filters, and a sandbox build can move one.\nKeep one for this build variant.",
    ],
    [
      "a disabled launcher",
      merged(activity('android:enabled="false"')),
      "The launcher com.example.app.MainActivity is disabled in the manifest, and a sandbox build can't tell when it would open.\nEnable it for this build variant.",
    ],
    [
      "singleInstance",
      merged(activity('android:launchMode="singleInstance"')),
      "Sandbox builds don't support launchMode singleInstance on the launcher com.example.app.MainActivity.\nUse singleTask or the default launch mode.",
    ],
    [
      "a task affinity",
      merged(activity('android:taskAffinity="com.other"')),
      "Sandbox builds don't support taskAffinity on the launcher com.example.app.MainActivity.\nRemove it from this build variant.",
    ],
    [
      "a document launch mode",
      merged(activity('android:documentLaunchMode="always"')),
      "Sandbox builds don't support documentLaunchMode always on the launcher com.example.app.MainActivity.\nRemove it from this build variant.",
    ],
    [
      "an alias whose target has a task affinity",
      merged(`${activity('android:taskAffinity="com.other"', "")}
        <activity-alias android:name="com.example.app.Launcher" android:targetActivity="com.example.app.MainActivity">${LAUNCHER_FILTER}</activity-alias>`),
      "Sandbox builds don't support taskAffinity on the launcher com.example.app.Launcher.\nRemove it from this build variant.",
    ],
    [
      "an alias with no target",
      merged(
        `<activity-alias android:name="com.example.app.Launcher" android:targetActivity="com.example.app.Gone">${LAUNCHER_FILTER}</activity-alias>`,
      ),
      "The launcher com.example.app.Launcher targets com.example.app.Gone, which this variant's manifest doesn't declare.\nFix its android:targetActivity.",
    ],
  ])("refuses %s, saying what to do", (_, manifest, message) => {
    expect(() => resolveSandboxLauncher(manifest)).toThrow(message);
  });
});

describe("sandboxManifestOverlay", () => {
  const overlayOf = (components: string) =>
    sandboxManifestOverlay({
      channel: "sandbox-release",
      appId: "com.Example.app",
      launcher: resolveSandboxLauncher(merged(components)),
    });

  it("replaces the app's channel and declares the sandbox", () => {
    const overlay = overlayOf(activity());
    expect(overlay).toContain(
      '<meta-data android:name="com.hotupdater.CHANNEL" android:value="sandbox-release" tools:replace="android:value" />',
    );
    expect(overlay).toContain(
      '<meta-data android:name="com.hotupdater.SANDBOX" android:value="true" />',
    );
  });

  it("allows plain http for a dev server, which a project's network security config can still refuse", () => {
    expect(overlayOf(activity())).toContain(
      '<application android:usesCleartextTraffic="true" tools:replace="android:usesCleartextTraffic">',
    );
  });

  it("runs the dev server's relaunch in the SDK's restart process, whose getters prepare no launch", () => {
    const relaunch = overlayOf(activity())
      .split("\n")
      .find((line) => line.includes("HotUpdaterSandboxRelaunchActivity"));
    expect(relaunch).toContain('android:process=":hotupdater_restart"');
    expect(relaunch).toContain('android:exported="false"');
    expect(relaunch).toContain(
      'android:theme="@android:style/Theme.NoDisplay"',
    );
  });

  it("moves the launcher to the sandbox's activity, which also takes its links", () => {
    const overlay = overlayOf(activity());
    const sandbox = overlay.slice(
      overlay.indexOf(
        '<activity android:name="com.hotupdater.HotUpdaterSandboxActivity"',
      ),
      overlay.indexOf("</activity>"),
    );
    expect(sandbox).toContain('android:exported="true"');
    // A link that arrives while it's on top goes to the same screen.
    expect(sandbox).toContain('android:launchMode="singleTop"');
    expect(sandbox).toContain('android:name="android.intent.action.MAIN"');
    expect(sandbox).toContain('android:scheme="hu-sandbox-com-example-app"');
    expect(sandbox).toContain(
      '<meta-data android:name="com.hotupdater.sandbox.HOST_ACTIVITY" android:value="com.example.app.MainActivity" />',
    );
    const host = overlay.slice(
      overlay.indexOf('<activity android:name="com.example.app.MainActivity"'),
    );
    expect(host).toContain('<intent-filter tools:node="remove">');
    expect(host).toContain('android:name="android.intent.category.LAUNCHER"');
    // The host's other filters, and so its own links, aren't named.
    expect(host).not.toContain("android.intent.action.VIEW");
  });

  it("removes a filter with an extra category by its whole content, and keeps the category", () => {
    const overlay = overlayOf(
      activity(
        "",
        `<intent-filter>
          <action android:name="android.intent.action.MAIN" />
          <category android:name="android.intent.category.LAUNCHER" />
          <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
        </intent-filter>`,
      ),
    );
    expect(
      overlay.match(/android\.intent\.category\.LEANBACK_LAUNCHER/gu),
    ).toHaveLength(2);
  });

  it("gives an alias's identity to the sandbox's activity, and opens the alias", () => {
    const overlay = overlayOf(`${activity("", "")}
      <activity-alias android:name="com.example.app.Launcher" android:targetActivity="com.example.app.MainActivity" android:label="@string/alias" android:icon="@mipmap/alias">
        ${LAUNCHER_FILTER}
        <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />
      </activity-alias>`);
    expect(overlay).toContain('android:label="@string/alias"');
    expect(overlay).toContain('android:icon="@mipmap/alias"');
    expect(overlay).toContain(
      '<meta-data android:name="com.hotupdater.sandbox.HOST_ACTIVITY" android:value="com.example.app.Launcher" />',
    );
    expect(overlay).toContain(
      '<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />',
    );
    expect(overlay).toContain(
      '<activity-alias android:name="com.example.app.Launcher" android:targetActivity="com.example.app.MainActivity">',
    );
    expect(overlay).toContain(
      '<meta-data android:name="android.app.shortcuts" tools:node="remove" />',
    );
  });

  it("keeps the merger's placeholder for the provider's authority", () => {
    expect(overlayOf(activity())).toContain(
      'android:authorities="${applicationId}.hotupdater.sandbox"',
    );
  });

  it("escapes what it copies", () => {
    const overlay = sandboxManifestOverlay({
      channel: 'a"b&c',
      appId: "com.example.app",
      launcher: {
        kind: "activity",
        name: "com.example.app.Main$Activity",
        filter: {
          attributes: {},
          actions: [{ "android:name": "a<b" }],
          categories: [],
          data: [],
        },
      },
    });
    expect(overlay).toContain('android:value="a&quot;b&amp;c"');
    expect(overlay).toContain('android:name="a&lt;b"');
  });
});

describe("the merged manifest", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-manifest-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };

  it("names the merge task of a flavored variant", () => {
    expect(mergeManifestTask("Release")).toBe("processReleaseMainManifest");
    expect(mergeManifestTask("stagingRelease")).toBe(
      "processStagingReleaseMainManifest",
    );
  });

  it.each([
    "merged_manifest/stagingRelease/processStagingReleaseMainManifest/AndroidManifest.xml",
    "merged_manifest/stagingRelease/AndroidManifest.xml",
    "merged_manifests/stagingRelease/AndroidManifest.xml",
  ])("reads AGP's %s", (file) => {
    write(`app/build/intermediates/${file}`, "stagingRelease");
    write(
      "app/build/intermediates/merged_manifest/release/AndroidManifest.xml",
      "release",
    );
    expect(
      readMergedManifest({
        androidProjectPath: root,
        appModuleName: "app",
        variant: "StagingRelease",
      }),
    ).toBe("stagingRelease");
  });

  it("says so when the merge left no manifest", () => {
    expect(() =>
      readMergedManifest({
        androidProjectPath: root,
        appModuleName: "app",
        variant: "Release",
      }),
    ).toThrow("Couldn't find the merged manifest of Release");
  });
});
