// __tests__/getNativeAppVersion.test.ts

import fs from "fs/promises";
import path from "path";

import { XcodeProject } from "@bacons/xcode";
import { getCwd } from "@hot-updater/cli-tools";
import fg from "fast-glob";
import plist from "plist";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  getNativeAppVersion,
  resolveNativeAppVersion,
} from "./getNativeAppVersion";

vi.mock("fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      access: vi.fn(),
      readFile: vi.fn(),
    },
    access: vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return {
    ...actual,
    default: {
      ...actual,
      join: vi.fn(),
    },
    join: vi.fn(),
  };
});
vi.mock("@bacons/xcode");
vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: vi.fn(),
}));

vi.mock("fast-glob", () => ({
  default: {
    globSync: vi.fn(),
  },
}));

vi.mock("find-up-simple");
vi.mock("plist");

describe("getNativeAppVersion", () => {
  const mockGetCwd = getCwd as Mock;
  const mockGlobbySync = fg.globSync as Mock;
  const mockXcodeProjectOpen = XcodeProject.open as Mock;
  const mockPathJoin = path.join as Mock;
  const mockFsReadFile = fs.readFile as Mock;
  const mockFsAccess = fs.access as Mock;
  const mockPlistParse = plist.parse as Mock;

  const mockFileExist = (paths: string[]) => {
    mockFsAccess.mockImplementation(async (path: string) => {
      if (paths.includes(path)) return;

      throw new Error();
    });
  };
  const mockFileExistFailure = () => mockFileExist([]);

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsAccess.mockReset();

    // 기본 모킹 설정
    mockGetCwd.mockReturnValue("/mock/project/root");
    mockPathJoin.mockImplementation((...args) => args.join("/"));
  });

  describe("iOS platform", () => {
    it("should fallback to xcodeproj MARKETING_VERSION when Info.plist has no version", async () => {
      // Arrange
      const mockXcodeprojPath =
        "/mock/project/root/ios/HotUpdaterExample.xcodeproj/project.pbxproj";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);
      mockFileExistFailure(); // no Info.plist

      const mockProject = {
        objects: {
          "13B07F941A680F5B00A75B9A": {
            isa: "XCBuildConfiguration",
            buildSettings: {
              MARKETING_VERSION: "1.0",
            },
            name: "Release",
          },
        },
      };

      mockXcodeProjectOpen.mockReturnValue({
        toJSON: () => mockProject,
      });

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe("1.0");
      expect(mockGlobbySync).toHaveBeenCalledWith(
        "*.xcodeproj/project.pbxproj",
        {
          cwd: "/mock/project/root/ios",
          absolute: true,
          onlyFiles: true,
        },
      );
    });

    it("should prefer Info.plist over xcodeproj and never parse project.pbxproj", async () => {
      // Arrange
      const mockXcodeprojPath = "HotUpdaterExample.xcodeproj/project.pbxproj";
      const mockPlistPath =
        "/mock/project/root/ios/HotUpdaterExample/Info.plist";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);

      // xcodeproj also has a MARKETING_VERSION, but Info.plist wins
      const mockProject = {
        objects: {
          "13B07F941A680F5B00A75B9A": {
            isa: "XCBuildConfiguration",
            buildSettings: {
              MARKETING_VERSION: "1.0",
            },
            name: "Release",
          },
        },
      };

      mockXcodeProjectOpen.mockReturnValue({
        toJSON: () => mockProject,
      });

      // plist 파일 찾기
      mockFileExist([mockPlistPath]);

      // plist 파일 내용
      const mockPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>2.0</string>
</dict>
</plist>`;

      mockFsReadFile.mockResolvedValue(Buffer.from(mockPlistContent));
      mockPlistParse.mockReturnValue({
        CFBundleShortVersionString: "2.0",
      });

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe("2.0");
      expect(mockFsReadFile).toHaveBeenCalledWith(mockPlistPath);
      expect(mockPlistParse).toHaveBeenCalledWith(mockPlistContent);
      // Parsing project.pbxproj is synchronous and blocks the event loop, so
      // it must not be opened at all once Info.plist has answered.
      expect(mockXcodeProjectOpen).not.toHaveBeenCalled();
    });

    it("should fallback to xcodeproj when Info.plist contains an unresolved build setting", async () => {
      // Arrange
      const mockXcodeprojPath = "HotUpdaterExample.xcodeproj/project.pbxproj";
      const mockPlistPath =
        "/mock/project/root/ios/HotUpdaterExample/Info.plist";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);
      mockFileExist([mockPlistPath]);
      mockFsReadFile.mockResolvedValue(Buffer.from("mock plist"));
      mockPlistParse.mockReturnValue({
        CFBundleShortVersionString: "$(MARKETING_VERSION)",
      });
      mockXcodeProjectOpen.mockReturnValue({
        toJSON: () => ({
          objects: {
            "13B07F941A680F5B00A75B9A": {
              isa: "XCBuildConfiguration",
              buildSettings: {
                MARKETING_VERSION: "1.0",
              },
              name: "Release",
            },
          },
        }),
      });

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe("1.0");
      expect(mockXcodeProjectOpen).toHaveBeenCalledWith(mockXcodeprojPath);
    });

    it("should return null when xcodeproj file does not exist", async () => {
      // Arrange
      mockGlobbySync.mockReturnValue([]); // 파일이 없음
      mockFileExistFailure(); // plist 파일이 없음

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe(null);
    });

    it("should return null when plist file does not exist and xcodeproj has no version", async () => {
      // Arrange
      const mockXcodeprojPath =
        "/mock/project/root/ios/HotUpdaterExample.xcodeproj/project.pbxproj";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);

      const mockProject = {
        objects: {
          "13B07F941A680F5B00A75B9A": {
            isa: "XCBuildConfiguration",
            buildSettings: {},
            name: "Release",
          },
        },
      };

      mockXcodeProjectOpen.mockReturnValue({
        toJSON: () => mockProject,
      });

      mockFileExistFailure(); // plist 파일이 없음

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe(null);
    });

    it("should handle xcodeproj parsing errors", async () => {
      // Arrange
      const mockXcodeprojPath =
        "/mock/project/root/ios/HotUpdaterExample.xcodeproj/project.pbxproj";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);
      mockXcodeProjectOpen.mockImplementation(() => {
        throw new Error("Invalid xcodeproj file");
      });

      // plist도 실패하도록 설정
      mockFsReadFile.mockRejectedValueOnce(new Error("File not found"));

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe(null);
    });

    it("should handle plist parsing errors", async () => {
      // Arrange
      const mockXcodeprojPath =
        "/mock/project/root/ios/HotUpdaterExample.xcodeproj/project.pbxproj";
      const mockPlistPath =
        "/mock/project/root/ios/HotUpdaterExample/Info.plist";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);

      const mockProject = {
        objects: {
          "13B07F941A680F5B00A75B9A": {
            isa: "XCBuildConfiguration",
            buildSettings: {},
            name: "Release",
          },
        },
      };

      mockXcodeProjectOpen.mockReturnValue({
        toJSON: () => mockProject,
      });

      mockFileExist([mockPlistPath]);
      mockFsReadFile.mockRejectedValue(new Error("File read error"));

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe(null);
    });
  });

  describe("Android platform", () => {
    it("should return app version from build.gradle", async () => {
      // Arrange
      const buildGradleContent = `
android {
    compileSdkVersion 33
    
    defaultConfig {
        applicationId "com.example.app"
        versionCode 1
        versionName "1.2.3"
        minSdkVersion 21
        targetSdkVersion 33
    }
}
      `;

      mockFsReadFile.mockResolvedValue(buildGradleContent);

      // Act
      const result = await getNativeAppVersion("android");

      // Assert
      expect(result).toBe("1.2.3");
      expect(mockFsReadFile).toHaveBeenCalledWith(
        "/mock/project/root/android/app/build.gradle",
        "utf8",
      );
    });

    it("should handle versionName with different formatting", async () => {
      // Arrange
      const buildGradleContent = `
android {
    defaultConfig {
        versionName "2.0.1-beta"
    }
}
      `;

      mockFsReadFile.mockResolvedValue(buildGradleContent);

      // Act
      const result = await getNativeAppVersion("android");

      // Assert
      expect(result).toBe("2.0.1-beta");
    });

    it("should return null when versionName is not found", async () => {
      // Arrange
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
        versionCode 1
        // versionName이 없음
    }
}
      `;

      mockFsReadFile.mockResolvedValue(buildGradleContent);

      // Act
      const result = await getNativeAppVersion("android");

      // Assert
      expect(result).toBe(null);
    });

    it("should return null when build.gradle file does not exist", async () => {
      // Arrange
      mockFsReadFile.mockRejectedValue(new Error("File not found"));

      // Act
      const result = await getNativeAppVersion("android");

      // Assert
      expect(result).toBe(null);
    });
  });

  describe("iOS project with several app targets (#1244)", () => {
    const xcodeprojPath = "HotUpdaterExample.xcodeproj/project.pbxproj";

    type Target = {
      name: string;
      productType?: string;
      release: Record<string, string>;
    };

    // The object graph @bacons/xcode emits: PBXProject → targets →
    // configuration lists → configurations, by ID.
    const mockProject = (
      targets: Target[],
      projectRelease: Record<string, string> = {},
    ) => {
      const objects: Record<string, unknown> = {
        PROJECT: {
          isa: "PBXProject",
          buildConfigurationList: "PROJECT_LIST",
          targets: targets.map((target) => `TARGET_${target.name}`),
        },
        PROJECT_LIST: {
          isa: "XCConfigurationList",
          buildConfigurations: ["PROJECT_RELEASE"],
        },
        PROJECT_RELEASE: {
          isa: "XCBuildConfiguration",
          name: "Release",
          buildSettings: projectRelease,
        },
      };
      for (const target of targets) {
        objects[`TARGET_${target.name}`] = {
          isa: "PBXNativeTarget",
          name: target.name,
          productType:
            target.productType ?? "com.apple.product-type.application",
          buildConfigurationList: `LIST_${target.name}`,
        };
        objects[`LIST_${target.name}`] = {
          isa: "XCConfigurationList",
          buildConfigurations: [
            `DEBUG_${target.name}`,
            `RELEASE_${target.name}`,
          ],
        };
        objects[`DEBUG_${target.name}`] = {
          isa: "XCBuildConfiguration",
          name: "Debug",
          buildSettings: { MARKETING_VERSION: "0.0.1" },
        };
        objects[`RELEASE_${target.name}`] = {
          isa: "XCBuildConfiguration",
          name: "Release",
          buildSettings: target.release,
        };
      }
      mockGlobbySync.mockReturnValue([xcodeprojPath]);
      mockXcodeProjectOpen.mockReturnValue({
        toJSON: () => ({ objects, rootObject: "PROJECT" }),
      });
    };

    const brands: Target[] = [
      {
        name: "BrandA",
        release: {
          MARKETING_VERSION: "5.5.1",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.branda",
        },
      },
      {
        name: "BrandB",
        release: {
          MARKETING_VERSION: "5.8.0",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.brandb",
        },
      },
    ];

    beforeEach(() => {
      mockFileExist([]);
    });

    it("refuses to pick one when app targets declare different versions", async () => {
      mockProject(brands);

      expect(await resolveNativeAppVersion("ios")).toEqual({
        version: null,
        candidates: [
          { label: "BrandA (Release)", version: "5.5.1" },
          { label: "BrandB (Release)", version: "5.8.0" },
        ],
      });
    });

    it("reads the version when every app target declares the same one", async () => {
      mockProject([
        { name: "BrandA", release: { MARKETING_VERSION: "2.0.0" } },
        { name: "BrandB", release: { MARKETING_VERSION: "2.0.0" } },
      ]);

      expect(await getNativeAppVersion("ios")).toBe("2.0.0");
    });

    it("ignores targets that are not applications", async () => {
      mockProject([
        { name: "App", release: { MARKETING_VERSION: "3.1.0" } },
        {
          name: "AppTests",
          productType: "com.apple.product-type.bundle.unit-test",
          release: { MARKETING_VERSION: "1.0" },
        },
      ]);

      expect(await getNativeAppVersion("ios")).toBe("3.1.0");
    });

    it("counts a target whose version is not a literal as a candidate", async () => {
      mockProject([
        { name: "BrandA", release: { MARKETING_VERSION: "5.5.1" } },
        { name: "BrandB", release: { MARKETING_VERSION: "$(BRAND_VERSION)" } },
      ]);

      expect(await resolveNativeAppVersion("ios")).toEqual({
        version: null,
        candidates: [
          { label: "BrandA (Release)", version: "5.5.1" },
          { label: "BrandB (Release)", version: null },
        ],
      });
    });

    it("inherits MARKETING_VERSION from the project configuration", async () => {
      mockProject([{ name: "App", release: {} }], {
        MARKETING_VERSION: "4.0.0",
      });

      expect(await getNativeAppVersion("ios")).toBe("4.0.0");
    });

    it("reads a target's own Info.plist over its MARKETING_VERSION", async () => {
      mockProject([
        {
          name: "BrandA",
          release: { MARKETING_VERSION: "5.5.1", INFOPLIST_FILE: "A.plist" },
        },
        {
          name: "BrandB",
          release: { MARKETING_VERSION: "5.5.1", INFOPLIST_FILE: "B.plist" },
        },
      ]);
      mockFileExist(["/mock/project/root/ios/B.plist"]);
      mockFsReadFile.mockResolvedValue(Buffer.from("mock plist"));
      mockPlistParse.mockReturnValue({ CFBundleShortVersionString: "6.0.0" });

      expect(await resolveNativeAppVersion("ios")).toEqual({
        version: null,
        candidates: [
          { label: "BrandA (Release)", version: "5.5.1" },
          { label: "BrandB (Release)", version: "6.0.0" },
        ],
      });
    });

    it("reads the target a native build scheme builds, by name", async () => {
      mockProject(brands);

      expect(
        await getNativeAppVersion("ios", { ios: { scheme: "BrandB" } }),
      ).toBe("5.8.0");
    });

    it("reads the target a native build scheme builds, by bundle identifier", async () => {
      mockProject(brands);

      expect(
        await getNativeAppVersion("ios", {
          ios: { scheme: "Other", bundleIdentifier: "com.example.branda" },
        }),
      ).toBe("5.5.1");
    });

    it("reads the scheme's configuration", async () => {
      mockProject([{ name: "App", release: { MARKETING_VERSION: "1.0.0" } }]);

      expect(
        await getNativeAppVersion("ios", { ios: { configuration: "Debug" } }),
      ).toBe("0.0.1");
    });
  });

  describe("Android app with several product flavors (#1244)", () => {
    const flavoredBuildGradle = `
android {
    defaultConfig {
        applicationId "com.example.app"
        versionCode 1
        versionName "1.0.0"
        // versionName "9.9.9"
    }

    flavorDimensions "brand", "env"
    productFlavors {
        brandA {
            dimension "brand"
            applicationId "com.example.branda"
            versionName "5.5.1"
        }
        brandB {
            dimension "brand"
            applicationId "com.example.brandb"
            versionName "5.8.0"
            versionNameSuffix "-b"
        }
        staging {
            dimension "env"
        }
    }

    buildTypes {
        release {
            minifyEnabled true
        }
    }
}
`;

    it("refuses to pick one when flavors override the version", async () => {
      mockFsReadFile.mockResolvedValue(flavoredBuildGradle);

      expect(await resolveNativeAppVersion("android")).toEqual({
        version: null,
        candidates: [
          { label: "defaultConfig", version: "1.0.0" },
          { label: "brandA flavor", version: "5.5.1" },
          { label: "brandB flavor", version: "5.8.0" },
        ],
      });
    });

    it("reads the flavor a native build variant builds", async () => {
      mockFsReadFile.mockResolvedValue(flavoredBuildGradle);

      expect(
        await getNativeAppVersion("android", {
          android: { variant: "brandBStagingRelease" },
        }),
      ).toBe("5.8.0");
    });

    it("reads the flavor a native build applicationId builds", async () => {
      mockFsReadFile.mockResolvedValue(flavoredBuildGradle);

      expect(
        await getNativeAppVersion("android", {
          android: { variant: "Release", applicationId: "com.example.branda" },
        }),
      ).toBe("5.5.1");
    });

    it("reads defaultConfig for a variant whose flavors do not override it", async () => {
      mockFsReadFile.mockResolvedValue(flavoredBuildGradle);

      expect(
        await getNativeAppVersion("android", {
          android: { variant: "stagingRelease" },
        }),
      ).toBe("1.0.0");
    });

    it("reads the version when every flavor overrides it with the same one", async () => {
      mockFsReadFile.mockResolvedValue(`
android {
    defaultConfig { versionName "1.0.0" }
    productFlavors {
        dev { versionName "2.0.0" }
        prod { versionName "2.0.0" }
    }
}
`);

      expect(await getNativeAppVersion("android")).toBe("2.0.0");
    });

    it("reads flavors in the Kotlin DSL form", async () => {
      mockFsReadFile.mockResolvedValue(`
android {
    defaultConfig {
        versionName = "1.0.0"
    }
    productFlavors {
        create("dev") {
            versionName = "1.1.0"
        }
        create("prod") {
            applicationId = "com.example.app"
        }
    }
}
`);

      expect(await resolveNativeAppVersion("android")).toEqual({
        version: null,
        candidates: [
          { label: "defaultConfig", version: "1.0.0" },
          { label: "dev flavor", version: "1.1.0" },
        ],
      });
    });

    it("reads the module a native build scheme names", async () => {
      mockFsReadFile.mockResolvedValue(flavoredBuildGradle);

      await getNativeAppVersion("android", {
        android: { appModuleName: "mobile" },
      });

      expect(mockFsReadFile).toHaveBeenCalledWith(
        "/mock/project/root/android/mobile/build.gradle",
        "utf8",
      );
    });
  });
});
