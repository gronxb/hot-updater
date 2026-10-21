import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  apkInstallCommand,
  nativeBuildFileName,
  simulatorInstallCommand,
} from "./native-builds";

const build = (artifact_storage_uri: string) =>
  ({ artifact_storage_uri }) as NativeBuildRow;

describe("nativeBuildFileName", () => {
  it("takes the last segment of a storage URI", () => {
    expect(
      nativeBuildFileName(
        build("r2://bucket/native-builds/android/019a/app-release.apk"),
      ),
    ).toBe("app-release.apk");
  });

  it("leaves a public URL's query and fragment out", () => {
    expect(
      nativeBuildFileName(
        build("https://cdn.example.com/builds/App.app.zip?version=2#top"),
      ),
    ).toBe("App.app.zip");
    expect(
      simulatorInstallCommand(
        build("https://cdn.example.com/builds/App.app.zip?version=2"),
      ),
    ).toBe("unzip -o App.app.zip && xcrun simctl install booted App.app");
  });

  it("decodes an encoded segment", () => {
    expect(nativeBuildFileName(build("s3://bucket/builds/My%20App.apk"))).toBe(
      "My App.apk",
    );
  });

  it("quotes a name a shell would expand in the install commands", () => {
    const named = build("s3://bucket/builds/%24(touch%20x).app.zip");
    expect(simulatorInstallCommand(named)).toBe(
      "unzip -o '$(touch x).app.zip' && xcrun simctl install booted '$(touch x).app'",
    );
    expect(apkInstallCommand(build("s3://bucket/builds/%60id%60.apk"))).toBe(
      "adb install -r '`id`.apk'",
    );
  });
});
