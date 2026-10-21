import { describe, expect, it } from "vitest";

import {
  androidOpenLinkCommand,
  iosOpenLinkCommand,
  shellQuote,
} from "./shell";

describe("shellQuote", () => {
  it("keeps a plain word as it is", () => {
    expect(shellQuote("app-release.apk")).toBe("app-release.apk");
    expect(shellQuote("myapp://hot-updater/channel/pr-12")).toBe(
      "myapp://hot-updater/channel/pr-12",
    );
  });

  it("single-quotes anything a shell would expand or split", () => {
    expect(shellQuote("My App.apk")).toBe("'My App.apk'");
    expect(shellQuote("$(touch x).apk")).toBe("'$(touch x).apk'");
    expect(shellQuote("`id`.apk")).toBe("'`id`.apk'");
    expect(shellQuote("it's.apk")).toBe("'it'\\''s.apk'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("channel link commands", () => {
  it("opens a plain link as it is", () => {
    const link = "myapp://hot-updater/channel/pr-12";
    expect(androidOpenLinkCommand(link)).toBe(
      `adb shell am start -a android.intent.action.VIEW -d ${link}`,
    );
    expect(iosOpenLinkCommand(link)).toBe(
      `xcrun simctl openurl booted ${link}`,
    );
  });

  it("quotes a link twice for adb, whose device shell parses it again", () => {
    const link = "https://example.com/hot-updater/channel/a(b)";
    expect(androidOpenLinkCommand(link)).toBe(
      `adb shell am start -a android.intent.action.VIEW -d ''\\''${link}'\\'''`,
    );
    expect(iosOpenLinkCommand(link)).toBe(
      `xcrun simctl openurl booted '${link}'`,
    );
  });
});
