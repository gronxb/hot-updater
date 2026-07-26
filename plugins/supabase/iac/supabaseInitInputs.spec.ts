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
  inputSupabaseDatabasePassword,
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
      HOT_UPDATER_SUPABASE_DB_PASSWORD_PROJECT_ID: "saved-project",
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "update-server",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "saved-project",
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
    const managedEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "old-password",
      HOT_UPDATER_SUPABASE_DB_PASSWORD_PROJECT_ID: "old-project",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "old-project",
    };
    const inputEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "temporary-password",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "new-project",
    };

    // When
    const inputs = resolveSupabaseInitInputs(
      { ...managedEnv, ...inputEnv },
      { inputEnv, managedEnv },
    );

    // Then
    expect(inputs.databasePassword).toBe("temporary-password");
  });

  it("does not reuse a managed password when an input file changes projects", () => {
    const managedEnv = {
      HOT_UPDATER_SUPABASE_DB_PASSWORD: "old-password",
      HOT_UPDATER_SUPABASE_DB_PASSWORD_PROJECT_ID: "old-project",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "old-project",
    };
    const inputEnv = {
      HOT_UPDATER_SUPABASE_PROJECT_ID: "new-project",
    };

    const inputs = resolveSupabaseInitInputs(
      { ...managedEnv, ...inputEnv },
      { inputEnv, managedEnv },
    );

    expect(inputs.projectId).toBe("new-project");
    expect(inputs.databasePassword).toBeUndefined();
  });
});

describe("Supabase non-interactive inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.group.mockImplementation(
      async (prompts: Record<string, () => Promise<string>>) => ({
        accessToken: await prompts.accessToken?.(),
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
      functionName: "update-server",
    });
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.text).not.toHaveBeenCalled();
  });

  it("rejects an unsafe saved Edge Function name in non-interactive mode", () => {
    const inputs = resolveSupabaseInitInputs({
      HOT_UPDATER_SUPABASE_BUCKET_NAME: "updates",
      HOT_UPDATER_SUPABASE_FUNCTION_NAME: "../outside",
      HOT_UPDATER_SUPABASE_PROJECT_ID: "project-ref",
      SUPABASE_ACCESS_TOKEN: "access-token",
    });

    expect(() => assertSupabaseNonInteractiveInputs(inputs, true)).toThrow(
      expect.objectContaining({
        missingInputs: ["HOT_UPDATER_SUPABASE_FUNCTION_NAME"],
      }),
    );
  });

  it("asks for the database password again when the selected project changes", async () => {
    mocks.password.mockResolvedValue("new-password");

    await expect(
      inputSupabaseDatabasePassword({
        databasePassword: "old-password",
        forcePrompt: true,
        nonInteractive: false,
      }),
    ).resolves.toBe("new-password");
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "Enter your Supabase database password (press Enter to skip if none)",
      }),
    );
  });

  it("requires a database password before planning project creation", async () => {
    mocks.password.mockResolvedValue("");

    await inputSupabaseDatabasePassword({
      nonInteractive: false,
      required: true,
    });

    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({
        validate: expect.any(Function),
      }),
    );
    const validate = mocks.password.mock.calls[0]?.[0]?.validate;
    expect(validate("")).toBe(
      "A database password is required to create a Supabase project",
    );
  });
});
