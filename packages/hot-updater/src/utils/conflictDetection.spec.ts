import { getPackageManager, p } from "@hot-updater/cli-tools";
import fs from "fs";
import Module from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  let originalResolveFilename: any;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    // Save original _resolveFilename
    originalResolveFilename = (Module as any)._resolveFilename;
  });

  afterEach(() => {
    // Restore original _resolveFilename
    (Module as any)._resolveFilename = originalResolveFilename;
    vi.restoreAllMocks();
  });

  describe("hasExpoUpdates", () => {
    it("returns true when expo-updates is resolvable via require.resolve", async () => {
      // Mock Module._resolveFilename to succeed for expo-updates
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          return "/mock/path/expo-updates/package.json";
        }
        return originalResolveFilename(request);
      });

      const { hasExpoUpdates } = await import("./conflictDetection");

      expect(hasExpoUpdates()).toBe(true);
    });

    it("returns true if expo-updates is in dependencies (fallback check)", async () => {
      // Mock Module._resolveFilename to fail (package not resolvable)
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          throw new Error("Cannot find module");
        }
        return originalResolveFilename(request);
      });

      // Mock package.json check as fallback
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: {
            "expo-updates": "1.0.0",
          },
        }),
      );

      const { hasExpoUpdates } = await import("./conflictDetection");

      expect(hasExpoUpdates()).toBe(true);
    });

    it("returns true if expo-updates is in devDependencies (fallback check)", async () => {
      // Mock Module._resolveFilename to fail
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          throw new Error("Cannot find module");
        }
        return originalResolveFilename(request);
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          devDependencies: {
            "expo-updates": "1.0.0",
          },
        }),
      );

      const { hasExpoUpdates } = await import("./conflictDetection");

      expect(hasExpoUpdates()).toBe(true);
    });

    it("returns false if expo-updates is not resolvable and missing from package.json", async () => {
      // Mock Module._resolveFilename to fail
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          throw new Error("Cannot find module");
        }
        return originalResolveFilename(request);
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: {
            react: "18.0.0",
          },
        }),
      );

      const { hasExpoUpdates } = await import("./conflictDetection");

      expect(hasExpoUpdates()).toBe(false);
    });

    it("returns false if require.resolve fails and package.json is missing", async () => {
      // Mock Module._resolveFilename to fail
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          throw new Error("Cannot find module");
        }
        return originalResolveFilename(request);
      });

      vi.mocked(fs.existsSync).mockReturnValue(false);

      const { hasExpoUpdates } = await import("./conflictDetection");

      expect(hasExpoUpdates()).toBe(false);
    });
  });

  describe("ensureNoConflicts", () => {
    it("exits process if conflict detected via require.resolve", async () => {
      // Mock Module._resolveFilename to succeed (expo-updates is installed)
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          return "/mock/path/expo-updates/package.json";
        }
        return originalResolveFilename(request);
      });

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as any);

      const { ensureNoConflicts } = await import("./conflictDetection");

      ensureNoConflicts();

      expect(p.log.error).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("does not exit if no conflict", async () => {
      // Mock Module._resolveFilename to fail (expo-updates not installed)
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          throw new Error("Cannot find module");
        }
        return originalResolveFilename(request);
      });

      // Mock package.json to not have expo-updates
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dependencies: {},
        }),
      );

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as any);

      const { ensureNoConflicts } = await import("./conflictDetection");

      ensureNoConflicts();

      expect(p.log.error).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("shows correct removal command for npm", async () => {
      vi.mocked(getPackageManager).mockReturnValue("npm");

      // Mock Module._resolveFilename to succeed
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          return "/mock/path/expo-updates/package.json";
        }
        return originalResolveFilename(request);
      });

      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { ensureNoConflicts } = await import("./conflictDetection");

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("npm uninstall expo-updates"),
      );
    });

    it("shows correct removal command for yarn", async () => {
      vi.mocked(getPackageManager).mockReturnValue("yarn");

      // Mock Module._resolveFilename to succeed
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          return "/mock/path/expo-updates/package.json";
        }
        return originalResolveFilename(request);
      });

      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { ensureNoConflicts } = await import("./conflictDetection");

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("yarn remove expo-updates"),
      );
    });

    it("shows correct removal command for pnpm", async () => {
      vi.mocked(getPackageManager).mockReturnValue("pnpm");

      // Mock Module._resolveFilename to succeed
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          return "/mock/path/expo-updates/package.json";
        }
        return originalResolveFilename(request);
      });

      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { ensureNoConflicts } = await import("./conflictDetection");

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("pnpm remove expo-updates"),
      );
    });

    it("shows correct removal command for bun", async () => {
      vi.mocked(getPackageManager).mockReturnValue("bun");

      // Mock Module._resolveFilename to succeed
      (Module as any)._resolveFilename = vi.fn((request: string) => {
        if (request === "expo-updates/package.json") {
          return "/mock/path/expo-updates/package.json";
        }
        return originalResolveFilename(request);
      });

      vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      const { ensureNoConflicts } = await import("./conflictDetection");

      ensureNoConflicts();

      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("bun remove expo-updates"),
      );
    });
  });
});
