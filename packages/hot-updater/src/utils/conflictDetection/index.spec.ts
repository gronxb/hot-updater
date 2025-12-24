import { getPackageManager, p } from "@hot-updater/cli-tools";
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureNoConflicts, hasExpoUpdates } from "./index";

// Mock dependencies
vi.mock("fs");
vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getCwd: vi.fn(() => "/mock/cwd"),
    getPackageManager: vi.fn(() => "npm"),
    p: {
      log: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
      },
    },
  };
});

describe("conflictDetection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("hasExpoUpdates", () => {
    it("returns true if expo-updates is in dependencies", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: {
            "expo-updates": "1.0.0",
          },
        }),
      );

      expect(hasExpoUpdates()).toBe(true);
    });

    it("returns true if expo-updates is in devDependencies", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          devDependencies: {
            "expo-updates": "1.0.0",
          },
        }),
      );

      expect(hasExpoUpdates()).toBe(true);
    });

    it("returns false if expo-updates is missing", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: {
            react: "18.0.0",
          },
        }),
      );

      expect(hasExpoUpdates()).toBe(false);
    });

    it("returns false if package.json is missing", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(hasExpoUpdates()).toBe(false);
    });
  });

  describe("ensureNoConflicts", () => {
    it("exits process if conflict detected", () => {
      // Setup conflict
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: { "expo-updates": "1.0.0" },
        }),
      );

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as any);

      ensureNoConflicts();

      expect(p.log.error).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("does not exit if no conflict", () => {
      // Setup no conflict
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: {},
        }),
      );

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as any);

      ensureNoConflicts();

      expect(p.log.error).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("shows correct removal command for npm", () => {
      vi.mocked(getPackageManager).mockReturnValue("npm");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: { "expo-updates": "1.0.0" },
        }),
      );
      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("npm uninstall expo-updates"),
      );
    });

    it("shows correct removal command for yarn", () => {
      vi.mocked(getPackageManager).mockReturnValue("yarn");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: { "expo-updates": "1.0.0" },
        }),
      );
      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("yarn remove expo-updates"),
      );
    });

    it("shows correct removal command for pnpm", () => {
      vi.mocked(getPackageManager).mockReturnValue("pnpm");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: { "expo-updates": "1.0.0" },
        }),
      );
      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("pnpm remove expo-updates"),
      );
    });

    it("shows correct removal command for bun", () => {
      vi.mocked(getPackageManager).mockReturnValue("bun");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: { "expo-updates": "1.0.0" },
        }),
      );
      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("bun remove expo-updates"),
      );
    });
  });
});
