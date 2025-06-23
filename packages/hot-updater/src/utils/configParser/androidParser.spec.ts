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
  let androidParser: AndroidConfigParser;
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

    androidParser = new AndroidConfigParser();
  });

  describe("exists", () => {
    it("should return true when strings.xml exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = await androidParser.exists();

      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(mockStringsXmlPath);
    });

    it("should return false when strings.xml does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await androidParser.exists();

      expect(result).toBe(false);
    });
  });

  describe("get", () => {
    it("should return null value and path when file does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await androidParser.get("test_key");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should return null value when no string elements exist", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {},
      });

      const result = await androidParser.get("test_key");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should return object with value and path for existing moduleConfig string (single element)", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string moduleConfig="true" name="hot_updater_channel">dev</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: {
            "@_name": "hot_updater_channel",
            "@_moduleConfig": "true",
            "#text": "dev",
          },
        },
      });

      const result = await androidParser.get("hot_updater_channel");

      expect(result).toEqual({
        value: "dev",
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should return object with value and path for existing moduleConfig string (multiple elements)", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">MyApp</string>
    <string moduleConfig="true" name="hot_updater_channel">dev</string>
    <string moduleConfig="true" name="api_url">https://dev.api.com</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: [
            {
              "@_name": "app_name",
              "#text": "MyApp",
            },
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "dev",
            },
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://dev.api.com",
            },
          ],
        },
      });

      const result = await androidParser.get("hot_updater_channel");

      expect(result).toEqual({
        value: "dev",
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should return null value for non-existent key", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string moduleConfig="true" name="other_key">other_value</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: {
            "@_name": "other_key",
            "@_moduleConfig": "true",
            "#text": "other_value",
          },
        },
      });

      const result = await androidParser.get("nonexistent_key");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should ignore strings without moduleConfig attribute", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">MyApp</string>
    <string name="hot_updater_channel">dev</string>
    <string moduleConfig="true" name="api_url">https://api.com</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: [
            {
              "@_name": "app_name",
              "#text": "MyApp",
            },
            {
              "@_name": "hot_updater_channel",
              "#text": "dev",
            },
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://api.com",
            },
          ],
        },
      });

      const result = await androidParser.get("hot_updater_channel");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should ignore strings with moduleConfig=false", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string moduleConfig="false" name="hot_updater_channel">dev</string>
    <string moduleConfig="true" name="api_url">https://api.com</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: [
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "false",
              "#text": "dev",
            },
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://api.com",
            },
          ],
        },
      });

      const result = await androidParser.get("hot_updater_channel");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should handle XML parsing errors gracefully", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid xml");
      mockParser.parse.mockImplementation(() => {
        throw new Error("Invalid XML");
      });

      const result = await androidParser.get("test_key");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should handle file read errors gracefully", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      const result = await androidParser.get("test_key");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should trim whitespace from text content", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      mockParser.parse.mockReturnValue({
        resources: {
          string: {
            "@_name": "test_key",
            "@_moduleConfig": "true",
            "#text": "  value with spaces  ",
          },
        },
      });

      const result = await androidParser.get("test_key");

      expect(result).toEqual({
        value: "value with spaces",
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should handle missing text content", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("");
      mockParser.parse.mockReturnValue({
        resources: {
          string: {
            "@_name": "test_key",
            "@_moduleConfig": "true",
            // no #text property
          },
        },
      });

      const result = await androidParser.get("test_key");

      expect(result).toEqual({
        value: null,
        path: "android/app/src/main/res/values/strings.xml",
      });
    });
  });

  describe("set", () => {
    it("should return empty path when file does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await androidParser.set("test_key", "test_value");

      expect(result).toEqual({ path: null });
    });

    it("should update existing moduleConfig string", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string moduleConfig="true" name="hot_updater_channel">old_value</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: {
            "@_name": "hot_updater_channel",
            "@_moduleConfig": "true",
            "#text": "old_value",
          },
        },
      });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string moduleConfig="true" name="hot_updater_channel">new_value</string>\n</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await androidParser.set(
        "hot_updater_channel",
        "new_value",
      );

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: {
            "@_name": "hot_updater_channel",
            "@_moduleConfig": "true",
            "#text": "new_value",
          },
        },
      });
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        mockStringsXmlPath,
        expect.stringContaining("new_value"),
        "utf-8",
      );
      expect(result).toEqual({
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should add new moduleConfig string to existing resources", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">MyApp</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: {
            "@_name": "app_name",
            "#text": "MyApp",
          },
        },
      });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">MyApp</string>\n    <string moduleConfig="true" name="hot_updater_channel">dev</string>\n</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await androidParser.set("hot_updater_channel", "dev");

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: [
            {
              "@_name": "app_name",
              "#text": "MyApp",
            },
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "dev",
            },
          ],
        },
      });
      expect(result).toEqual({
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should handle empty resources (no string elements)", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {},
      });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string moduleConfig="true" name="hot_updater_channel">dev</string>\n</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await androidParser.set("hot_updater_channel", "dev");

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: {
            "@_name": "hot_updater_channel",
            "@_moduleConfig": "true",
            "#text": "dev",
          },
        },
      });
      expect(result).toEqual({
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should update correct string when multiple moduleConfig strings exist", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string moduleConfig="true" name="api_url">https://api.com</string>
    <string moduleConfig="true" name="hot_updater_channel">old_value</string>
    <string moduleConfig="true" name="debug_mode">true</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: [
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://api.com",
            },
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "old_value",
            },
            {
              "@_name": "debug_mode",
              "@_moduleConfig": "true",
              "#text": "true",
            },
          ],
        },
      });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>...</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await androidParser.set(
        "hot_updater_channel",
        "new_value",
      );

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: [
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://api.com",
            },
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "new_value",
            },
            {
              "@_name": "debug_mode",
              "@_moduleConfig": "true",
              "#text": "true",
            },
          ],
        },
      });
      expect(result).toEqual({
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should preserve non-moduleConfig strings when adding new moduleConfig string", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">MyApp</string>
    <string name="normal_string">Normal Value</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: [
            {
              "@_name": "app_name",
              "#text": "MyApp",
            },
            {
              "@_name": "normal_string",
              "#text": "Normal Value",
            },
          ],
        },
      });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>...</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await androidParser.set("hot_updater_channel", "dev");

      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: [
            {
              "@_name": "app_name",
              "#text": "MyApp",
            },
            {
              "@_name": "normal_string",
              "#text": "Normal Value",
            },
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "dev",
            },
          ],
        },
      });
      expect(result).toEqual({
        path: "android/app/src/main/res/values/strings.xml",
      });
    });

    it("should handle XML parsing errors", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("invalid xml");
      mockParser.parse.mockImplementation(() => {
        throw new Error("Invalid XML format");
      });

      await expect(androidParser.set("test_key", "test_value")).rejects.toThrow(
        "Failed to parse or update strings.xml: Error: Invalid XML format",
      );
    });

    it("should handle file write errors", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        "<resources></resources>",
      );
      mockParser.parse.mockReturnValue({ resources: {} });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>...</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(androidParser.set("test_key", "test_value")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should handle array to single object conversion correctly", async () => {
      const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string moduleConfig="true" name="hot_updater_channel">old_value</string>
    <string moduleConfig="true" name="api_url">https://api.com</string>
</resources>`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(xmlContent);
      mockParser.parse.mockReturnValue({
        resources: {
          string: [
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "old_value",
            },
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://api.com",
            },
          ],
        },
      });
      mockBuilder.build.mockReturnValue(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>...</resources>',
      );
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await androidParser.set("hot_updater_channel", "new_value");

      // Should keep as array since length > 1
      expect(mockBuilder.build).toHaveBeenCalledWith({
        resources: {
          string: [
            {
              "@_name": "hot_updater_channel",
              "@_moduleConfig": "true",
              "#text": "new_value",
            },
            {
              "@_name": "api_url",
              "@_moduleConfig": "true",
              "#text": "https://api.com",
            },
          ],
        },
      });
    });
  });
});
