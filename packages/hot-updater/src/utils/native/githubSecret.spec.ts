import os from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { confirm, gh } = vi.hoisted(() => ({
  confirm: vi.fn(),
  /** What `gh auth token` prints, or undefined when it fails. */
  gh: { token: undefined as string | undefined },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: {
    confirm,
    isCancel: vi.fn(() => false),
    log: { success: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(
    async (
      file: string,
      args: readonly string[],
      options: { env?: Record<string, string | undefined> } = {},
    ) => {
      if ([file, ...args].join(" ") !== "gh auth token --hostname github.com") {
        throw new Error("unexpected command");
      }
      // gh prints GH_TOKEN or GITHUB_TOKEN, when its environment has one,
      // instead of its stored login.
      const env = options.env ?? process.env;
      const fromEnv = env["GH_TOKEN"] || env["GITHUB_TOKEN"];
      const token = fromEnv || gh.token;
      return token
        ? { exitCode: 0, stdout: `${token}\n` }
        : { exitCode: 4, stdout: "" };
    },
  ),
}));

import {
  findGitHubToken,
  offerGitHubSecret,
  parseGitHubRemote,
} from "./githubSecret";

const withTTY = async <T>(isTTY: boolean, run: () => Promise<T>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  gh.token = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseGitHubRemote", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git/", "acme/app"],
    ["https://user@github.com/acme/my.app.git", "acme/my.app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
  ])("reads %s as %s", (url, repository) => {
    expect(parseGitHubRemote(url)).toBe(repository);
  });

  it.each([
    "https://gitlab.com/acme/app.git",
    "git@github.com.evil.example:acme/app.git",
    "https://github.com/acme",
    "/srv/git/app.git",
  ])("finds no GitHub repository in %s", (url) => {
    expect(parseGitHubRemote(url)).toBeUndefined();
  });
});

describe("findGitHubToken", () => {
  const cwd = os.tmpdir();

  it("reads GH_TOKEN, then GITHUB_TOKEN, then the GitHub CLI's token", async () => {
    gh.token = "gho_cli";
    vi.stubEnv("GH_TOKEN", "github_pat_gh");
    vi.stubEnv("GITHUB_TOKEN", "github_pat_github");
    await expect(findGitHubToken(cwd)).resolves.toBe("github_pat_gh");
    vi.stubEnv("GH_TOKEN", "");
    await expect(findGitHubToken(cwd)).resolves.toBe("github_pat_github");
    vi.stubEnv("GITHUB_TOKEN", "");
    await expect(findGitHubToken(cwd)).resolves.toBe("gho_cli");
    gh.token = undefined;
    await expect(findGitHubToken(cwd)).resolves.toBeUndefined();
  });

  it("skips a workflow's installation token, which can't write secrets", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghs_workflow");
    await expect(findGitHubToken(cwd)).resolves.toBeUndefined();
    gh.token = "gho_cli";
    await expect(findGitHubToken(cwd)).resolves.toBe("gho_cli");
  });
});

describe("offerGitHubSecret", () => {
  const offer = (options: Partial<Parameters<typeof offerGitHubSecret>[0]>) =>
    offerGitHubSecret({
      name: "asc-api-key",
      value: "{}",
      file: "/tmp/issued/asc-api-key.json",
      findRepository: async () => "acme/app",
      findToken: async () => "gho_token",
      ...options,
    });

  it("asks nothing in CI", async () => {
    vi.stubEnv("CI", "true");
    const createSecrets = vi.fn();
    await expect(withTTY(true, () => offer({ createSecrets }))).resolves.toBe(
      "unavailable",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(createSecrets).not.toHaveBeenCalled();
  });

  it("writes the variable envSecrets() reads the name from", async () => {
    confirm.mockResolvedValue(true);
    const set = vi.fn(async () => {});
    await expect(
      withTTY(true, () =>
        offer({
          name: "widget-asc",
          createSecrets: () => ({ name: "github", get: vi.fn(), set }),
        }),
      ),
    ).resolves.toBe("stored");
    // githubActions() stores it as HOT_UPDATER_WIDGET_ASC.
    expect(set).toHaveBeenCalledExactlyOnceWith(
      "widget-asc",
      "{}",
      expect.anything(),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "the GitHub Actions secret HOT_UPDATER_WIDGET_ASC of acme/app",
        ),
      }),
    );
  });
});
