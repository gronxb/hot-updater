import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  link: vi.fn((url: string) => `link:${url}`),
  logStep: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    link: mocks.link,
    p: {
      ...actual.p,
      log: {
        ...actual.p.log,
        step: mocks.logStep,
      },
      password: mocks.password,
      select: mocks.select,
    },
  };
});

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

import { inputSupabaseAccessToken } from "./supabaseAuthentication";

describe("inputSupabaseAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses an existing CLI login without creating another token", async () => {
    mocks.select.mockResolvedValue("cli-login");
    mocks.execa.mockResolvedValue({ exitCode: 0, stdout: "[]" });

    await expect(inputSupabaseAccessToken()).resolves.toBeUndefined();

    expect(mocks.execa).toHaveBeenCalledOnce();
    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      [
        "-y",
        "supabase",
        "projects",
        "list",
        "--output",
        "json",
        "--agent",
        "no",
      ],
      { reject: false },
    );
  });

  it("starts CLI login when the saved CLI credential is invalid", async () => {
    mocks.select.mockResolvedValue("cli-login");
    mocks.execa
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });

    await expect(inputSupabaseAccessToken()).resolves.toBeUndefined();

    expect(mocks.execa).toHaveBeenNthCalledWith(
      2,
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

  it("opens the CLI login URL on Windows without another Enter", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      .mockReturnValueOnce(loginProcess)
      .mockResolvedValueOnce({ stdout: "" });
    const loginUrl =
      "https://supabase.com/dashboard/cli/login?session_id=test-session";

    const accessTokenPromise = inputSupabaseAccessToken();
    await vi.waitFor(() => expect(mocks.execa).toHaveBeenCalledTimes(2));
    stdout.write(
      `Here is your login link, open it in the browser ${loginUrl}\n`,
    );
    completeLogin();
    await accessTokenPromise;

    expect(mocks.execa).toHaveBeenNthCalledWith(3, "rundll32.exe", [
      "url.dll,FileProtocolHandler",
      loginUrl,
    ]);
  });

  it("shows where to create a personal access token", async () => {
    mocks.select.mockResolvedValue("access-token");
    mocks.password.mockResolvedValue("access-token");

    await inputSupabaseAccessToken();

    expect(mocks.link).toHaveBeenCalledWith(
      "https://supabase.com/dashboard/account/tokens",
    );
    expect(mocks.logStep).toHaveBeenCalledWith(
      expect.stringContaining(
        "link:https://supabase.com/dashboard/account/tokens",
      ),
    );
  });
});
