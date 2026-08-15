import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
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
      select: mocks.select,
      text: mocks.text,
    },
  };
});

import { initProvider } from "./init/index";
import {
  inputSupabaseDatabasePassword,
  inputSupabaseDeploymentInputs,
  inputSupabaseProjectCreationInputs,
  resolveSupabaseInitInputs,
} from "./supabaseInitInputs";

describe("resolveSupabaseInitInputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("does not expose an external Release catalog CDN init input", () => {
    const inputs = resolveSupabaseInitInputs({
      HOT_UPDATER_SUPABASE_CATALOG_CDN_URL:
        "https://updates.example.com/hot-updater",
    });

    expect(initProvider.inputs).not.toHaveProperty("catalogCdnUrl");
    expect(inputs).not.toHaveProperty("catalogCdnUrl");
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
    mocks.text.mockResolvedValue("update-server");
    mocks.group.mockImplementation(
      async (prompts: Record<string, () => Promise<string>>) => ({
        accessToken: await prompts.accessToken?.(),
        functionName: await prompts.functionName?.(),
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

  it("prompts for authentication when an access token was only saved as a default", async () => {
    // Given
    mocks.select.mockResolvedValue("access-token");
    mocks.password.mockResolvedValue("new-access-token");

    // When
    await inputSupabaseDeploymentInputs({
      accessToken: "saved-access-token",
      functionName: "update-server",
      nonInteractive: false,
    });

    // Then
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do you want to authenticate with Supabase?",
      }),
    );
    expect(mocks.password).toHaveBeenCalledOnce();
  });

  it("prefills the saved function name while retaining its placeholder", async () => {
    mocks.select.mockResolvedValue("access-token");
    mocks.password.mockResolvedValue("access-token");
    mocks.text.mockResolvedValue("edited-function");

    const deploymentInputs = await inputSupabaseDeploymentInputs({
      functionName: "saved-function",
      nonInteractive: false,
    });

    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "saved-function",
        placeholder: "update-server",
      }),
    );
    expect(deploymentInputs.functionName).toBe("edited-function");
  });

  it("asks for the database password again when the selected project changes", async () => {
    mocks.password.mockResolvedValue("new-password");

    await expect(
      inputSupabaseDatabasePassword({
        databasePassword: "old-password",
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

  it("asks for a saved database password again in interactive mode", async () => {
    // Given
    mocks.password.mockResolvedValue("new-password");

    // When
    const password = await inputSupabaseDatabasePassword({
      databasePassword: "saved-password",
      nonInteractive: false,
    });

    // Then
    expect(password).toBe("new-password");
    expect(mocks.password).toHaveBeenCalledOnce();
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

  it("delegates the project creation password prompt to the authenticated Supabase CLI", async () => {
    await expect(
      inputSupabaseDatabasePassword({
        cliHandlesPrompt: true,
        nonInteractive: false,
        required: true,
      }),
    ).resolves.toBe("");
    expect(mocks.password).not.toHaveBeenCalled();
  });

  it("prompts for saved project creation choices with those choices selected by default", async () => {
    // Given
    mocks.text
      .mockResolvedValueOnce("edited-project")
      .mockResolvedValueOnce("edited-bucket");
    mocks.select
      .mockResolvedValueOnce("saved-organization")
      .mockResolvedValueOnce("ap-northeast-2");

    // When
    await inputSupabaseProjectCreationInputs({
      bucketName: "saved-bucket",
      organizationSlug: "saved-organization",
      organizations: [
        { name: "Saved organization", slug: "saved-organization" },
      ],
      projectName: "saved-project",
      region: "ap-northeast-2",
    });

    // Then
    expect(mocks.select).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        initialValue: "saved-organization",
      }),
    );
    expect(mocks.select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        initialValue: "ap-northeast-2",
      }),
    );
  });
});
