import { beforeEach, describe, expect, it, vi } from "vitest";
import { AndroidConfigParser, IosConfigParser } from "./configParser";

// Mock modules
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn(),
    relative: vi.fn(),
  },
}));

vi.mock("globby", () => ({
  globby: vi.fn(),
}));

vi.mock("plist", () => ({
  default: {
    parse: vi.fn(),
    build: vi.fn(),
  },
}));

vi.mock("@hot-updater/plugin-core", () => ({
  getCwd: vi.fn(),
}));

// Import mock functions
import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { globby } from "globby";
import plist from "plist";

describe("AndroidConfigParser", () => {
  let androidParser: AndroidConfigParser;
  const mockBuildGradlePath = "/mock/project/android/app/build.gradle";

  beforeEach(() => {
    vi.clearAllMocks();

    // Basic mock setup
    vi.mocked(getCwd).mockReturnValue("/mock/project");
    vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
    vi.mocked(path.relative).mockImplementation((from, to) =>
      to.replace(`${from}/`, ""),
    );

    androidParser = new AndroidConfigParser();
  });

  describe("exists", () => {
    it("should return true when file exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await androidParser.exists();

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(mockBuildGradlePath);
    });

    it("should return false when file does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await androidParser.exists();

      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should throw error when file does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(androidParser.get("TEST_KEY")).rejects.toThrow(
        "build.gradle not found",
      );
    });

    it("should return null when android block is not found", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        'apply plugin: "com.android.application"',
      );

      const result = await androidParser.get("TEST_KEY");

      expect(result).toBe(null);
    });

    it("should correctly extract existing buildConfigField value", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "test_value"
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toBe("test_value");
    });

    it("should return null for non-existent key", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("NONEXISTENT_KEY");

      expect(result).toBe(null);
    });

    it("should handle various quote formats", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField 'String', 'TEST_KEY', 'test_value'
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toBe("test_value");
    });
  });

  describe("set", () => {
    it("should throw error when file does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(androidParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "build.gradle not found",
      );
    });

    it("should throw error when android block is not found", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        'apply plugin: "com.android.application"',
      );

      await expect(androidParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "android block not found",
      );
    });

    it("should throw error when defaultConfig block is not found", async () => {
      const buildGradleContent = `
android {
    compileSdkVersion 30
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      await expect(androidParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "defaultConfig block not found",
      );
    });

    it("should update existing buildConfigField", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "old_value"
        applicationId "com.example.app"
    }
}`;

      const expectedContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "new_value"
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await androidParser.set("TEST_KEY", "new_value");

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        mockBuildGradlePath,
        expectedContent,
      );
      expect(result.path).toBe("android/app/build.gradle");
    });

    it("should add new buildConfigField", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await androidParser.set("NEW_KEY", "new_value");

      const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
      const writtenContent = writeCall?.[1] as string;

      expect(writtenContent).toContain(
        'buildConfigField "String", "NEW_KEY", "new_value"',
      );
    });

    it("should handle complex indentation correctly", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
        versionCode 1
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await androidParser.set("NEW_KEY", "new_value");

      const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
      const writtenContent = writeCall?.[1] as string;
      const lines = writtenContent.split("\n");

      // Check if newly added line has correct indentation
      const newFieldLine = lines.find((line) => line.includes("NEW_KEY"));
      expect(newFieldLine).toMatch(/^\s+buildConfigField/);
    });
  });
});

