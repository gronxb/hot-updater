import { readPackageUp } from "read-package-up";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { areVersionsCompatible, doctor } from "./doctor";

vi.mock("read-package-up", () => ({
  readPackageUp: vi.fn(),
}));

vi.mock("@hot-updater/plugin-core", () => ({
  getCwd: vi.fn(() => "/mock/cwd"),
}));

describe("areVersionsCompatible", () => {
  // Test cases for exact matches
  it("should return true for exact version matches", () => {
    expect(areVersionsCompatible("1.0.0", "1.0.0")).toBe(true);
  });

  it("should return true for exact range matches", () => {
    expect(areVersionsCompatible("^1.0.0", "^1.0.0")).toBe(true);
  });

  // Test cases for version satisfying range
  it("should return true when versionA satisfies versionB range", () => {
    expect(areVersionsCompatible("1.0.1", "^1.0.0")).toBe(true);
    expect(areVersionsCompatible("0.18.2", "^0.18.0")).toBe(true);
    expect(areVersionsCompatible("1.2.5", "~1.2.0")).toBe(true);
    expect(areVersionsCompatible("1.2.3", "1.2.x")).toBe(true);
    expect(areVersionsCompatible("1.0.0-alpha.1", "^1.0.0-alpha")).toBe(true);
    expect(areVersionsCompatible("0.18.0", "^0.18.0")).toBe(true);
  });

  it("should return true when versionB satisfies versionA range", () => {
    expect(areVersionsCompatible("^1.0.0", "1.0.1")).toBe(true);
    expect(areVersionsCompatible("^0.18.0", "0.18.2")).toBe(true);
    expect(areVersionsCompatible("~1.2.0", "1.2.5")).toBe(true);
    expect(areVersionsCompatible("1.2.x", "1.2.3")).toBe(true);
    expect(areVersionsCompatible("^1.0.0-alpha", "1.0.0-alpha.1")).toBe(true);
    expect(areVersionsCompatible("^0.18.0", "0.18.0")).toBe(true);
  });

  // Test cases for non-compatible versions/ranges
  it("should return false for non-compatible versions", () => {
    expect(areVersionsCompatible("1.0.0", "1.0.1")).toBe(false);
  });

  it("should return false when versionA does not satisfy versionB range", () => {
    expect(areVersionsCompatible("2.0.0", "^1.0.0")).toBe(false);
    expect(areVersionsCompatible("0.17.0", "^0.18.0")).toBe(false);
    expect(areVersionsCompatible("1.0.0-alpha", "^1.0.0-beta")).toBe(false);
  });

  it("should return false when versionB does not satisfy versionA range", () => {
    expect(areVersionsCompatible("^2.0.0", "1.0.0")).toBe(false);
    expect(areVersionsCompatible("^0.17.0", "0.18.0")).toBe(false);
  });

  // Test cases with invalid version/range strings
  it("should return false for invalid version or range strings", () => {
    expect(areVersionsCompatible("invalid-version", "1.0.0")).toBe(false);
    expect(areVersionsCompatible("1.0.0", "invalid-range")).toBe(false);
    expect(areVersionsCompatible("latest", "1.0.0")).toBe(false);
    expect(areVersionsCompatible("1.0.0", "latest")).toBe(false);
    expect(areVersionsCompatible("invalid", "invalid")).toBe(true);
  });

  it("should handle complex range comparisons correctly", () => {
    expect(areVersionsCompatible("1.2.3", ">=1.0.0 <2.0.0")).toBe(true);
    expect(areVersionsCompatible(">=1.0.0 <2.0.0", "1.2.3")).toBe(true);
    expect(areVersionsCompatible("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(areVersionsCompatible(">=1.0.0 <2.0.0", "2.0.0")).toBe(false);
  });

  it("should handle pre-releases correctly with ranges", () => {
    expect(areVersionsCompatible("1.0.0-beta.1", "^1.0.0-alpha.1")).toBe(true);
    expect(areVersionsCompatible("^1.0.0-alpha.1", "1.0.0-beta.1")).toBe(true);
    expect(areVersionsCompatible("1.0.0", "^1.0.0-alpha.1")).toBe(true);
    expect(areVersionsCompatible("^1.0.0-alpha.1", "1.0.0")).toBe(true);
    expect(areVersionsCompatible("2.0.0-alpha.1", "^1.0.0")).toBe(false);
  });
});

describe("doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true for a healthy setup", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
          "@hot-updater/core": "^0.18.2",
          "@hot-updater/react-native": "^0.18.2",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toBe(true);
  });

  it("should return true for a healthy setup", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.18.2",
          "@hot-updater/core": "^0.18.2",
          "@hot-updater/react-native": "^0.18.2",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toBe(true);
  });

  it("should return true for a healthy setup", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
          "@hot-updater/core": "0.18.2",
          "@hot-updater/react-native": "0.18.2",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toBe(true);
  });

  it("should return true for a healthy setup", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
          "@hot-updater/core": "0.17.0",
          "@hot-updater/react-native": "0.17.0",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toEqual({
      details: {
        hotUpdaterVersion: "^0.18.2",
        installedHotUpdaterPackages: [
          "@hot-updater/core",
          "@hot-updater/react-native",
        ],
        packageJsonPath: "/mock/cwd/package.json",
        versionMismatches: [
          {
            currentVersion: "0.17.0",
            expectedVersion: "^0.18.2",
            packageName: "@hot-updater/core",
          },
          {
            currentVersion: "0.17.0",
            expectedVersion: "^0.18.2",
            packageName: "@hot-updater/react-native",
          },
        ],
      },
      success: false,
    });
  });

  it("should return true for a healthy setup", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^1.0.0",
          "@hot-updater/core": "1.0.1",
          "@hot-updater/plugin-react-native": "1.0.5",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toBe(true);
  });

  it("should return an error if package.json is not found", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await doctor();
    expect(result).toEqual({
      success: false,
      error: "Could not find package.json",
    });
  });

  it("should return an error if hot-updater CLI is not found", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "@hot-updater/core": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toEqual({
      success: false,
      error: "hot-updater CLI not found. Please install it first.",
    });
  });

  it("should detect version mismatches", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^1.0.0",
          "@hot-updater/core": "2.0.0",
          "@hot-updater/plugin-A": "1.0.1",
        },
        devDependencies: {
          "@hot-updater/plugin-B": "0.9.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toEqual({
      success: false,
      details: {
        hotUpdaterVersion: "^1.0.0",
        packageJsonPath: "/mock/cwd/package.json",
        installedHotUpdaterPackages: [
          "@hot-updater/core",
          "@hot-updater/plugin-A",
          "@hot-updater/plugin-B",
        ],
        versionMismatches: [
          {
            packageName: "@hot-updater/core",
            currentVersion: "2.0.0",
            expectedVersion: "^1.0.0",
          },
          {
            packageName: "@hot-updater/plugin-B",
            currentVersion: "0.9.0",
            expectedVersion: "^1.0.0",
          },
        ],
      },
    });
  });

  it("should return true if only hot-updater CLI is present and no other @hot-updater packages", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toBe(true);
  });

  it("should handle empty dependencies and devDependencies", async () => {
    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const result = await doctor();
    expect(result).toBe(true);

    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {
        devDependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const result2 = await doctor();
    expect(result2).toBe(true);

    (readPackageUp as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageJson: {},
      path: "/mock/cwd/package.json",
    });
    const result3 = await doctor();
    expect(result3).toEqual({
      success: false,
      error: "hot-updater CLI not found. Please install it first.",
    });
  });
});
