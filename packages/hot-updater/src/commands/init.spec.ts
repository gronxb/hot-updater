import { InitError } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendToProjectRootGitignore: vi.fn(() => false),
  ensureInstallPackages: vi.fn(),
  group: vi.fn(),
  isProjectFileTracked: vi.fn(() => false),
  logError: vi.fn(),
  makeEnv: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
  runAwsInit: vi.fn(),
  runSupabaseInit: vi.fn(),
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
        error: mocks.logError,
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
  isProjectFileTracked: mocks.isProjectFileTracked,
}));

vi.mock("@/utils/printBanner", () => ({
  printBanner: vi.fn(),
}));

// Each provider's ./init, with its definition and a stand-in for its init.
vi.mock("@hot-updater/aws/init", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/aws/init")>()),
  runInit: mocks.runAwsInit,
}));

vi.mock("@hot-updater/supabase/init", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/supabase/init")>()),
  runInit: mocks.runSupabaseInit,
}));

import { packageJsonData } from "../packageJson";
import { init } from "./init";
import {
  INIT_PROVIDER_PACKAGES,
  type InitProviderModule,
  otherServerDefinitionsOf,
} from "./initProviders";

const { version } = packageJsonData;

describe("init choices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.ensureInstallPackages.mockResolvedValue(undefined);
    mocks.isProjectFileTracked.mockReturnValue(false);
    mocks.makeEnv.mockResolvedValue("");
    mocks.runAwsInit.mockResolvedValue(undefined);
    mocks.runSupabaseInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("prompts instead of reusing managed build and provider", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      managedEnv: {
        HOT_UPDATER_INIT_BUILD: "expo",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
    });
    mocks.group.mockResolvedValue({
      build: "bare",
      provider: "aws",
    });

    // When
    await init();

    // Then
    expect(mocks.ensureInstallPackages).toHaveBeenCalledWith({
      dependencies: ["@hot-updater/react-native"],
      devDependencies: expect.arrayContaining([
        "@hot-updater/bare",
        "@hot-updater/server",
        "@hot-updater/aws",
      ]),
    });
    expect(
      mocks.ensureInstallPackages.mock.calls[0]?.[0].devDependencies,
    ).not.toContain("dotenv");
    expect(mocks.group).toHaveBeenCalledOnce();
    expect(mocks.makeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_INIT_BUILD: "bare",
      HOT_UPDATER_INIT_PROVIDER: "aws",
    });
    expect(
      mocks.appendToProjectRootGitignore.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.makeEnv.mock.invocationCallOrder[0] ?? Infinity);
    expect(mocks.makeEnv.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureInstallPackages.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mocks.runAwsInit).toHaveBeenCalledWith({
      build: "bare",
      envFile: undefined,
      otherServerDefinitions: await otherServerDefinitionsOf("aws"),
    });
  });

  it("collects missing build and provider in one prompt group", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
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
      otherServerDefinitions: await otherServerDefinitionsOf("aws"),
    });
  });

  it("stops before prompting or installing when the init env file has no build", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
    });

    // When
    await init({ envFile: "init.env", provider: "aws" });

    // Then
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.appendToProjectRootGitignore).not.toHaveBeenCalled();
    expect(mocks.isProjectFileTracked).not.toHaveBeenCalled();
    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.ensureInstallPackages).not.toHaveBeenCalled();
    expect(mocks.runAwsInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    // The provider's inputs are checked once its package is installed.
    expect(mocks.logError).toHaveBeenCalledWith(
      ["Init is missing required inputs:", "- HOT_UPDATER_INIT_BUILD"].join(
        "\n",
      ),
    );
  });

  it("reports every missing provider input once the provider package is installed, before its init runs", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: { HOT_UPDATER_INIT_BUILD: "bare" },
    });

    // When
    await init({ envFile: "init.env", provider: "aws" });

    // Then
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.ensureInstallPackages).toHaveBeenCalledWith({
      dependencies: ["@hot-updater/react-native"],
      devDependencies: expect.arrayContaining(["@hot-updater/aws"]),
    });
    expect(mocks.runAwsInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      [
        "Init is missing required inputs:",
        "- HOT_UPDATER_DYNAMODB_TABLE_NAME",
        "- HOT_UPDATER_AWS_AUTH_MODE",
        "- HOT_UPDATER_S3_BUCKET_NAME",
        "- HOT_UPDATER_S3_REGION",
        "- HOT_UPDATER_AWS_LAMBDA_NAME",
      ].join("\n"),
    );
  });

  it("lets Supabase validate CLI authentication when env-file omits the access token", async () => {
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_INIT_BUILD: "bare",
        HOT_UPDATER_SUPABASE_BUCKET_NAME: "updates",
        HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
        HOT_UPDATER_SUPABASE_PROJECT_ID: "project-ref",
      },
    });

    await init({ envFile: "init.env", provider: "supabase" });

    expect(process.exitCode).toBeUndefined();
    expect(mocks.runSupabaseInit).toHaveBeenCalledWith({
      build: "bare",
      envFile: "init.env",
      otherServerDefinitions: await otherServerDefinitionsOf("supabase"),
    });
  });

  it("refuses to write credentials to a tracked managed env file", async () => {
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_INIT_BUILD: "expo",
        HOT_UPDATER_INIT_PROVIDER: "aws",
      },
    });
    mocks.isProjectFileTracked.mockReturnValue(true);

    await init();

    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.ensureInstallPackages).not.toHaveBeenCalled();
    expect(mocks.runAwsInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.isProjectFileTracked).toHaveBeenCalledWith({
      cwd: process.cwd(),
      filePath: ".env.hotupdater",
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining(".env.hotupdater is tracked by Git"),
    );
  });

  it("passes .env.hotupdater to the selected provider for replay", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_INIT_BUILD: "expo",
        HOT_UPDATER_INIT_PROVIDER: "aws",
        HOT_UPDATER_AWS_AUTH_MODE: "local-session",
        HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
        HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater",
        HOT_UPDATER_S3_BUCKET_NAME: "hot-updater-storage",
        HOT_UPDATER_S3_REGION: "us-east-1",
      },
    });

    // When
    await init({ envFile: ".env.hotupdater", provider: "aws" });

    // Then
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.runAwsInit).toHaveBeenCalledWith({
      build: "expo",
      envFile: ".env.hotupdater",
      otherServerDefinitions: await otherServerDefinitionsOf("aws"),
    });
  });

  it("stops before editing any file when the installed provider package has no init for this CLI, naming the version to install", async () => {
    // Given: a provider package from before its one ./init entry, whose
    // ./init has the provider's definition but no runInit.
    mocks.readHotUpdaterInitEnv.mockResolvedValue({ env: {}, managedEnv: {} });
    const { initProvider } = await import("@hot-updater/aws/init");
    vi.spyOn(INIT_PROVIDER_PACKAGES.aws, "load").mockResolvedValue({
      initProvider,
    } as unknown as InitProviderModule);

    // When
    await init({ build: "bare", provider: "aws" });

    // Then
    expect(mocks.appendToProjectRootGitignore).not.toHaveBeenCalled();
    expect(mocks.makeEnv).not.toHaveBeenCalled();
    expect(mocks.ensureInstallPackages).not.toHaveBeenCalled();
    expect(mocks.runAwsInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining(
        `has no init for hot-updater ${version}: its ./init exports no runInit.\nInstall @hot-updater/aws@${version} to match hot-updater ${version}, and run init again.`,
      ),
    );
  });

  it("stops before any resource when the provider package still fails to load once installed, naming the version to install", async () => {
    // Given: a provider package whose peer is missing, which installing
    // init's packages does not add.
    mocks.readHotUpdaterInitEnv.mockResolvedValue({ env: {}, managedEnv: {} });
    vi.spyOn(INIT_PROVIDER_PACKAGES.aws, "load").mockRejectedValue(
      new Error("Cannot find package '@aws-sdk/client-s3'"),
    );

    // When
    await init({ build: "bare", provider: "aws" });

    // Then: init installed its packages first, which may have added the peer.
    expect(mocks.ensureInstallPackages).toHaveBeenCalled();
    expect(mocks.runAwsInit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      `@hot-updater/aws failed to load: Cannot find package '@aws-sdk/client-s3'\nInstall @hot-updater/aws@${version} to match hot-updater ${version}, and run init again.`,
    );
  });

  it("prints actionable provider init errors without rethrowing", async () => {
    // Given
    const providerError = new InitError("actionable provider error");
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {},
      managedEnv: {},
    });
    mocks.runAwsInit.mockRejectedValue(providerError);

    // When
    await expect(
      init({ build: "bare", provider: "aws" }),
    ).resolves.toBeUndefined();

    // Then
    expect(mocks.logError).toHaveBeenCalledWith(providerError.message);
    expect(process.exitCode).toBe(1);
  });
});
