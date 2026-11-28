import { describe, expect, it } from "vitest";

import { readExpoSettings } from "./expoFingerprint";

describe("readExpoSettings", () => {
  it("reads the engine and the architecture, with per-platform overrides", () => {
    const exp = {
      jsEngine: "hermes",
      newArchEnabled: true,
      android: { jsEngine: "jsc", newArchEnabled: false },
    };

    expect(readExpoSettings(exp, "android")).toEqual({
      "expo.jsEngine": "jsc",
      "expo.newArchEnabled": "false",
    });
    expect(readExpoSettings(exp, "ios")).toEqual({
      "expo.jsEngine": "hermes",
      "expo.newArchEnabled": "true",
    });
  });

  it("counts Hermes when the app config leaves the engine out, as Expo builds", () => {
    expect(readExpoSettings({}, "ios")).toEqual(
      readExpoSettings({ jsEngine: "hermes" }, "ios"),
    );
  });

  it("reads nothing else from the app config", () => {
    expect(
      readExpoSettings(
        {
          version: "9.9.9",
          ios: { buildNumber: "42" },
          plugins: [["expo-build-properties", { ios: {} }]],
        } as never,
        "ios",
      ),
    ).toEqual({ "expo.jsEngine": "hermes" });
  });
});
