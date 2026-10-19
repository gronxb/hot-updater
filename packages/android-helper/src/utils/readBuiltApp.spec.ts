import { describe, expect, it } from "vitest";

import {
  parseBadgingVersionName,
  parseManifestMetaData,
  parseResourceString,
} from "./readBuiltApp";

// Output of aapt2 37.0.0 for a release build of examples/v0.85.0.
const BADGING = `package: name='com.hotupdaterexample' versionCode='1' versionName='1.0-staging' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'
minSdkVersion:'24'`;

const XMLTREE = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
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
  it("reads the merged versionName, with its suffix", () => {
    expect(parseBadgingVersionName(BADGING)).toBe("1.0-staging");
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
    expect(parseResourceString(resources, "@0x7f100099")).toBeNull();
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
