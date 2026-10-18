import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  removeManifestMetaData,
  setManifestMetaData,
} from "./androidManifestEdit";
import { AndroidConfigParser } from "./androidParser";

const CHANNEL = "com.hotupdater.CHANNEL";
const PUBLIC_KEY = "com.hotupdater.PUBLIC_KEY";

/** A hand-written manifest: comments, multi-line attributes, a commented-out key. */
const MANIFEST = `<manifest
    xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:name=".MainApplication"
        android:label="@string/app_name"
        android:allowBackup="false">
        <!-- Explains why this value is overridden; must survive CLI writes. -->
        <meta-data
            android:name="google_analytics_adid_collection_enabled"
            android:value="false"
            tools:replace="android:value" />
        <!-- <meta-data android:name="${CHANNEL}" android:value="commented-out" /> -->
        <meta-data android:name="${PUBLIC_KEY}" android:value="old-hash" />

        <activity
            android:name=".MainActivity"
            android:exported="true">
            <meta-data android:name="${CHANNEL}" android:value="not-application-level" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
            </intent-filter>
        </activity>
        <property android:name="note" android:value="a > b" />
    </application>
</manifest>
`;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

describe("setManifestMetaData", () => {
  it("replaces an existing value and changes nothing else", () => {
    const result = setManifestMetaData(MANIFEST, PUBLIC_KEY, "new-hash");

    expect(result).toBe(
      MANIFEST.replace(
        `android:name="${PUBLIC_KEY}" android:value="old-hash"`,
        `android:name="${PUBLIC_KEY}" android:value="new-hash"`,
      ),
    );
  });

  it("appends a missing key as the last child of <application>, indented like its siblings", () => {
    const result = setManifestMetaData(MANIFEST, CHANNEL, "production");

    expect(result).toBe(
      MANIFEST.replace(
        "    </application>",
        `        <meta-data android:name="${CHANNEL}" android:value="production" />\n    </application>`,
      ),
    );
  });

  it("ignores meta-data inside comments and below <activity>", () => {
    const result = setManifestMetaData(MANIFEST, CHANNEL, "production")!;

    expect(result).toContain(
      `<!-- <meta-data android:name="${CHANNEL}" android:value="commented-out" /> -->`,
    );
    expect(result).toContain(
      `<meta-data android:name="${CHANNEL}" android:value="not-application-level" />`,
    );
  });

  it("escapes the value", () => {
    const result = setManifestMetaData(MANIFEST, PUBLIC_KEY, `a&b<c>"d"`)!;

    expect(result).toContain(`android:value="a&amp;b&lt;c&gt;&quot;d&quot;"`);
  });

  it("keeps line breaks of a PEM value as they are", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
    const result = setManifestMetaData(MANIFEST, PUBLIC_KEY, pem)!;

    expect(result).toContain(`android:value="${pem}"`);
  });

  it("adds android:value when the element has none", () => {
    const xml = MANIFEST.replace(
      `<meta-data android:name="${PUBLIC_KEY}" android:value="old-hash" />`,
      `<meta-data android:name="${PUBLIC_KEY}" />`,
    );

    expect(setManifestMetaData(xml, PUBLIC_KEY, "new-hash")).toBe(
      MANIFEST.replace("old-hash", "new-hash"),
    );
  });

  it("turns an android:resource meta-data into a value, which Android would otherwise read first", () => {
    const xml = MANIFEST.replace(
      `<meta-data android:name="${PUBLIC_KEY}" android:value="old-hash" />`,
      `<meta-data android:name="${PUBLIC_KEY}" android:resource="@string/hash" />`,
    );

    expect(setManifestMetaData(xml, PUBLIC_KEY, "new-hash")).toBe(
      MANIFEST.replace("old-hash", "new-hash"),
    );
  });

  it("drops android:resource when the element also has android:value", () => {
    const xml = MANIFEST.replace(
      `<meta-data android:name="${PUBLIC_KEY}" android:value="old-hash" />`,
      `<meta-data android:name="${PUBLIC_KEY}" android:value="old-hash"\n            android:resource="@string/hash" />`,
    );

    expect(setManifestMetaData(xml, PUBLIC_KEY, "new-hash")).toBe(
      MANIFEST.replace("old-hash", "new-hash"),
    );
  });

  it("opens a self-closing <application /> to hold the key", () => {
    const xml = [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      "  <application />",
      "</manifest>",
      "",
    ].join("\n");

    expect(setManifestMetaData(xml, CHANNEL, "production")).toBe(
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        "  <application>",
        `    <meta-data android:name="${CHANNEL}" android:value="production" />`,
        "  </application>",
        "</manifest>",
        "",
      ].join("\n"),
    );
  });

  it("follows tab indentation, CRLF line endings and the file's self-closing style", () => {
    const xml = [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      "\t<application>",
      '\t\t<meta-data android:name="other" android:value="x"/>',
      "\t</application>",
      "</manifest>",
      "",
    ].join("\r\n");

    expect(setManifestMetaData(xml, CHANNEL, "production")).toBe(
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        "\t<application>",
        '\t\t<meta-data android:name="other" android:value="x"/>',
        `\t\t<meta-data android:name="${CHANNEL}" android:value="production"/>`,
        "\t</application>",
        "</manifest>",
        "",
      ].join("\r\n"),
    );
  });

  it("returns null when there is no <application>", () => {
    const xml =
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />\n';

    expect(setManifestMetaData(xml, CHANNEL, "production")).toBeNull();
  });

  it("rejects malformed markup instead of guessing", () => {
    expect(() =>
      setManifestMetaData("<manifest><application", CHANNEL, "production"),
    ).toThrow();
  });
});

describe("removeManifestMetaData", () => {
  it("removes the element and its line, nothing else", () => {
    const result = removeManifestMetaData(MANIFEST, PUBLIC_KEY);

    expect(result).toBe(
      MANIFEST.replace(
        `        <meta-data android:name="${PUBLIC_KEY}" android:value="old-hash" />\n`,
        "",
      ),
    );
  });

  it("returns null when the key is absent at application level", () => {
    expect(removeManifestMetaData(MANIFEST, CHANNEL)).toBeNull();
  });
});

describe("AndroidConfigParser writes", () => {
  it("round-trip set, set, remove leaves the manifest byte-identical", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hot-updater-manifest-"));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, "AndroidManifest.xml");
    await writeFile(manifestPath, MANIFEST);
    const parser = new AndroidConfigParser([manifestPath]);

    await parser.set(CHANNEL, "staging");
    expect((await parser.get(CHANNEL)).value).toBe("staging");
    await parser.set(PUBLIC_KEY, "new-hash");
    expect((await parser.get(PUBLIC_KEY)).value).toBe("new-hash");

    const written = await readFile(manifestPath, "utf-8");
    expect(written).toContain(
      "<!-- Explains why this value is overridden; must survive CLI writes. -->",
    );

    await parser.remove(CHANNEL);
    await parser.set(PUBLIC_KEY, "old-hash");
    expect(await readFile(manifestPath, "utf-8")).toBe(MANIFEST);
  });
});
