import { describe, expect, it } from "vitest";

import {
  parseManifestMetaData,
  parseManifestVersionCode,
  parseManifestVersionName,
  parseResourceString,
} from "./readBuiltApp";

// Output of aapt2 37.0.0 for a release build of examples/v0.85.0.
const XMLTREE = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=1
    A: http://schemas.android.com/apk/res/android:versionName(0x0101021c)="1.0-staging" (Raw: "1.0-staging")
      E: application (line=12)
          E: meta-data (line=62)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.hotupdater.FINGERPRINT_HASH" (Raw: "com.hotupdater.FINGERPRINT_HASH")
            A: http://schemas.android.com/apk/res/android:value(0x01010024)="b10a99ce" (Raw: "b10a99ce")
          E: meta-data (line=64)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.hotupdater.CHANNEL" (Raw: "com.hotupdater.CHANNEL")
            A: http://schemas.android.com/apk/res/android:value(0x01010024)="beta" (Raw: "beta")
          E: receiver (line=66)
            A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.example.Receiver" (Raw: "com.example.Receiver")`;

describe("aapt2 output", () => {
  it("reads the merged versionCode", () => {
    expect(parseManifestVersionCode(XMLTREE)).toBe(1);
    expect(
      parseManifestVersionCode(
        XMLTREE.replace(
          "versionCode(0x0101021b)=1",
          "versionCode(0x0101021b)=10042",
        ),
      ),
    ).toBe(10042);
    expect(parseManifestVersionCode("E: manifest (line=2)")).toBeNull();
  });

  it("reads the merged versionName, with its suffix", () => {
    expect(parseManifestVersionName(XMLTREE)).toBe("1.0-staging");
  });

  it("reads a versionName with an apostrophe, which badging would cut", () => {
    expect(
      parseManifestVersionName(
        XMLTREE.replace(
          '="1.0-staging" (Raw: "1.0-staging")',
          `="1.2'qa" (Raw: "1.2'qa")`,
        ),
      ),
    ).toBe("1.2'qa");
  });

  it("reads the merged channel meta-data", () => {
    expect(parseManifestMetaData(XMLTREE, "com.hotupdater.CHANNEL")).toBe(
      "beta",
    );
    expect(
      parseManifestMetaData(XMLTREE, "com.hotupdater.FINGERPRINT_HASH"),
    ).toBe("b10a99ce");
  });

  it("resolves a channel the manifest takes from a string resource", () => {
    const reference = parseManifestMetaData(
      XMLTREE.replace('="beta" (Raw: "beta")', "=@0x7f10001e"),
      "com.hotupdater.CHANNEL",
    );
    expect(reference).toBe("@0x7f10001e");

    const resources = `    resource 0x7f10001d string/app_name
      () "HotUpdaterExample"
    resource 0x7f10001e string/channel
      (ko) "베타"
      () "beta"
    resource 0x7f10001f string/other
      () "other"`;
    expect(parseResourceString(resources, reference!)).toBe("beta");
    // An .aab's proto manifest names the resource.
    expect(
      parseManifestMetaData(
        XMLTREE.replace(
          '="beta" (Raw: "beta")',
          '=@string/channel (Raw: "@string/channel")',
        ),
        "com.hotupdater.CHANNEL",
      ),
    ).toBe("@string/channel");
    expect(parseResourceString(resources, "@string/channel")).toBe("beta");
    expect(parseResourceString(resources, "@0x7f100099")).toBeUndefined();
  });

  it("reads a channel with quotes as aapt2 prints it, unescaped", () => {
    // aapt2 37.0.0's output for android:value="qa&quot;east (Raw: &quot;x".
    const xmltree = XMLTREE.replace(
      '="beta" (Raw: "beta")',
      '="qa"east (Raw: "x" (Raw: "qa"east (Raw: "x")',
    );
    expect(parseManifestMetaData(xmltree, "com.hotupdater.CHANNEL")).toBe(
      'qa"east (Raw: "x',
    );
  });

  it("reads a channel with a line break, which aapt2 indents, as unknown", () => {
    const xmltree = XMLTREE.replace(
      '="beta" (Raw: "beta")',
      '="qa\n              east" (Raw: "qa\n              east")',
    );
    expect(
      parseManifestMetaData(xmltree, "com.hotupdater.CHANNEL"),
    ).toBeUndefined();
    // aapt2 37.0.0's output for <string name="channel">a\"b\nc</string>.
    expect(
      parseResourceString(
        `    resource 0x7f10005c string/channel
      () "a"b
      c"
    resource 0x7f10005d string/other`,
        "@string/channel",
      ),
    ).toBeUndefined();
    expect(
      parseResourceString(
        `    resource 0x7f10005c string/channel
      () "a"b"`,
        "@string/channel",
      ),
    ).toBe('a"b');
  });

  it("reads no channel from a manifest without one", () => {
    expect(
      parseManifestMetaData(
        XMLTREE.replace("com.hotupdater.CHANNEL", "com.example.OTHER"),
        "com.hotupdater.CHANNEL",
      ),
    ).toBeNull();
  });
});
