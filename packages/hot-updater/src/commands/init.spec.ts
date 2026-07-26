import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendToProjectRootGitignore: vi.fn(() => false),
  ensureInstallPackages: vi.fn(),
  group: vi.fn(),
  makeEnv: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
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
        error: vi.fn(),
        info: vi.fn(),
      },
    },
    readHotUpdaterInitEnv: mocks.readHotUpdaterInitEnv,
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
    process.exitCode = undefined;
    mocks.ensureInstallPackages.mockResolvedValue(undefined);
    mocks.makeEnv.mockResolvedValue("");
    mocks.runAwsInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("reuses saved build and provider without prompting", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_INIT_BUILD: "expo",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
      inputEnv: {},
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
    expect(mocks.runAwsInit).toHaveBeenCalledWith({
      build: "expo",
      envFile: undefined,
    });
  });

  it("collects missing build and provider in one prompt group", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      inputEnv: {},
    });
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
    expect(mocks.runAwsInit).toHaveBeenCalledWith({
      build: "bare",
      envFile: undefined,
    });
  });

  it("stops before prompting when the init env file is incomplete", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      inputEnv: {},
    });

    // When
    await init({ envFile: "init.env" });

    // Then
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.appendToProjectRootGitignore).not.toHaveBeenCalled();
    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.ensureInstallPackages).not.toHaveBeenCalled();
    expect(mocks.runAwsInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("passes the init env file to the selected provider", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_INIT_BUILD: "expo",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
      inputEnv: {
        HOT_UPDATER_INIT_BUILD: "expo",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
    });

    // When
    await init({ envFile: "init.env" });

    // Then
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.runAwsInit).toHaveBeenCalledWith({
      build: "expo",
      envFile: "init.env",
    });
  });
});
