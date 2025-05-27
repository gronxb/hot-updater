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

    it("should return empty object when android block is not found", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(
        'apply plugin: "com.android.application"',
      );

      const result = await androidParser.get("TEST_KEY");

      expect(result).toEqual({});
    });

    it("should correctly extract existing buildConfigField value", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "\\"test_value\\""
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toEqual({ default: "test_value" });
    });

    it("should return empty object for non-existent key", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("NONEXISTENT_KEY");

      expect(result).toEqual({});
    });

    it("should handle various quote formats", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField 'String', 'TEST_KEY', '\\"test_value\\"'
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toEqual({ default: "test_value" });
    });

    // BuildFlavor related tests
    it("should return flavor-specific values when productFlavors exist", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "\\"default_value\\""
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            buildConfigField "String", "TEST_KEY", "\\"dev_value\\""
        }
        prod {
            buildConfigField "String", "TEST_KEY", "\\"prod_value\\""
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toEqual({
        default: "default_value",
        dev: "dev_value",
        prod: "prod_value",
      });
    });

    it("should include default value and flavor overrides", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "\\"default_value\\""
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            buildConfigField "String", "TEST_KEY", "\\"dev_value\\""
        }
        prod {
            // No override for TEST_KEY
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toEqual({
        default: "default_value",
        dev: "dev_value",
      });
    });

    it("should return empty object when no flavor has the key and no default", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            applicationId "com.example.app.dev"
        }
        prod {
            applicationId "com.example.app"
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("NONEXISTENT_KEY");

      expect(result).toEqual({});
    });

    it("should handle empty productFlavors block", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "\\"default_value\\""
        applicationId "com.example.app"
    }
    productFlavors {
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const result = await androidParser.get("TEST_KEY");

      expect(result).toEqual({ default: "default_value" });
    });

    it("should handle complex flavor configurations", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "API_URL", "\\"https://default.api.com\\""
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            applicationId "com.example.app.dev"
            buildConfigField "String", "API_URL", "\\"https://dev.api.com\\""
            buildConfigField "String", "DEBUG_MODE", "\\"true\\""
        }
        staging {
            applicationId "com.example.app.staging"
            buildConfigField "String", "API_URL", "\\"https://staging.api.com\\""
        }
        prod {
            applicationId "com.example.app"
            buildConfigField "String", "API_URL", "\\"https://api.com\\""
            buildConfigField "String", "DEBUG_MODE", "\\"false\\""
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      const apiUrlResult = await androidParser.get("API_URL");
      const debugModeResult = await androidParser.get("DEBUG_MODE");

      expect(apiUrlResult).toEqual({
        default: "https://default.api.com",
        dev: "https://dev.api.com",
        staging: "https://staging.api.com",
        prod: "https://api.com",
      });

      expect(debugModeResult).toEqual({
        dev: "true",
        prod: "false",
      });
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

    it("should update existing buildConfigField in defaultConfig", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "\\"old_value\\""
        applicationId "com.example.app"
    }
}`;

      const expectedContent = `
