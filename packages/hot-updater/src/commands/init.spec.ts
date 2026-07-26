import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendToProjectRootGitignore: vi.fn(() => false),
  ensureInstallPackages: vi.fn(),
  group: vi.fn(),
  makeEnv: vi.fn(),
  readHotUpdaterEnv: vi.fn(),
  runAwsInit: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    getHotUpdaterEnvValue: (
      env: Readonly<Record<string, string>>,
      key: string,
    ) => env[key],
    makeEnv: mocks.makeEnv,
    p: {
      ...actual.p,
      group: mocks.group,
      log: {
        ...actual.p.log,
        info: vi.fn(),
      },
    },
    readHotUpdaterEnv: mocks.readHotUpdaterEnv,
  };
});

vi.mock("@/utils/ensureInstallPackages", () => ({
  ensureInstallPackages: mocks.ensureInstallPackages,
}));

vi.mock("@/utils/git", () => ({
  appendToProjectRootGitignore: mocks.appendToProjectRootGitignore,
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

vi.mock("@hot-updater/aws/iac", () => ({
  runInit: mocks.runAwsInit,
}));

import { init } from "./init";

describe("init choices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureInstallPackages.mockResolvedValue(undefined);
    mocks.makeEnv.mockResolvedValue("");
    mocks.runAwsInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses saved build and provider without prompting", async () => {
    // Given
    mocks.readHotUpdaterEnv.mockResolvedValue({
      HOT_UPDATER_INIT_BUILD: "expo",
      HOT_UPDATER_INIT_PROVIDER: "aws",
    });

    // When
    await init();

    // Then
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.makeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_INIT_BUILD: "expo",
      HOT_UPDATER_INIT_PROVIDER: "aws",
    });
    expect(
      mocks.appendToProjectRootGitignore.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.makeEnv.mock.invocationCallOrder[0] ?? Infinity);
    expect(mocks.makeEnv.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureInstallPackages.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mocks.runAwsInit).toHaveBeenCalledWith({ build: "expo" });
  });

  it("collects missing build and provider in one prompt group", async () => {
    // Given
    mocks.readHotUpdaterEnv.mockResolvedValue({});
    mocks.group.mockResolvedValue({
      build: "bare",
      provider: "aws",
    });

    // When
    await init();

    // Then
    expect(mocks.group).toHaveBeenCalledOnce();
    expect(mocks.makeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_INIT_BUILD: "bare",
      HOT_UPDATER_INIT_PROVIDER: "aws",
    });
    expect(mocks.runAwsInit).toHaveBeenCalledWith({ build: "bare" });
  });
});
