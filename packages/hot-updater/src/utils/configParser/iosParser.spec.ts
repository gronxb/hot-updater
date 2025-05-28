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
    it("should return undefined when plist file not found", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toBeUndefined();
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

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("TEST_KEY");

      expect(result).toBe("test_value");
      expect(plist.parse).toHaveBeenCalledWith(mockPlistContent);
    });

    it("should return undefined for non-existent key", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict></dict></plist>';
      const mockPlistObject = {};

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("NONEXISTENT_KEY");

      expect(result).toBeUndefined();
    });

    it("should handle numeric values from plist", async () => {
      const mockPlistObject = { PORT: 3000 };

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("PORT");

      expect(result).toBe("3000");
    });

    it("should handle boolean values from plist", async () => {
      const mockPlistObject = { DEBUG_MODE: true };

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);

      const result = await iosParser.get("DEBUG_MODE");

      expect(result).toBe("true");
    });

    it("should handle Info.plist read errors gracefully", async () => {
      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      const result = await iosParser.get("TEST_KEY");

      expect(result).toBeUndefined();
    });
  });

  describe("set", () => {
    it("should throw error when plist file not found", async () => {
      vi.mocked(globby).mockResolvedValue([]);

      await expect(iosParser.set("TEST_KEY", "test_value")).rejects.toThrow(
        "Info.plist not found",
      );
    });

    it("should set value directly in Info.plist", async () => {
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

    it("should update existing value in Info.plist", async () => {
      const mockPlistContent =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>old_value</string></dict></plist>';
      const mockPlistObject = { TEST_KEY: "old_value" };
      const newPlistXml =
        '<?xml version="1.0"?><plist><dict><key>TEST_KEY</key><string>new_value</string></dict></plist>';

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
      vi.mocked(fs.promises.readFile).mockResolvedValue(mockPlistContent);
      vi.mocked(plist.parse).mockReturnValue(mockPlistObject);
      vi.mocked(plist.build).mockReturnValue(newPlistXml);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await iosParser.set("TEST_KEY", "new_value");

      expect(mockPlistObject).toEqual({ TEST_KEY: "new_value" });
      expect(result.path).toBe("ios/TestApp/Info.plist");
    });

    it("should preserve existing keys when setting new value", async () => {
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

    it("should handle plist parse errors", async () => {
      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
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

      vi.mocked(globby).mockResolvedValue([mockPlistPath]);
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
  });
});
