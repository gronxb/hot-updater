import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  apkInstallCommand,
  nativeBuildFileName,
  nativeBuildSignedDownloadUrl,
  simulatorInstallCommand,
} from "./native-builds";

const build = (artifact_storage_uri: string, id = "019a") =>
  ({ id, artifact_storage_uri }) as NativeBuildRow;

describe("nativeBuildSignedDownloadUrl", () => {
  it("stays on the page's address, under the console's own path", () => {
    for (const [origin, base] of [
      ["https://console.example.com", ""],
      ["https://example.com", "/console"],
    ] as const) {
      expect(
        nativeBuildSignedDownloadUrl(
          { origin, pathname: `${base}/native-builds/b1` },
          "b1",
          "1798761600.a_b-c",
        ),
      ).toBe(
        `${origin}${base}/api/native-builds/b1/download?t=1798761600.a_b-c`,
      );
    }
  });
});

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
  });

  it("decodes an encoded segment", () => {
    expect(nativeBuildFileName(build("s3://bucket/builds/My%20App.apk"))).toBe(
      "My App.apk",
    );
  });

  it("quotes a name a shell would expand in the install commands", () => {
    expect(simulatorInstallCommand(build("r2://b/App.app.zip", "$(id)"))).toBe(
      "npx hot-updater native-build install '$(id)'",
    );
    expect(apkInstallCommand(build("s3://bucket/builds/%60id%60.apk"))).toBe(
      "adb install -r '`id`.apk'",
    );
  });
});
