import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: {
      ...actual.p,
      group: mocks.group,
      password: mocks.password,
      text: mocks.text,
    },
  };
});

import {
  assertSupabaseNonInteractiveInputs,
  inputSupabaseDeploymentInputs,
  resolveSupabaseInitInputs,
} from "./supabaseInitInputs";

describe("resolveSupabaseInitInputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.HOT_UPDATER_SUPABASE_DB_PASSWORD;
    delete process.env.SUPABASE_ACCESS_TOKEN;
  });

  it("reuses a database password saved for infrastructure updates", () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "saved-password",
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
    };

    // When
    const inputs = resolveSupabaseInitInputs(existingEnv);

    // Then
    expect(inputs.databasePassword).toBe("saved-password");
  });

  it("accepts a database password from the process environment", () => {
    // Given
    process.env.HOT_UPDATER_SUPABASE_DB_PASSWORD = "injected-password";

    // When
    const inputs = resolveSupabaseInitInputs({});

    // Then
    expect(inputs.databasePassword).toBe("injected-password");
  });

  it("accepts a database password from an overlaid init env", () => {
    // Given
    const overlaidEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "temporary-password",
    };

    // When
    const inputs = resolveSupabaseInitInputs(overlaidEnv);

    // Then
    expect(inputs.databasePassword).toBe("temporary-password");
  });
});

describe("Supabase non-interactive inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.group.mockImplementation(
      async (prompts: Record<string, () => Promise<string>>) => ({
        accessToken: await prompts.accessToken?.(),
        dbPassword: await prompts.dbPassword?.(),
        functionName: await prompts.functionName?.(),
      }),
    );
  });

  it("reports all missing Supabase resource inputs", () => {
    const inputs = resolveSupabaseInitInputs({});

    expect(() => assertSupabaseNonInteractiveInputs(inputs, true)).toThrow(
      expect.objectContaining({
        missingInputs: [
          "HOT_UPDATER_SUPABASE_PROJECT_ID",
          "SUPABASE_ACCESS_TOKEN",
          "HOT_UPDATER_SUPABASE_BUCKET_NAME",
          "HOT_UPDATER_SUPABASE_FUNCTION_NAME",
        ],
      }),
    );
  });

  it("skips the optional database password without prompting", async () => {
    // Given
    const inputs = resolveSupabaseInitInputs({
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
      SUPABASE_ACCESS_TOKEN: "access-token",
    });

    // When
    const deploymentInputs = await inputSupabaseDeploymentInputs({
      ...inputs,
      nonInteractive: true,
    });

    // Then
    expect(deploymentInputs).toEqual({
      accessToken: "access-token",
      dbPassword: "",
      functionName: "update-server",
    });
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.text).not.toHaveBeenCalled();
  });
});