android {
    defaultConfig {
        buildConfigField "String", "TEST_KEY", "\\"new_value\\""
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

    it("should add new buildConfigField to defaultConfig", async () => {
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
        'buildConfigField "String", "NEW_KEY", "\\"new_value\\""',
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

    // BuildFlavor related set tests with options
    it("should set buildConfigField in specific flavor using options", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            applicationId "com.example.app.dev"
        }
        prod {
            applicationId "com.example.app"
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await androidParser.set("TEST_KEY", "dev_value", { flavor: "dev" });

      const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
      const writtenContent = writeCall?.[1] as string;

      expect(writtenContent).toContain(
        'buildConfigField "String", "TEST_KEY", "\\"dev_value\\""',
      );
    });

    it("should update existing buildConfigField in specific flavor", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            applicationId "com.example.app.dev"
            buildConfigField "String", "TEST_KEY", "\\"old_dev_value\\""
        }
        prod {
            applicationId "com.example.app"
            buildConfigField "String", "TEST_KEY", "\\"old_prod_value\\""
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await androidParser.set("TEST_KEY", "new_dev_value", { flavor: "dev" });

      const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
      const writtenContent = writeCall?.[1] as string;

      expect(writtenContent).toContain(
        'buildConfigField "String", "TEST_KEY", "\\"new_dev_value\\""',
      );
      expect(writtenContent).toContain(
        'buildConfigField "String", "TEST_KEY", "\\"old_prod_value\\""',
      );
      expect(writtenContent).not.toContain("old_dev_value");
    });

    it("should throw error when trying to set flavor that doesn't exist", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
    productFlavors {
        dev {
            applicationId "com.example.app.dev"
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      await expect(
        androidParser.set("TEST_KEY", "value", { flavor: "nonexistent" }),
      ).rejects.toThrow("Flavor 'nonexistent' not found in productFlavors");
    });

    it("should throw error when productFlavors block not found but trying to set flavor", async () => {
      const buildGradleContent = `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      await expect(
        androidParser.set("TEST_KEY", "value", { flavor: "dev" }),
      ).rejects.toThrow(
        "productFlavors block not found but trying to set flavor value",
      );
    });

    it("should preserve indentation when adding fields to flavors", async () => {
      const buildGradleContent = `
android {
    productFlavors {
        dev {
            applicationId "com.example.app.dev"
            versionNameSuffix "-dev"
        }
    }
}`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await androidParser.set("TEST_KEY", "dev_value", { flavor: "dev" });

      const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
      const writtenContent = writeCall?.[1] as string;
      const lines = writtenContent.split("\n");

      const newFieldLine = lines.find((line) => line.includes("TEST_KEY"));
      const existingFieldLine = lines.find((line) =>
        line.includes("versionNameSuffix"),
      );

      // Both lines should have the same indentation
      expect(newFieldLine?.match(/^(\s*)/)?.[1]).toBe(
        existingFieldLine?.match(/^(\s*)/)?.[1],
      );
    });
  });
});

// Error handling tests
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

    it("should propagate error when file reading fails", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        new Error("Permission denied"),
      );

      await expect(androidParser.get("TEST_KEY")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("should propagate error when file writing fails", async () => {
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

    it("should handle malformed productFlavors block gracefully", async () => {
      const malformedContent = `
  android {
      defaultConfig {
          applicationId "com.example.app"
      }
      productFlavors {
          dev {
              // Missing closing brace
          prod {
              applicationId "com.example.app"
          }
      }
  }`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(malformedContent);

      // Should not throw error, but may return unexpected results
      const result = await androidParser.get("TEST_KEY");
      expect(result).toBeDefined();
    });

    it("should handle setting flavors when productFlavors block exists but is empty", async () => {
      const buildGradleContent = `
  android {
      defaultConfig {
          applicationId "com.example.app"
      }
      productFlavors {
          // Empty block
      }
  }`;

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

      // Should not add anything since dev flavor doesn't exist
      await expect(
        androidParser.set("TEST_KEY", "dev_value", { flavor: "dev" }),
      ).rejects.toThrow("Flavor 'dev' not found in productFlavors");
    });
  });
});

// BuildFlavor specific edge cases
describe("BuildFlavor Edge Cases", () => {
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

  it("should handle nested flavor configurations", async () => {
    const buildGradleContent = `
  android {
      defaultConfig {
          buildConfigField "String", "BASE_URL", "\\"https://api.example.com\\""
      }
      productFlavors {
          free {
              dimension "version"
              buildConfigField "String", "FEATURE_FLAG", "\\"basic\\""
          }
          premium {
              dimension "version"
              buildConfigField "String", "FEATURE_FLAG", "\\"advanced\\""
          }
          dev {
              dimension "environment"
              buildConfigField "String", "BASE_URL", "\\"https://dev.api.example.com\\""
          }
          prod {
              dimension "environment"
              buildConfigField "String", "BASE_URL", "\\"https://api.example.com\\""
          }
      }
  }`;

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

    const baseUrlResult = await androidParser.get("BASE_URL");
    const featureFlagResult = await androidParser.get("FEATURE_FLAG");

    expect(baseUrlResult).toEqual({
      default: "https://api.example.com",
      dev: "https://dev.api.example.com",
      prod: "https://api.example.com",
    });

    expect(featureFlagResult).toEqual({
      free: "basic",
      premium: "advanced",
    });
  });

  it("should handle flavors with complex syntax", async () => {
    const buildGradleContent = `
  android {
      defaultConfig {
          buildConfigField "String", "APP_NAME", "\\"MyApp\\""
      }
      productFlavors {
          demo {
              applicationIdSuffix ".demo"
              versionNameSuffix "-demo"
              buildConfigField "String", "APP_NAME", "\\"MyApp Demo\\""
              buildConfigField "String", "SERVER_URL", "\\"https://demo.server.com\\""
              resValue "string", "app_name", "MyApp Demo"
          }
          full {
              buildConfigField "String", "APP_NAME", "\\"MyApp Full\\""
              buildConfigField "String", "SERVER_URL", "\\"https://full.server.com\\""
              proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
          }
      }
  }`;

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);

    const appNameResult = await androidParser.get("APP_NAME");
    const serverUrlResult = await androidParser.get("SERVER_URL");

    expect(appNameResult).toEqual({
      default: "MyApp",
      demo: "MyApp Demo",
      full: "MyApp Full",
    });

    expect(serverUrlResult).toEqual({
      demo: "https://demo.server.com",
      full: "https://full.server.com",
    });
  });

  it("should handle updating specific field in complex flavor", async () => {
    const buildGradleContent = `
  android {
      defaultConfig {
          applicationId "com.example.app"
      }
      productFlavors {
          dev {
              applicationIdSuffix ".dev"
              buildConfigField "String", "API_KEY", "\\"dev_key_123\\""
              buildConfigField "String", "DEBUG_MODE", "\\"true\\""
              resValue "string", "app_name", "App Dev"
          }
      }
  }`;

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue(buildGradleContent);
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

    await androidParser.set("API_KEY", "new_dev_key_456", { flavor: "dev" });

    const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
    const writtenContent = writeCall?.[1] as string;

    expect(writtenContent).toContain(
      'buildConfigField "String", "API_KEY", "\\"new_dev_key_456\\""',
    );
    expect(writtenContent).not.toContain("dev_key_123");
    // Other fields should remain unchanged
    expect(writtenContent).toContain(
      'buildConfigField "String", "DEBUG_MODE", "\\"true\\""',
    );
    expect(writtenContent).toContain(
      'resValue "string", "app_name", "App Dev"',
    );
  });
});
