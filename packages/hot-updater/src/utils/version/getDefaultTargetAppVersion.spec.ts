import fs from "fs/promises";
import path from "path";

import { XcodeProject } from "@bacons/xcode";
import { getCwd } from "@hot-updater/cli-tools";
import fg from "fast-glob";
import plist from "plist";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { getDefaultTargetAppVersion } from "./getDefaultTargetAppVersion";

vi.mock("fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    default: { ...actual, access: vi.fn(), readFile: vi.fn() },
    access: vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return {
    ...actual,
    default: { ...actual, join: vi.fn() },
    join: vi.fn(),
  };
});

vi.mock("@bacons/xcode");
vi.mock("@hot-updater/cli-tools", () => ({ getCwd: vi.fn() }));
vi.mock("fast-glob", () => ({ default: { globSync: vi.fn() } }));
vi.mock("find-up-simple");
vi.mock("plist");

describe("getDefaultTargetAppVersion", () => {
  const mockGetCwd = getCwd as Mock;
  const mockGlobbySync = fg.globSync as Mock;
  const mockXcodeProjectOpen = XcodeProject.open as Mock;
  const mockPathJoin = path.join as Mock;
  const mockFsReadFile = fs.readFile as Mock;
  const mockFsAccess = fs.access as Mock;
  const mockPlistParse = plist.parse as Mock;

  const plistPath = "/mock/project/root/ios/HotUpdaterExample/Info.plist";
  const xcodeprojPath = "HotUpdaterExample.xcodeproj/project.pbxproj";

  const mockFileExist = (paths: string[]) => {
    mockFsAccess.mockImplementation(async (target: string) => {
      if (paths.includes(target)) return;
      throw new Error();
    });
  };

  const mockMarketingVersion = (marketingVersion: string) => {
    mockXcodeProjectOpen.mockReturnValue({
      toJSON: () => ({
        objects: {
          "13B07F941A680F5B00A75B9A": {
            isa: "XCBuildConfiguration",
            name: "Release",
            buildSettings: { MARKETING_VERSION: marketingVersion },
          },
        },
      }),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsAccess.mockReset();

    mockGetCwd.mockReturnValue("/mock/project/root");
    mockPathJoin.mockImplementation((...args) => args.join("/"));
    mockGlobbySync.mockReturnValue([xcodeprojPath]);
  });

  it("falls back to xcodeproj when Info.plist holds an unresolved $(MARKETING_VERSION)", async () => {
    mockFileExist([plistPath]);
    mockFsReadFile.mockResolvedValue(Buffer.from("mock plist"));
    mockPlistParse.mockReturnValue({
      CFBundleShortVersionString: "$(MARKETING_VERSION)",
    });
    mockMarketingVersion("2.15.0");

    expect(await getDefaultTargetAppVersion("ios")).toBe("2.15.0");
    expect(mockXcodeProjectOpen).toHaveBeenCalledWith(xcodeprojPath);
  });

  it("appends .x to a two-segment version read from xcodeproj", async () => {
    mockFileExist([plistPath]);
    mockFsReadFile.mockResolvedValue(Buffer.from("mock plist"));
    mockPlistParse.mockReturnValue({
      CFBundleShortVersionString: "$(MARKETING_VERSION)",
    });
    mockMarketingVersion("2.15");

    expect(await getDefaultTargetAppVersion("ios")).toBe("2.15.x");
  });

  it("prefers Info.plist and never parses project.pbxproj when it resolves", async () => {
    mockFileExist([plistPath]);
    mockFsReadFile.mockResolvedValue(Buffer.from("mock plist"));
    mockPlistParse.mockReturnValue({ CFBundleShortVersionString: "2.15.0" });
    mockMarketingVersion("1.0.0");

    expect(await getDefaultTargetAppVersion("ios")).toBe("2.15.0");
    expect(mockXcodeProjectOpen).not.toHaveBeenCalled();
  });

  it("returns null when neither source resolves a version", async () => {
    mockFileExist([]);
    mockGlobbySync.mockReturnValue([]);

    expect(await getDefaultTargetAppVersion("ios")).toBe(null);
  });
});
