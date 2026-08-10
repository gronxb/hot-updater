import { InitError, type RunInitOptions } from "@hot-updater/cli-tools";
import {
  attachUniversalComponentDataAdapter,
  getUniversalComponentLatestSchema,
} from "@hot-updater/plugin-core";
import { generateUniversalComponentArtifacts } from "@hot-updater/server/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";

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

vi.mock("@hot-updater/aws/iac", () => ({
  runInit: mocks.runAwsInit,
}));

vi.mock("@hot-updater/supabase/iac", () => ({
  runInit: mocks.runSupabaseInit,
}));

import { init } from "./init";

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
      createDeploymentTarget: expect.any(Function),
      envFile: undefined,
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
      createDeploymentTarget: expect.any(Function),
      envFile: undefined,
    });
  });

  it("stops before prompting when the init env file is incomplete", async () => {
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
    expect(mocks.logError).toHaveBeenCalledWith(
      [
        "Init is missing required inputs:",
        "- HOT_UPDATER_INIT_BUILD",
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
      createDeploymentTarget: expect.any(Function),
      envFile: "init.env",
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
        HOT_UPDATER_AWS_MIGRATION_APPROVED: "true",
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
      createDeploymentTarget: expect.any(Function),
      envFile: ".env.hotupdater",
    });
  });

  it("gives providers a target whose active Analytics plugin generates its component artifact", async () => {
    mocks.readHotUpdaterInitEnv.mockResolvedValue({ env: {}, managedEnv: {} });
    const generatedArtifacts: unknown[] = [];
    mocks.runAwsInit.mockImplementation(async (options: RunInitOptions) => {
      const database = attachUniversalComponentDataAdapter(
        createDatabasePluginHarness().plugin,
        () => ({
          artifacts(schema) {
            const latest = getUniversalComponentLatestSchema(schema);
            return [
              {
                contents: `-- component ${schema.id}@${latest.version}`,
                path: `component-data/${schema.id}/synthetic-${latest.version}.sql`,
                targetVersion: latest.version,
              },
            ];
          },
          bind: (schema) =>
            Object.freeze({
              append: async () => {},
              assertReady: async () => {},
              orderedScan: async () => [],
              schema,
            }),
        }),
      );
      const target = options.createDeploymentTarget?.(database);
      if (target === undefined) {
        throw new Error("Expected init deployment target callback");
      }
      generatedArtifacts.push(...generateUniversalComponentArtifacts(target));
    });

    await init({ build: "bare", provider: "aws" });

    expect(generatedArtifacts).toEqual([
      {
        componentId: "analytics",
        contents: "-- component analytics@2",
        path: "component-data/analytics/synthetic-2.sql",
        targetVersion: "2",
      },
    ]);
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
