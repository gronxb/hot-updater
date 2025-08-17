import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import fg from "fast-glob";
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
    },
  },
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn(),
    relative: vi.fn(),
    isAbsolute: vi.fn(),
  },
}));

vi.mock("fast-glob", () => ({
  default: {
    glob: vi.fn(),
  },
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

  beforeEach(() => {
    vi.clearAllMocks();

    // Basic mock setup
    vi.mocked(getCwd).mockReturnValue("/mock/project");
    vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
    vi.mocked(path.relative).mockImplementation((from, to) =>
      to.replace(`${from}/`, ""),
    );
    vi.mocked(path.isAbsolute).mockImplementation((p) => p.startsWith("/"));
    vi.mocked(fs.existsSync).mockReturnValue(false);

    iosParser = new IosConfigParser();
  });

  describe("constructor", () => {
    it("should use default glob pattern when no custom paths provided", () => {
      const parser = new IosConfigParser();
      expect(parser).toBeDefined();
    });

    it("should use custom paths when provided", () => {
      const customPaths = [
        "ios/TestApp/Info.plist",
        "ios/Extension/Info.plist",
      ];
      const parser = new IosConfigParser(customPaths);
      expect(parser).toBeDefined();
    });
  });

  describe("exists", () => {
    it("should return true when plist file exists with default glob", async () => {
      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);

      const result = await iosParser.exists();

      expect(result).toBe(true);
      expect(fg.glob).toHaveBeenCalledWith("*/Info.plist", {
        cwd: "/mock/project/ios",
        absolute: true,
        onlyFiles: true,
      });
    });

    it("should return false when no plist files found with default glob", async () => {
      vi.mocked(fg.glob).mockResolvedValue([]);

      const result = await iosParser.exists();

      expect(result).toBe(false);
    });

    it("should return true when custom paths exist", async () => {
      const parser = new IosConfigParser([
        "ios/TestApp/Info.plist",
        "ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path === "/mock/project/ios/TestApp/Info.plist";
      });

      const result = await parser.exists();

      expect(result).toBe(true);
    });

    it("should return false when no custom paths exist", async () => {
      const parser = new IosConfigParser([
        "ios/TestApp/Info.plist",
        "ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.exists();
      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should return null value and path when plist file not found", async () => {
      vi.mocked(fg.glob).mockResolvedValue([]);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({
        value: null,
        path: null,
      });
    });

    it("should return value for existing key in Info.plist", async () => {
      const mockPlistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>TEST_KEY</key>
    <string>test_value</string>
</dict>
</plist>`;

      const mockPlistObject = { TEST_KEY: "test_value" };

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toEqual({
        value: "test_value",
        path: "ios/TestApp/Info.plist",
      });
      expect(plist.parse).toHaveBeenCalledWith(mockPlistContent);
    });

    it("should return null value for non-existent key", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = {};

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("NONEXISTENT_KEY");

      expect(result).toEqual({
        value: null,
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should handle numeric values from plist", async () => {
      const mockPlistObject = { PORT: 3000 };

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("PORT");

      expect(result).toEqual({
        value: "3000",
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should handle boolean values from plist", async () => {
      const mockPlistObject = { DEBUG_MODE: true };

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("DEBUG_MODE");

      expect(result).toEqual({
        value: "true",
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should handle null and undefined values from plist", async () => {
      const mockPlistObject = { NULL_KEY: null, UNDEFINED_KEY: undefined };

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject as any);

      const nullResult = await iosParser.get("NULL_KEY");
      expect(nullResult).toEqual({
        value: null,
        path: "ios/TestApp/Info.plist",
      });

      const undefinedResult = await iosParser.get("UNDEFINED_KEY");
      expect(undefinedResult).toEqual({
        value: null,
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should handle Info.plist read errors by throwing", async () => {
      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(iosParser.get("TEST_KEY")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should handle plist parse errors by throwing", async () => {
      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid xml");
      vi.mocked(plist.parse).mockImplementation(() => {
        throw new Error("Invalid plist format");
      });

      await expect(iosParser.get("TEST_KEY")).rejects.toThrow(
        "Invalid plist format",
      );
    });

    it("should return value from first matching file with custom paths", async () => {
      const parser = new IosConfigParser([
        "/mock/project/ios/TestApp/Info.plist",
        "/mock/project/ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValueOnce({
        TEST_KEY: "first_value",
      });

      const result = await parser.get("TEST_KEY");

      expect(result).toEqual({
        value: "first_value",
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should check second file if first doesn't have the key", async () => {
      const parser = new IosConfigParser([
        "/mock/project/ios/TestApp/Info.plist",
        "/mock/project/ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse)
        .mockReturnValueOnce({
          OTHER_KEY: "other_value",
        })
        .mockReturnValueOnce({
          TEST_KEY: "second_value",
        });

      const result = await parser.get("TEST_KEY");

      expect(result).toEqual({
        value: "second_value",
        path: "ios/Extension/Info.plist",
      });
    });
  });

  describe("set", () => {
    it("should return empty path when plist file not found", async () => {
      vi.mocked(fg.glob).mockResolvedValue([]);

      const result = await iosParser.set("TEST_KEY", "test_value");

      expect(result).toEqual({ path: null });
    });

    it("should set value directly in Info.plist", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = {};
      const newPlistXml =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>test_value</string></dict></plist>';

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue(newPlistXml);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("TEST_KEY", "test_value");

      expect(mockPlistObject).toEqual({ TEST_KEY: "test_value" });
      expect(plist.build).toHaveBeenCalledWith(mockPlistObject, {
        indent: "\t",
        pretty: true,
      });
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        mockPlistPath,
        newPlistXml,
      );
      expect(result).toEqual({
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should update existing value in Info.plist", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>old_value</string></dict></plist>';
      const mockPlistObject = { TEST_KEY: "old_value" };
      const newPlistXml =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>new_value</string></dict></plist>';

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue(newPlistXml);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("TEST_KEY", "new_value");

      expect(mockPlistObject).toEqual({ TEST_KEY: "new_value" });
      expect(result).toEqual({
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should preserve existing keys when setting new value", async () => {
      const mockPlistObject = {
        EXISTING_KEY: "existing_value",
        ANOTHER_KEY: "another_value",
      };

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("NEW_KEY", "new_value");

      expect(mockPlistObject).toEqual({
        EXISTING_KEY: "existing_value",
        ANOTHER_KEY: "another_value",
        NEW_KEY: "new_value",
      });
      expect(result).toEqual({
        path: "ios/TestApp/Info.plist",
      });
    });

    it("should handle plist parse errors", async () => {
      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid xml");
      vi.mocked(plist.parse).mockImplementation(() => {
        throw new Error("Invalid plist format");
      });

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Invalid plist format",
      );
    });

    it("should handle file write errors", async () => {
      const mockPlistObject = {};

      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("");
      vi.mocked(fs.promises.writeFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should handle file read errors during set operation", async () => {
      vi.mocked(fg.glob).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should update all existing files with custom paths", async () => {
      const parser = new IosConfigParser([
        "/mock/project/ios/TestApp/Info.plist",
        "/mock/project/ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue({});
      vi.mocked(plist.build).mockReturnValue("new plist content");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await parser.set("TEST_KEY", "test_value");

      // Should have been called twice
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        "/mock/project/ios/TestApp/Info.plist",
        "new plist content",
      );
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        "/mock/project/ios/Extension/Info.plist",
        "new plist content",
      );

      expect(result.path).toContain("ios/TestApp/Info.plist");
      expect(result.path).toContain("ios/Extension/Info.plist");
    });

    it("should handle partial failures when updating multiple files", async () => {
      const parser = new IosConfigParser([
        "/mock/project/ios/TestApp/Info.plist",
        "/mock/project/ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue({});
      vi.mocked(plist.build).mockReturnValue("new plist content");

      // First write succeeds, second fails
      vi.mocked(fs.promises.writeFile)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Permission denied"));

      // Should throw on first error
      await expect(parser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should return null path when no files exist with custom paths", async () => {
      const parser = new IosConfigParser([
        "/mock/project/ios/TestApp/Info.plist",
        "/mock/project/ios/Extension/Info.plist",
      ]);

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.set("TEST_KEY", "test_value");

      expect(result).toEqual({ path: null });
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });
  });
});
