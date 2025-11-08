import { getCwd } from "@hot-updater/cli-tools";
import fs from "fs";
import path from "path";
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
  });

  describe("constructor", () => {
    it("should create parser with empty paths when no custom paths provided", () => {
      const parser = new IosConfigParser();
      expect(parser).toBeDefined();
    });

    it("should create parser with custom paths when provided", () => {
      const customPaths = ["ios/TestApp/Info.plist"];
      const parser = new IosConfigParser(customPaths);
      expect(parser).toBeDefined();
    });
  });

  describe("exists", () => {
    it("should return false when no paths provided", async () => {
      const parser = new IosConfigParser();
      const result = await parser.exists();
      expect(result).toBe(false);
    });

    it("should return true when file exists", async () => {
      const parser = new IosConfigParser(["ios/TestApp/Info.plist"]);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await parser.exists();

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(
        "/mock/project/ios/TestApp/Info.plist",
      );
    });

    it("should return false when file does not exist", async () => {
      const parser = new IosConfigParser(["ios/TestApp/Info.plist"]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.exists();

      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should return null when no paths provided", async () => {
      const parser = new IosConfigParser();
      const result = await parser.get("TEST_KEY");

      expect(result).toEqual({
        value: null,
        paths: [],
      });
    });

    it("should return null when no files exist", async () => {
      const parser = new IosConfigParser(["ios/TestApp/Info.plist"]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.get("TEST_KEY");

      expect(result).toEqual({
        value: null,
        paths: [],
      });
    });

    it("should return value when key exists", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      const mockPlistObject = { TEST_KEY: "test_value" };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("plist content");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await parser.get("TEST_KEY");

      expect(result).toEqual({
        value: "test_value",
        paths: ["ios/TestApp/Info.plist"],
      });
      expect(fs.promises.readFile).toHaveBeenCalledWith(mockPlistPath, "utf-8");
      expect(plist.parse).toHaveBeenCalledWith("plist content");
    });

    it("should return null when key does not exist", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      const mockPlistObject = {};

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("plist content");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await parser.get("NONEXISTENT_KEY");

      expect(result).toEqual({
        value: null,
        paths: ["ios/TestApp/Info.plist"],
      });
    });

    it("should handle file read errors", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Read error"),
      );

      await expect(parser.get("TEST_KEY")).rejects.toThrow("Read error");
    });

    it("should handle plist parse errors", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid plist");
      vi.mocked(plist.parse).mockImplementation(() => {
        throw new Error("Parse error");
      });

      await expect(parser.get("TEST_KEY")).rejects.toThrow("Parse error");
    });
  });

  describe("set", () => {
    it("should return null path when no paths provided", async () => {
      const parser = new IosConfigParser();
      const result = await parser.set("TEST_KEY", "test_value");

      expect(result).toEqual({ paths: [] });
    });

    it("should return null path when no files exist", async () => {
      const parser = new IosConfigParser(["ios/TestApp/Info.plist"]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.set("TEST_KEY", "test_value");

      expect(result).toEqual({ paths: [] });
    });

    it("should set value successfully", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      const mockPlistObject = { EXISTING_KEY: "existing_value" };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(
        fs.promises.readFile,
      ).mockResolvedValue(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>`);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("new plist content");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await parser.set("TEST_KEY", "test_value");

      expect(mockPlistObject).toEqual({
        EXISTING_KEY: "existing_value",
        TEST_KEY: "test_value",
      });
      expect(plist.build).toHaveBeenCalledWith(mockPlistObject, {
        indent: "\t",
        pretty: true,
      });
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        mockPlistPath,
        "new plist content",
      );
      expect(result).toEqual({
        paths: ["ios/TestApp/Info.plist"],
      });
    });

    it("should handle file read errors", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Read error"),
      );

      await expect(parser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Read error",
      );
    });

    it("should handle file write errors", async () => {
      const parser = new IosConfigParser([mockPlistPath]);
      const mockPlistObject = {};

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("plist content");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue("new plist content");

      await expect(parser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Failed to parse or update Info.plist at 'ios/TestApp/Info.plist': File does not appear to be valid XML: missing XML declaration",
      );
    });
  });
});
