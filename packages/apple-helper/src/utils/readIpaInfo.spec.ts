import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readIpaInfo } from "./readIpaInfo";

vi.mock("execa", () => ({ execa: vi.fn() }));

const INFO_PLIST_VALUES: Record<string, string> = {
  CFBundleIdentifier: "com.example.app\n",
  CFBundleShortVersionString: "1.2.0\n",
  CFBundleVersion: "42\n",
};

describe("readIpaInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the app's Info.plist, not a framework's", async () => {
    vi.mocked(execa).mockImplementation((async (
      command: string,
      args: string[],
    ) => {
      if (command === "unzip" && args[0] === "-Z1") {
        return {
          stdout: [
            "Payload/",
            "Payload/My App.app/",
            "Payload/My App.app/Frameworks/hermes.framework/Info.plist",
            "Payload/My App.app/PlugIns/Widget.appex/Info.plist",
            "Payload/My App.app/Info.plist",
          ].join("\n"),
        };
      }
      if (command === "plutil") {
        return { stdout: INFO_PLIST_VALUES[args[1]!] ?? "", exitCode: 0 };
      }
      return { stdout: "" };
    }) as never);

    await expect(readIpaInfo("/out/App.ipa")).resolves.toEqual({
      bundleId: "com.example.app",
      shortVersion: "1.2.0",
      bundleVersion: "42",
    });
    expect(execa).toHaveBeenCalledWith(
      "unzip",
      ["-p", "/out/App.ipa", "Payload/My App.app/Info.plist"],
      expect.objectContaining({ stdout: expect.any(Object) }),
    );
  });

  it("refuses an .ipa without an app", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: "Payload/\n",
    } as never);

    await expect(readIpaInfo("/out/App.ipa")).rejects.toThrow(
      "App.ipa has no Payload/<App>.app/Info.plist.",
    );
  });

  it("refuses an Info.plist without a build number", async () => {
    vi.mocked(execa).mockImplementation((async (
      command: string,
      args: string[],
    ) => {
      if (command === "unzip" && args[0] === "-Z1") {
        return { stdout: "Payload/App.app/Info.plist" };
      }
      if (command === "plutil") {
        return args[1] === "CFBundleVersion"
          ? { stdout: "", exitCode: 1 }
          : { stdout: INFO_PLIST_VALUES[args[1]!], exitCode: 0 };
      }
      return { stdout: "" };
    }) as never);

    await expect(readIpaInfo("/out/App.ipa")).rejects.toThrow(
      "App.ipa's Info.plist has no CFBundleVersion.",
    );
  });
});
