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
  });

  it("does not reuse a database password saved in the env file", () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "saved-password",
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
    };

    // When
    const inputs = resolveSupabaseInitInputs(existingEnv);

    // Then
    expect(inputs.databasePassword).toBeUndefined();
  });

  it("accepts a database password from the process environment", () => {
    // Given
    process.env.HOT_UPDATER_SUPABASE_DB_PASSWORD = "injected-password";

    // When
    const inputs = resolveSupabaseInitInputs({});

    // Then
    expect(inputs.databasePassword).toBe("injected-password");
  });

  it("accepts a database password from the explicit init env", () => {
    // Given
    const existingEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "saved-password",
    };
    const inputEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "temporary-password",
    };

    // When
    const inputs = resolveSupabaseInitInputs(existingEnv, inputEnv);

    // Then
    expect(inputs.databasePassword).toBe("temporary-password");
  });
});

describe("Supabase non-interactive inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.group.mockImplementation(
      async (prompts: Record<string, () => Promise<string>>) => ({
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
    });

    // When
    const deploymentInputs = await inputSupabaseDeploymentInputs({
      ...inputs,
      nonInteractive: true,
    });

    // Then
    expect(deploymentInputs).toEqual({
      dbPassword: "",
      functionName: "update-server",
    });
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.text).not.toHaveBeenCalled();
  });
});
