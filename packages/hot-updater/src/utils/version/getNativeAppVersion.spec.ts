// __tests__/getNativeAppVersion.test.ts

import { XcodeProject } from "@bacons/xcode";
import { getCwd } from "@hot-updater/cli-tools";
import fg from "fast-glob";
import fs from "fs/promises";
import path from "path";
import plist from "plist";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { getNativeAppVersion } from "./getNativeAppVersion";

vi.mock("fs/promises");
vi.mock("path");
vi.mock("@bacons/xcode");
vi.mock("@hot-updater/plugin-core");

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
    it("should return app version when xcodeproj file exists and has MARKETING_VERSION", async () => {
      // Arrange
      const mockXcodeprojPath =
        "/mock/project/root/ios/HotUpdaterExample.xcodeproj/project.pbxproj";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);

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

    it("should fallback to plist when xcodeproj has no MARKETING_VERSION", async () => {
      // Arrange
      const mockXcodeprojPath = "HotUpdaterExample.xcodeproj/project.pbxproj";
      const mockPlistPath =
        "/mock/project/root/ios/HotUpdaterExample/Info.plist";

      mockGlobbySync.mockReturnValue([mockXcodeprojPath]);

      // xcodeproj에 MARKETING_VERSION이 없는 경우
      const mockProject = {
        objects: {
          "13B07F941A680F5B00A75B9A": {
            isa: "XCBuildConfiguration",
            buildSettings: {
              // MARKETING_VERSION이 없음
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

      mockFsReadFile.mockResolvedValue(mockPlistContent);
      mockPlistParse.mockReturnValue({
        CFBundleShortVersionString: "2.0",
      });

      // Act
      const result = await getNativeAppVersion("ios");

      // Assert
      expect(result).toBe("2.0");
      expect(mockFsReadFile).toHaveBeenCalledWith(mockPlistPath, "utf8");
      expect(mockPlistParse).toHaveBeenCalledWith(mockPlistContent);
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
});
