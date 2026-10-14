import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execa = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa }));

import {
  readVercelCliToken,
  resolveVercelToken,
  VercelLoginRequiredError,
} from "./vercelAuth";

let configPath: string;
beforeEach(async () => {
  vi.clearAllMocks();
  configPath = await mkdtemp(path.join(os.tmpdir(), "vercel-cli-"));
});
afterEach(async () => {
  await rm(configPath, { force: true, recursive: true });
});

const saveAuth = (auth: object) =>
  writeFile(path.join(configPath, "auth.json"), JSON.stringify(auth));

describe("readVercelCliToken", () => {
  const now = Date.UTC(2026, 0, 1);

  it("reads the login's token while it is valid", async () => {
    await saveAuth({ expiresAt: now / 1000 + 3600, token: "vca_token" });

    expect(readVercelCliToken(configPath, now)).toBe("vca_token");
  });

  it("ignores a token that expires within a minute", async () => {
    await saveAuth({ expiresAt: now / 1000 + 30, token: "vca_token" });

    expect(readVercelCliToken(configPath, now)).toBeUndefined();
  });

  it("reads nothing from a login kept in the keyring", async () => {
    await saveAuth({ userId: "user" });

    expect(readVercelCliToken(configPath, now)).toBeUndefined();
    expect(
      readVercelCliToken(path.join(configPath, "missing"), now),
    ).toBeUndefined();
  });
});

describe("resolveVercelToken", () => {
  it("uses VERCEL_TOKEN without the CLI", async () => {
    const readToken = vi.fn();

    expect(
      await resolveVercelToken({
        cwd: "/app",
        nonInteractive: true,
        readToken,
        token: "env-token",
      }),
    ).toBe("env-token");
    expect(readToken).not.toHaveBeenCalled();
    expect(execa).not.toHaveBeenCalled();
  });

  it("refreshes an expired login with vercel whoami", async () => {
    const readToken = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("refreshed");

    expect(
      await resolveVercelToken({
        cwd: "/app",
        nonInteractive: true,
        readToken,
      }),
    ).toBe("refreshed");
    expect(execa).toHaveBeenCalledWith(
      "npx",
      ["vercel", "whoami"],
      expect.objectContaining({ cwd: "/app" }),
    );
  });

  it("asks a non-interactive init without a login for one", async () => {
    await expect(
      resolveVercelToken({
        cwd: "/app",
        nonInteractive: true,
        readToken: () => undefined,
      }),
    ).rejects.toBeInstanceOf(VercelLoginRequiredError);
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it("runs vercel login in an interactive init without a login", async () => {
    const readToken = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("logged-in");

    expect(
      await resolveVercelToken({
        cwd: "/app",
        nonInteractive: false,
        readToken,
      }),
    ).toBe("logged-in");
    expect(execa).toHaveBeenLastCalledWith(
      "npx",
      ["vercel", "login"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});