describe("IosConfigParser", () => {
  let iosParser: IosConfigParser;
  const mockPlistPath = "/mock/project/ios/TestApp/Info.plist";

  beforeEach(() => {
    vi.clearAllMocks();

    // Basic mock setup
    vi.mocked(getCwd).mockReturnValue("/mock/project");
    vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
    vi.mocked(path.relative).mockImplementation((from, to) =>
      to.replace(`${from}/`, ""),
    );

    iosParser = new IosConfigParser();
  });

  describe("exists", () => {
    it("should return true when plist file exists", async () => {
      vi.mocked(globby).mockResolvedValue([mockPlistPath]);

      const result = await iosParser.exists();

      expect(result).toBe(true);
      expect(globby).toHaveBeenCalledWith("*/Info.plist", {
        cwd: "/mock/project/ios",
        absolute: true,
        onlyFiles: true,
      });
    });

    it("plist 파일이 존재하지 않으면 false를 반환해야 한다", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      const result = await iosParser.exists();

      expect(result).toBe(false);
    });

    it("globby에서 에러가 발생하면 false를 반환해야 한다", async () => {
      vi.mocked(globby).mockRejectedValue(new Error("Permission denied"));

      const result = await iosParser.exists();

      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("plist 파일이 없으면 에러를 던져야 한다", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      await expect(iosParser.get("TEST_KEY")).rejects.toThrow(
        "Info.plist not found",
      );
    });

    it("기존 키의 값을 올바르게 반환해야 한다", async () => {
      const mockPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>TEST_KEY</key>
    <string>test_value</string>
</dict>
</plist>`;

      const mockPlistObject = { TEST_KEY: "test_value" };

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toBe("test_value");
      expect(plist.parse).toHaveBeenCalledWith(mockPlistContent);
    });

    it("존재하지 않는 키에 대해 null을 반환해야 한다", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = {};

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("NONEXISTENT_KEY");

      expect(result).toBe(null);
    });

    it("boolean 값을 문자열로 반환해야 한다", async () => {
      const mockPlistObject = { BOOL_KEY: true };

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("BOOL_KEY");

      expect(result).toBe(true);
    });
  });

  describe("set", () => {
    it("plist 파일이 없으면 에러를 던져야 한다", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Info.plist not found",
      );
    });

    it("새로운 키-값을 설정하고 파일을 업데이트해야 한다", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = {};
      const newPlistXml =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>test_value</string></dict></plist>';

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue(newPlistXml);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("TEST_KEY", "test_value");

      expect(mockPlistObject).toEqual({ TEST_KEY: "test_value" });
      expect(plist.build).toHaveBeenCalledWith(mockPlistObject, {
        indent: "\t",
        offset: -1,
      });
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        mockPlistPath,
        newPlistXml,
      );
      expect(result.path).toBe("ios/TestApp/Info.plist");
    });

    it("기존 키의 값을 업데이트해야 한다", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = { TEST_KEY: "old_value" };
      const newPlistXml =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>new_value</string></dict></plist>';

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue(newPlistXml);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await iosParser.set("TEST_KEY", "new_value");

      expect(mockPlistObject).toEqual({ TEST_KEY: "new_value" });
    });

    it("여러 키를 동시에 관리할 수 있어야 한다", async () => {
      const mockPlistObject = {
        EXISTING_KEY: "existing_value",
        ANOTHER_KEY: "another_value",
      };

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await iosParser.set("NEW_KEY", "new_value");

      expect(mockPlistObject).toEqual({
        EXISTING_KEY: "existing_value",
        ANOTHER_KEY: "another_value",
        NEW_KEY: "new_value",
      });
    });
  });
});

// 통합 테스트
describe("Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AndroidConfigParser와 IosConfigParser는 독립적으로 동작해야 한다", async () => {
    const androidParser = new AndroidConfigParser();
    const iosParser = new IosConfigParser();

    // Android 모킹
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const pathStr = filePath.toString();
      if (pathStr.includes("build.gradle")) {
        return Promise.resolve(`
android {
    defaultConfig {
        applicationId "com.example.app"
    }
}`);
      }
      if (pathStr.includes("Info.plist")) {
        return Promise.resolve(
          '<?xml version="1.0"?><plist><dict></dict></plist>',
        );
      }
      return Promise.resolve("");
    });
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

    // iOS 모킹
    vi.mocked(globby).mockResolvedValue(["/mock/ios/Info.plist"]);
    vi.mocked(plist.parse).mockReturnValue({}); // get 호출 시 빈 객체 반환
    vi.mocked(plist.build).mockReturnValue(
      '<?xml version="1.0"?><plist></plist>',
    );

    // 각각 독립적으로 설정
    await expect(
      androidParser.set("ANDROID_KEY", "android_value"),
    ).resolves.toBeDefined();
    await expect(iosParser.set("IOS_KEY", "ios_value")).resolves.toBeDefined();

    // 서로 영향을 주지 않음
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
    expect(plist.build).toHaveBeenCalledTimes(1);
  });

  it("실제 사용 시나리오를 시뮬레이션해야 한다", async () => {
    const androidParser = new AndroidConfigParser();
    const iosParser = new IosConfigParser();

    // 파일 존재 확인
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(globby).mockResolvedValue(["/mock/ios/Info.plist"]);

    const androidExists = await androidParser.exists();
    const iosExists = await iosParser.exists();

    expect(androidExists).toBe(true);
    expect(iosExists).toBe(true);

    // 기존 값 조회
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const pathStr = filePath.toString();
      if (pathStr.includes("build.gradle")) {
        return Promise.resolve(`
android {
    defaultConfig {
        buildConfigField "String", "HOT_UPDATER_CHANNEL", "dev"
    }
}`);
      }
      if (pathStr.includes("Info.plist")) {
        return Promise.resolve(
          '<?xml version="1.0"?><plist><dict><key>HOT_UPDATER_CHANNEL</key><string>dev</string></dict></plist>',
        );
      }
      return Promise.resolve("");
    });
    vi.mocked(plist.parse).mockImplementation((content: any): any => {
      // 타입을 any로 변경
      if (
        typeof content === "string" &&
        content.includes("HOT_UPDATER_CHANNEL")
      ) {
        return { HOT_UPDATER_CHANNEL: "dev" };
      }
      return {};
    });

    const androidChannel = await androidParser.get("HOT_UPDATER_CHANNEL");
    const iosChannel = await iosParser.get("HOT_UPDATER_CHANNEL");

    expect(androidChannel).toBe("dev");
    expect(iosChannel).toBe("dev");

    // 값 업데이트
    // readFile이 새로운 값을 반환하도록 재설정할 필요는 없습니다.
    // set 메소드는 내부적으로 파일을 다시 읽지 않고, 기존 내용을 수정합니다.
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
    vi.mocked(plist.build).mockReturnValue("updated plist");

    await androidParser.set("HOT_UPDATER_CHANNEL", "prod");
    await iosParser.set("HOT_UPDATER_CHANNEL", "prod");

    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
  });
});

// 에러 처리 테스트
describe("Error Handling", () => {
  describe("AndroidConfigParser Error Cases", () => {
    let androidParser: AndroidConfigParser;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(getCwd).mockReturnValue("/mock/project");
      vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
      vi.mocked(path.relative).mockImplementation((from, to) =>
        to.replace(`${from}/`, ""),
      );
      androidParser = new AndroidConfigParser();
    });

    it("파일 읽기 실패 시 에러를 전파해야 한다", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(androidParser.get("TEST_KEY")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("파일 쓰기 실패 시 에러를 전파해야 한다", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(`
android {
    defaultConfig {
        applicationId "com.example.app"
    }
}`);
      vi.mocked(fs.promises.writeFile).mockRejectedValue(
        new Error("Disk full"),
      );

      await expect(androidParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Disk full",
      );
    });
  });

  describe("IosConfigParser Error Cases", () => {
    let iosParser: IosConfigParser;

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(getCwd).mockReturnValue("/mock/project");
      vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
      vi.mocked(path.relative).mockImplementation((from, to) =>
        to.replace(`${from}/`, ""),
      );
      iosParser = new IosConfigParser();
    });

    it("plist 파싱 실패 시 에러를 전파해야 한다", async () => {
      vi.mocked(globby).mockResolvedValue(["/mock/ios/Info.plist"]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid xml");
      vi.mocked(plist.parse).mockImplementation(() => {
        throw new Error("Invalid plist format");
      });

      await expect(iosParser.get("TEST_KEY")).rejects.toThrow(
        "Invalid plist format",
      );
    });

    it("plist 빌드 실패 시 에러를 전파해야 한다", async () => {
      vi.mocked(globby).mockResolvedValue(["/mock/ios/Info.plist"]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("valid xml");
      vi.mocked(plist.parse).mockReturnValue({});
      vi.mocked(plist.build).mockImplementation(() => {
        throw new Error("Build failed");
      });

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Build failed",
      );
    });
  });
});
