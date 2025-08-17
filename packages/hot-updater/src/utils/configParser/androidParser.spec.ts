import fs from "fs";
import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AndroidConfigParser } from "./androidParser";

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

vi.mock("@hot-updater/plugin-core", () => ({
  getCwd: vi.fn(),
}));

vi.mock("fast-xml-parser", () => ({
  XMLParser: vi.fn(),
  XMLBuilder: vi.fn(),
}));

describe("AndroidConfigParser", () => {
  let mockParser: any;
  let mockBuilder: any;
  const mockStringsXmlPath =
    "/mock/project/android/app/src/main/res/values/strings.xml";

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock XMLParser and XMLBuilder
    mockParser = {
      parse: vi.fn(),
    };
    mockBuilder = {
      build: vi.fn(),
    };

    vi.mocked(XMLParser).mockImplementation(() => mockParser);
    vi.mocked(XMLBuilder).mockImplementation(() => mockBuilder);

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
      const parser = new AndroidConfigParser();
      expect(parser).toBeDefined();
    });

    it("should create parser with custom paths when provided", () => {
      const customPaths = ["android/app/src/main/res/values/strings.xml"];
      const parser = new AndroidConfigParser(customPaths);
      expect(parser).toBeDefined();
    });
  });

  describe("exists", () => {
    it("should return false when no paths provided", async () => {
      const parser = new AndroidConfigParser();
      const result = await parser.exists();
      expect(result).toBe(false);
    });

    it("should return true when file exists", async () => {
      const parser = new AndroidConfigParser([
        "android/app/src/main/res/values/strings.xml",
      ]);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await parser.exists();

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(
        "/mock/project/android/app/src/main/res/values/strings.xml",
      );
    });

    it("should return false when file does not exist", async () => {
      const parser = new AndroidConfigParser([
        "android/app/src/main/res/values/strings.xml",
      ]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.exists();

      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should return null when no paths provided", async () => {
      const parser = new AndroidConfigParser();
      const result = await parser.get("test_key");

      expect(result).toEqual({
        value: null,
        paths: [],
      });
    });

    it("should return null when no files exist", async () => {
      const parser = new AndroidConfigParser([
        "android/app/src/main/res/values/strings.xml",
      ]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.get("test_key");

      expect(result).toEqual({
        value: null,
        paths: [],
      });
    });

    it("should return value when key exists with moduleConfig=true", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {
          string: {
            "@_name": "test_key",
            "@_moduleConfig": "true",
            "#text": "test_value",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);

      const result = await parser.get("test_key");

      expect(result).toEqual({
        value: "test_value",
        paths: ["android/app/src/main/res/values/strings.xml"],
      });
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        mockStringsXmlPath,
        "utf-8",
      );
      expect(mockParser.parse).toHaveBeenCalledWith("xml content");
    });

    it("should return null when key exists but moduleConfig is not true", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {
          string: {
            "@_name": "test_key",
            "#text": "test_value",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);

      const result = await parser.get("test_key");

      expect(result).toEqual({
        value: null,
        paths: ["android/app/src/main/res/values/strings.xml"],
      });
    });

    it("should return null when key does not exist", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {
          string: {
            "@_name": "other_key",
            "@_moduleConfig": "true",
            "#text": "other_value",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);

      const result = await parser.get("test_key");

      expect(result).toEqual({
        value: null,
        paths: ["android/app/src/main/res/values/strings.xml"],
      });
    });

    it("should handle file read errors", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Read error"),
      );

      await expect(parser.get("test_key")).rejects.toThrow("Failed to get");
    });

    it("should handle XML parse errors", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid xml");
      mockParser.parse.mockImplementation(() => {
        throw new Error("Parse error");
      });

      await expect(parser.get("test_key")).rejects.toThrow("Failed to get");
    });
  });

  describe("set", () => {
    it("should return null path when no paths provided", async () => {
      const parser = new AndroidConfigParser();
      const result = await parser.set("test_key", "test_value");

      expect(result).toEqual({ paths: [] });
    });

    it("should return null path when no files exist", async () => {
      const parser = new AndroidConfigParser([
        "android/app/src/main/res/values/strings.xml",
      ]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await parser.set("test_key", "test_value");

      expect(result).toEqual({ paths: [] });
    });

    it("should set value successfully in empty resources", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {},
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);
      mockBuilder.build.mockReturnValue("new xml content");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await parser.set("test_key", "test_value");

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: {
            "@_name": "test_key",
            "@_moduleConfig": "true",
            "#text": "test_value",
          },
        },
      });
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        mockStringsXmlPath,
        "new xml content",
        "utf-8",
      );
      expect(result).toEqual({
        paths: ["android/app/src/main/res/values/strings.xml"],
      });
    });

    it("should update existing moduleConfig string", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {
          string: {
            "@_name": "test_key",
            "@_moduleConfig": "true",
            "#text": "old_value",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);
      mockBuilder.build.mockReturnValue("new xml content");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await parser.set("test_key", "new_value");

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: {
            "@_name": "test_key",
            "@_moduleConfig": "true",
            "#text": "new_value",
          },
        },
      });
      expect(result).toEqual({
        paths: ["android/app/src/main/res/values/strings.xml"],
      });
    });

    it("should add new moduleConfig string to existing strings", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {
          string: {
            "@_name": "existing_key",
            "#text": "existing_value",
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);
      mockBuilder.build.mockReturnValue("new xml content");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await parser.set("test_key", "test_value");

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: [
            {
              "@_name": "existing_key",
              "#text": "existing_value",
            },
            {
              "@_name": "test_key",
              "@_moduleConfig": "true",
              "#text": "test_value",
            },
          ],
        },
      });
      expect(result).toEqual({
        paths: ["android/app/src/main/res/values/strings.xml"],
      });
    });

    it("should handle file read errors", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Read error"),
      );

      await expect(parser.set("test_key", "test_value")).rejects.toThrow(
        "Failed to parse or update strings.xml",
      );
    });

    it("should handle file write errors", async () => {
      const parser = new AndroidConfigParser([mockStringsXmlPath]);
      const mockXmlData = {
        resources: {},
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("xml content");
      mockParser.parse.mockReturnValue(mockXmlData);
      mockBuilder.build.mockReturnValue("new xml content");
      vi.mocked(fs.promises.writeFile).mockRejectedValue(
        new Error("Write error"),
      );

      await expect(parser.set("test_key", "test_value")).rejects.toThrow(
        "Failed to parse or update strings.xml",
      );
    });
  });
});
