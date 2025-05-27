import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { globby } from "globby";
import plist from "plist";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IosConfigParser } from "./iosParser";

// Mock modules
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn(),
    relative: vi.fn(),
    dirname: vi.fn(),
    basename: vi.fn(),
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

describe("IosConfigParser", () => {
  let iosParser: IosConfigParser;
  const mockPlistPath = "/mock/project/ios/TestApp/Info.plist";
  const mockXcconfigPath = "/mock/project/ios/debug.xcconfig";

  beforeEach(() => {
    vi.clearAllMocks();

    // Basic mock setup
    vi.mocked(getCwd).mockReturnValue("/mock/project");
    vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
    vi.mocked(path.relative).mockImplementation((from, to) =>
      to.replace(`${from}/`, ""),
    );
    vi.mocked(path.dirname).mockImplementation((filePath) => {
      const parts = filePath.split("/");
      return parts.slice(0, -1).join("/");
    });
    vi.mocked(path.basename).mockImplementation((filePath, ext) => {
      const parts = filePath.split("/");
      const filename = parts[parts.length - 1] ?? "";
      return ext ? filename.replace(ext, "") : filename;
    });

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

    it("should return false when plist file does not exist", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      const result = await iosParser.exists();

      expect(result).toBe(false);
    });

    it("should return false when globby throws error", async () => {
      vi.mocked(globby).mockRejectedValue(new Error("Permission denied"));

      const result = await iosParser.exists();

      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should return empty object when plist file not found", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({});
    });

    it("should return object with default value for existing key in Info.plist", async () => {
      const mockPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>TEST_KEY</key>
    <string>test_value</string>
</dict>
</plist>`;

      const mockPlistObject = { TEST_KEY: "test_value" };

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce([]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({ default: "test_value" });
      expect(plist.parse).toHaveBeenCalledWith(mockPlistContent);
    });

    it("should return empty object for non-existent key", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = {};

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce([]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("NONEXISTENT_KEY");

      expect(result).toEqual({});
    });

    it("should ignore variable references in Info.plist", async () => {
      const mockPlistObject = { TEST_KEY: "$(TEST_KEY)" };

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce([]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({});
    });

    it("should return flavor values from xcconfig files", async () => {
      const mockPlistObject = {};
      const mockXcconfigContent = `// Configuration file
API_URL = https://dev.api.com
DEBUG_MODE = true`;

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce(["/mock/project/ios/debug.xcconfig"]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce("") // Info.plist
        .mockResolvedValueOnce(mockXcconfigContent); // xcconfig file
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("API_URL");

      expect(result).toEqual({ debug: "https://dev.api.com" });
    });

    it("should combine Info.plist default and xcconfig flavor values", async () => {
      const mockPlistObject = { API_URL: "https://default.api.com" };
      const mockXcconfigContent = "API_URL = https://dev.api.com";

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce(["/mock/project/ios/debug.xcconfig"]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce("") // Info.plist
        .mockResolvedValueOnce(mockXcconfigContent); // xcconfig file
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("API_URL");

      expect(result).toEqual({
        default: "https://default.api.com",
        debug: "https://dev.api.com",
      });
    });

    it("should handle multiple xcconfig files", async () => {
      const mockPlistObject = {};
      const debugXcconfigContent = "API_URL = https://dev.api.com";
      const releaseXcconfigContent = "API_URL = https://prod.api.com";

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce([
          "/mock/project/ios/debug.xcconfig",
          "/mock/project/ios/release.xcconfig",
        ]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce("") // Info.plist
        .mockResolvedValueOnce(debugXcconfigContent) // debug.xcconfig
        .mockResolvedValueOnce(releaseXcconfigContent); // release.xcconfig
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("API_URL");

      expect(result).toEqual({
        debug: "https://dev.api.com",
        release: "https://prod.api.com",
      });
    });
  });

  describe("set", () => {
    it("should throw error when plist file not found for default set", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Info.plist not found",
      );
    });

    it("should throw error when plist file not found for flavor set", async () => {
      // Mock getXcconfigPath calls first
      vi.mocked(globby)
        .mockResolvedValueOnce([]) // debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Config/debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Configurations/debug.xcconfig pattern
        .mockResolvedValueOnce([]); // getPlistPath call - no plist found

      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error("File not found"),
      ); // xcconfig doesn't exist

      await expect(
        iosParser.set("TEST_KEY", "test_value", { flavor: "debug" }),
      ).rejects.toThrow("Info.plist not found");
    });

    it("should set value directly in Info.plist when no flavor specified", async () => {
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

    it("should create xcconfig file and update Info.plist when flavor specified", async () => {
      const mockPlistObject = {};
      const expectedXcconfigContent = `// Configuration settings file format documentation can be found at:
// https://help.apple.com/xcode/#/dev745c5c974

TEST_KEY = test_value
`;

      // Mock getXcconfigPath calls - no existing files found
      vi.mocked(globby)
        .mockResolvedValueOnce([]) // debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Config/debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Configurations/debug.xcconfig pattern
        .mockResolvedValueOnce([mockPlistPath]); // getPlistPath call

      vi.mocked(fs.promises.readFile)
        .mockRejectedValueOnce(new Error("File not found")) // xcconfig doesn't exist
        .mockResolvedValueOnce(""); // Info.plist read
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("TEST_KEY", "test_value", {
        flavor: "debug",
      });

      expect(fs.promises.mkdir).toHaveBeenCalledWith("/mock/project/ios", {
        recursive: true,
      });
      expect(fs.promises.writeFile).toHaveBeenNthCalledWith(
        1,
        "/mock/project/ios/debug.xcconfig",
        expectedXcconfigContent,
        "utf-8",
      );
      expect(mockPlistObject).toEqual({ TEST_KEY: "$(TEST_KEY)" });
      expect(result.path).toBe("ios/debug.xcconfig");
    });

    it("should update existing xcconfig file when flavor specified", async () => {
      const existingXcconfigContent = `// Existing config
EXISTING_KEY = existing_value`;
      const expectedXcconfigContent = `// Configuration settings file format documentation can be found at:
// https://help.apple.com/xcode/#/dev745c5c974

EXISTING_KEY = existing_value
TEST_KEY = test_value
`;
      const mockPlistObject = {};

      // Mock getXcconfigPath calls - first pattern finds existing file
      vi.mocked(globby)
        .mockResolvedValueOnce([mockXcconfigPath]) // debug.xcconfig pattern - found!
        .mockResolvedValueOnce([mockPlistPath]); // getPlistPath call

      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(existingXcconfigContent) // existing xcconfig
        .mockResolvedValueOnce(""); // Info.plist read
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("TEST_KEY", "test_value", {
        flavor: "debug",
      });

      expect(fs.promises.writeFile).toHaveBeenNthCalledWith(
        1,
        mockXcconfigPath,
        expectedXcconfigContent,
        "utf-8",
      );
      expect(mockPlistObject).toEqual({ TEST_KEY: "$(TEST_KEY)" });
      expect(result.path).toBe("ios/debug.xcconfig");
    });

    it("should handle different xcconfig file patterns", async () => {
      const mockPlistObject = {};

      // Mock getXcconfigPath calls - all patterns return empty, so new file will be created
      vi.mocked(globby)
        .mockResolvedValueOnce([]) // **/release.xcconfig
        .mockResolvedValueOnce([]) // **/Release.xcconfig
        .mockResolvedValueOnce([]) // **/Config/release.xcconfig
        .mockResolvedValueOnce([]) // **/Configurations/release.xcconfig
        .mockResolvedValueOnce([mockPlistPath]); // getPlistPath call

      vi.mocked(fs.promises.readFile)
        .mockRejectedValueOnce(new Error("File not found")) // xcconfig doesn't exist
        .mockResolvedValueOnce(""); // Info.plist read
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await iosParser.set("TEST_KEY", "test_value", { flavor: "release" });

      // Should check multiple patterns
      expect(globby).toHaveBeenCalledWith("**/release.xcconfig", {
        cwd: "/mock/project/ios",
        absolute: true,
        onlyFiles: true,
      });
      expect(globby).toHaveBeenCalledWith("**/Release.xcconfig", {
        cwd: "/mock/project/ios",
        absolute: true,
        onlyFiles: true,
      });
      expect(globby).toHaveBeenCalledWith("**/Config/release.xcconfig", {
        cwd: "/mock/project/ios",
        absolute: true,
        onlyFiles: true,
      });
      expect(globby).toHaveBeenCalledWith(
        "**/Configurations/release.xcconfig",
        {
          cwd: "/mock/project/ios",
          absolute: true,
          onlyFiles: true,
        },
      );
    });

    it("should handle xcconfig file with comments and empty lines", async () => {
      const existingXcconfigContent = `// This is a comment
# This is also a comment

EXISTING_KEY = existing_value

// Another comment
ANOTHER_KEY = another_value
`;
      const expectedXcconfigContent = `// Configuration settings file format documentation can be found at:
// https://help.apple.com/xcode/#/dev745c5c974

EXISTING_KEY = existing_value
ANOTHER_KEY = another_value
TEST_KEY = test_value
`;
      const mockPlistObject = {};

      // Mock getXcconfigPath calls - first pattern finds existing file
      vi.mocked(globby)
        .mockResolvedValueOnce([mockXcconfigPath]) // debug.xcconfig pattern - found!
        .mockResolvedValueOnce([mockPlistPath]); // getPlistPath call

      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(existingXcconfigContent) // existing xcconfig
        .mockResolvedValueOnce(""); // Info.plist read
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await iosParser.set("TEST_KEY", "test_value", { flavor: "debug" });

      expect(fs.promises.writeFile).toHaveBeenNthCalledWith(
        1,
        mockXcconfigPath,
        expectedXcconfigContent,
        "utf-8",
      );
    });
  });

  describe("Error handling", () => {
    it("should handle Info.plist read errors gracefully in get method", async () => {
      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call - found
        .mockResolvedValueOnce([]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error("Permission denied"),
      ); // Info.plist read error

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({});
    });

    it("should handle xcconfig file read errors gracefully in get method", async () => {
      const mockPlistObject = { TEST_KEY: "default_value" };

      vi.mocked(globby)
        .mockResolvedValueOnce([mockPlistPath]) // getPlistPath call
        .mockResolvedValueOnce([mockXcconfigPath]); // getAllXcconfigFiles call
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce("") // Info.plist read success
        .mockRejectedValueOnce(new Error("Permission denied")); // xcconfig read error
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({ default: "default_value" });
    });

    it("should handle directory creation errors", async () => {
      // Mock getXcconfigPath calls - no existing files found
      vi.mocked(globby)
        .mockResolvedValueOnce([]) // debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Debug.xcconfig pattern
        .mockResolvedValueOnce([]) // Config/debug.xcconfig pattern
        .mockResolvedValueOnce([]); // Configurations/debug.xcconfig pattern

      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error("File not found"),
      ); // xcconfig doesn't exist
      vi.mocked(fs.promises.mkdir).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(
        iosParser.set("TEST_KEY", "test_value", { flavor: "debug" }),
      ).rejects.toThrow("Permission denied");
    });
  });
});
