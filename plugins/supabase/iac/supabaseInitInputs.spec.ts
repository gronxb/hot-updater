import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  group: vi.fn(),
  link: vi.fn((url: string) => `link:${url}`),
  logStep: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    link: mocks.link,
    p: {
      ...actual.p,
      group: mocks.group,
      log: {
        ...actual.p.log,
        step: mocks.logStep,
      },
      password: mocks.password,
      select: mocks.select,
      text: mocks.text,
    },
  };
});

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

import {
  assertSupabaseNonInteractiveInputs,
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

  it("uses Supabase CLI login instead of requesting an access token when selected", async () => {
    // Given
    mocks.select.mockResolvedValue("cli-login");
    mocks.execa.mockResolvedValue({ stdout: "" });

    // When
    const deploymentInputs = await inputSupabaseDeploymentInputs({
      functionName: "update-server",
      nonInteractive: false,
    });

    // Then
    expect(deploymentInputs).toEqual({
      accessToken: undefined,
      functionName: "update-server",
    });
    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      ["-y", "supabase", "login", "--no-browser", "--agent", "no"],
      {
        stdin: "inherit",
        stderr: "inherit",
        stdout: "pipe",
      },
    );
    expect(mocks.password).not.toHaveBeenCalled();
  });

  it("opens the Supabase CLI login URL on Windows without another Enter", async () => {
    // Given
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write,
    );
    mocks.select.mockResolvedValue("cli-login");
    const stdout = new PassThrough();
    let completeLogin = () => {};
    const loginProcess = Object.assign(
      new Promise<{ stdout: string }>((resolve) => {
        completeLogin = () => resolve({ stdout: "" });
      }),
      { stdout },
    );
    mocks.execa
      .mockReturnValueOnce(loginProcess)
      .mockResolvedValueOnce({ stdout: "" });
    const loginUrl =
      "https://supabase.com/dashboard/cli/login?session_id=test-session";

    // When
    const deploymentInputsPromise = inputSupabaseDeploymentInputs({
      functionName: "update-server",
      nonInteractive: false,
    });
    await vi.waitFor(() => expect(mocks.execa).toHaveBeenCalledOnce());
    stdout.write(
      `Here is your login link, open it in the browser ${loginUrl}\n`,
    );
    completeLogin();
    await deploymentInputsPromise;

    // Then
    expect(mocks.execa).toHaveBeenNthCalledWith(2, "rundll32.exe", [
      "url.dll,FileProtocolHandler",
      loginUrl,
    ]);
  });

  it("prompts for authentication when an access token was only saved as a default", async () => {
    // Given
    mocks.select.mockResolvedValue("cli-login");
    mocks.execa.mockResolvedValue({ stdout: "" });

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
    expect(mocks.execa).toHaveBeenCalledOnce();
  });

  it("prefills the saved function name while retaining its placeholder", async () => {
    mocks.select.mockResolvedValue("cli-login");
    mocks.execa.mockResolvedValue({ stdout: "" });
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

  it("shows the token dashboard link when personal access token authentication is selected", async () => {
    // Given
    mocks.select.mockResolvedValue("access-token");
    mocks.password.mockResolvedValue("access-token");

    // When
    await inputSupabaseDeploymentInputs({
      functionName: "update-server",
      nonInteractive: false,
    });

    // Then
    expect(mocks.link).toHaveBeenCalledWith(
      "https://supabase.com/dashboard/account/tokens",
    );
    expect(mocks.logStep).toHaveBeenCalledWith(
      expect.stringContaining(
        "link:https://supabase.com/dashboard/account/tokens",
      ),
    );
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
