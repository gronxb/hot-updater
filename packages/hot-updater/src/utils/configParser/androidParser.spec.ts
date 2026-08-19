import fs from "fs";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AndroidConfigParser } from "./androidParser";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      promises: {
        ...actual.promises,
        readFile: vi.fn(),
        writeFile: vi.fn(),
      },
    },
    existsSync: vi.fn(),
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
  };
});

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return {
    ...actual,
    default: {
      ...actual,
      join: vi.fn(),
      relative: vi.fn(),
      isAbsolute: vi.fn(),
    },
    join: vi.fn(),
    relative: vi.fn(),
    isAbsolute: vi.fn(),
  };
});

vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: vi.fn(),
}));

vi.mock("fast-xml-parser", () => ({
  XMLParser: vi.fn(),
  XMLBuilder: vi.fn(),
}));

describe("AndroidConfigParser", () => {
  let mockParser: { parse: ReturnType<typeof vi.fn> };
  let mockBuilder: { build: ReturnType<typeof vi.fn> };
  const mockAndroidManifestPath =
    "/mock/project/android/app/src/main/AndroidManifest.xml";

  beforeEach(() => {
    vi.clearAllMocks();

    mockParser = { parse: vi.fn() };
    mockBuilder = { build: vi.fn() };

    vi.mocked(XMLParser).mockImplementation(function XMLParser() {
      return mockParser;
    });
    vi.mocked(XMLBuilder).mockImplementation(function XMLBuilder() {
      return mockBuilder;
    });

    vi.mocked(getCwd).mockReturnValue("/mock/project");
    vi.mocked(path.join).mockImplementation((...args) => args.join("/"));
    vi.mocked(path.relative).mockImplementation((from, to) =>
      to.replace(`${from}/`, ""),
    );
    vi.mocked(path.isAbsolute).mockImplementation((p) => p.startsWith("/"));
  });

  describe("exists", () => {
    it("returns false when no paths are provided", async () => {
      const parser = new AndroidConfigParser();
      await expect(parser.exists()).resolves.toBe(false);
    });

    it("returns true when an AndroidManifest.xml exists", async () => {
      const parser = new AndroidConfigParser([
        "android/app/src/main/AndroidManifest.xml",
      ]);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await expect(parser.exists()).resolves.toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith(mockAndroidManifestPath);
    });
  });

  describe("get", () => {
    it("returns null when no files exist", async () => {
      const parser = new AndroidConfigParser([
        "android/app/src/main/AndroidManifest.xml",
      ]);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(parser.get("hot_updater_channel")).resolves.toEqual({
        value: null,
        paths: [],
      });
    });

    it("reads Hot Updater keys from AndroidManifest metadata", async () => {
      const parser = new AndroidConfigParser([mockAndroidManifestPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("manifest content");
      mockParser.parse.mockReturnValue({
        manifest: {
          application: {
            "meta-data": {
              "@_android:name": "com.hotupdater.CHANNEL",
              "@_android:value": "production",
            },
          },
        },
      });

      await expect(parser.get("hot_updater_channel")).resolves.toEqual({
        value: "production",
        paths: ["android/app/src/main/AndroidManifest.xml"],
      });
    });

    it("does not read unmapped keys", async () => {
      const parser = new AndroidConfigParser([mockAndroidManifestPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await expect(parser.get("test_key")).resolves.toEqual({
        value: null,
        paths: [],
      });
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });
  });

  describe("set", () => {
    it("writes Hot Updater keys to AndroidManifest metadata", async () => {
      const parser = new AndroidConfigParser([mockAndroidManifestPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.promises.readFile).mockResolvedValue("manifest content");
      mockParser.parse.mockReturnValue({
        manifest: {
          application: {
            "meta-data": {
              "@_android:name": "existing_key",
              "@_android:value": "existing_value",
            },
          },
        },
      });
      mockBuilder.build.mockReturnValue("new xml content");
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      await expect(
        parser.set("hot_updater_channel", "production"),
      ).resolves.toEqual({
        paths: ["android/app/src/main/AndroidManifest.xml"],
      });
      expect(mockBuilder.build).toHaveBeenCalledWith({
        manifest: {
          application: {
            "meta-data": [
              {
                "@_android:name": "existing_key",
                "@_android:value": "existing_value",
              },
              {
                "@_android:name": "com.hotupdater.CHANNEL",
                "@_android:value": "production",
              },
            ],
          },
        },
      });
    });

    it("does not write unmapped keys", async () => {
      const parser = new AndroidConfigParser([mockAndroidManifestPath]);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await expect(parser.set("test_key", "test_value")).resolves.toEqual({
        paths: [],
      });
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });
  });
});
