import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log: { info: vi.fn() } },
}));

import type { IssueAscApiKeyRequest, IssuedAscApiKey } from "../ascApiKey";
import {
  AscCommandError,
  type AscSignInPrompts,
  ascEnvironment,
  createAscCliKeyIssuer,
} from "./ascCliKeyIssuer";

/**
 * A stand-in for asc: it logs each call's argv and environment to
 * FAKE_ASC_LOG and answers as FAKE_ASC_SCENARIO says, with the JSON asc
 * 5.16.1 prints (internal/cli/web/web_auth.go webAuthStatus,
 * web_api_keys.go webAPIKeyCreateResult, internal/asc WebAPIKeyRevokeResult).
 */
const FAKE_ASC = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.FAKE_ASC_SCENARIO || "{}");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    name.startsWith("ASC_") || ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"].includes(name),
  ),
);
fs.appendFileSync(process.env.FAKE_ASC_LOG, JSON.stringify({ args, env }) + "\n");
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const fail = (message) => {
  process.stderr.write("Error: " + message + "\n");
  process.exit(1);
};
const command = args.slice(0, 3).join(" ");
if (command === "web auth login") {
  if (scenario.login) fail(scenario.login);
  if (process.env.ASC_WEB_PASSWORD !== "correct horse") fail("incorrect Apple Account email or password");
  // Apple asks for a code; a wrong one makes it text another, and asc runs
  // the command again, as asc 5.16.1 does on the phone fallback.
  const codes = [];
  for (let i = 0; i < (scenario.codeRounds ?? 1); i += 1) {
    let code;
    try {
      code = execSync(flag("--two-factor-code-command"), { encoding: "utf8", shell: "/bin/sh" }).trim();
    } catch {
      fail("two-factor code command failed");
    }
    codes.push(code);
  }
  fs.appendFileSync(process.env.FAKE_ASC_LOG, JSON.stringify({ codes }) + "\n");
  if (codes.at(-1) !== "123456") fail("incorrect verification code");
  // A session file, as asc keeps one in ASC_WEB_SESSION_CACHE_DIR.
  fs.writeFileSync(path.join(process.env.ASC_WEB_SESSION_CACHE_DIR, "session-x.json"), "{}");
  process.stdout.write(JSON.stringify({
    authenticated: true,
    passwordStored: false,
    source: "fresh",
    appleId: flag("--apple-id"),
    teamId: "118000",
    providerId: 118000,
    publicProviderId: "11111111-2222-3333-4444-555555555555",
    developerTeamId: "ABCDE12345",
  }));
} else if (command === "web api-keys create") {
  if (scenario.create) fail(scenario.create);
  const keyId = "KEY1234567";
  const dir = scenario.p8Dir ? scenario.p8Dir : flag("--output-dir");
  const p8Path = path.join(dir, "AuthKey_" + keyId + ".p8");
  fs.writeFileSync(p8Path, scenario.p8 ?? fs.readFileSync(process.env.FAKE_ASC_P8, "utf8"), { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    keyId,
    name: flag("--name"),
    ...(scenario.noIssuer ? {} : { issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1" }),
    roles: [flag("--role")],
    active: true,
    allAppsVisible: true,
    keyType: "PUBLIC_API",
    p8Path,
  }));
} else if (command === "web api-keys revoke") {
  if (scenario.revoke) fail(scenario.revoke);
  process.stdout.write(JSON.stringify({
    keyId: flag("--key-id"), kind: "team", changed: true, active: false, status: "revoked",
  }));
} else {
  fail("unexpected command " + args.join(" "));
}
`;

type Call = { args: string[]; env: Record<string, string> };

/** Prompts that answer like a developer who types the right things. */
const prompts = (overrides: Partial<AscSignInPrompts> = {}) => {
  const asked: string[] = [];
  return {
    asked,
    prompts: {
      password: async (appleId: string | undefined) => {
        asked.push(`password ${appleId}`);
        return "correct horse";
      },
      twoFactorCode: async (attempt: number) => {
        asked.push(`code ${attempt}`);
        return "123456";
      },
      ...overrides,
    } satisfies AscSignInPrompts,
  };
};

let dir: string;
let ascPath: string;
let logPath: string;
let p8: string;
const issued: IssuedAscApiKey[] = [];

const issue = async (
  scenario: Record<string, unknown> = {},
  request: Partial<IssueAscApiKeyRequest> = {},
  signIn: AscSignInPrompts = prompts().prompts,
) => {
  const key = await createAscCliKeyIssuer({
    asc: { path: ascPath },
    prompts: signIn,
    env: {
      ...process.env,
      FAKE_ASC_LOG: logPath,
      FAKE_ASC_P8: path.join(dir, "key.p8"),
      FAKE_ASC_SCENARIO: JSON.stringify(scenario),
      // What a developer's shell may set: none of it reaches asc.
      ASC_WEB_PASSWORD: "hunter2",
      ASC_WEB_2FA_CODE_COMMAND: "echo 000000",
      ASC_KEY_ID: "OTHERKEY",
    },
  })({
    name: "hot-updater 2026-10-25",
    role: "ADMIN",
    appleId: "dev@example.com",
    ...request,
  });
  issued.push(key);
  return key;
};

const lines = async () =>
  (await fs.readFile(logPath, "utf-8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Partial<Call> & { codes?: string[] });

const calls = async (): Promise<Call[]> =>
  (await lines()).filter((line): line is Call => Array.isArray(line.args));

/** The temporary directory asc ran in, from the first call's HOME. */
const workDirectory = async () => path.dirname((await calls())[0]!.env.HOME!);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-asc-"));
  ascPath = path.join(dir, "asc");
  logPath = path.join(dir, "calls.log");
  await fs.writeFile(ascPath, `#!${process.execPath}\n${FAKE_ASC}`, {
    mode: 0o755,
  });
  p8 = crypto
    .generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString()
    .trim();
  await fs.writeFile(path.join(dir, "key.p8"), p8);
});

afterEach(async () => {
  for (const key of issued.splice(0)) await key.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("createAscCliKeyIssuer", () => {
  it("signs in and creates a team key of the role asked for, keeping the session until dispose", async () => {
    const key = await issue();

    expect(key).toMatchObject({
      p8,
      keyId: "KEY1234567",
      issuerId: "69a6de70-0000-47e3-e053-5b8c7c11a4d1",
      name: "hot-updater 2026-10-25",
      team: {
        appleId: "dev@example.com",
        teamId: "11111111-2222-3333-4444-555555555555",
        developerTeamId: "ABCDE12345",
      },
    });
    const [login, create, ...rest] = await calls();
    expect(rest).toEqual([]);
    const codeCommand =
      login!.args[login!.args.indexOf("--two-factor-code-command") + 1]!;
    expect(login!.args).toEqual([
      "web",
      "auth",
      "login",
      "--apple-id",
      "dev@example.com",
      "--two-factor-code-command",
      codeCommand,
      "--output",
      "json",
    ]);
    const outputDir = create!.args[create!.args.indexOf("--output-dir") + 1]!;
    expect(create!.args).toEqual([
      "web",
      "api-keys",
      "create",
      "--name",
      "hot-updater 2026-10-25",
      "--role",
      "ADMIN",
      "--output-dir",
      outputDir,
      "--apple-id",
      "dev@example.com",
      "--output",
      "json",
    ]);

    const root = await workDirectory();
    expect(existsSync(root)).toBe(true);
    await key.dispose();
    // The session, config, and .p8 are gone with it.
    expect(existsSync(root)).toBe(false);
  });

  it("runs asc with its state in a private directory, and no ASC_ variable of the caller", async () => {
    await issue();
    const root = await workDirectory();
    expect(root.startsWith(path.join(os.tmpdir(), "hot-updater-asc-"))).toBe(
      true,
    );
    expect(((await fs.stat(root)).mode & 0o777).toString(8)).toBe("700");
    const [login, ...rest] = await calls();
    // The password typed into the prompt reaches the sign-in alone, never
    // the caller's ASC_WEB_PASSWORD.
    expect(login!.env.ASC_WEB_PASSWORD).toBe("correct horse");
    for (const call of [
      {
        ...login!,
        env: Object.fromEntries(
          Object.entries(login!.env).filter(
            ([name]) => name !== "ASC_WEB_PASSWORD",
          ),
        ),
      },
      ...rest,
    ]) {
      expect(call.env).toEqual({
        HOME: path.join(root, "home"),
        XDG_CONFIG_HOME: path.join(root, "home", ".config"),
        XDG_CACHE_HOME: path.join(root, "home", ".cache"),
        ASC_CONFIG_PATH: path.join(root, "home", "config.json"),
        ASC_WEB_SESSION_CACHE_DIR: path.join(root, "session"),
        ASC_WEB_SESSION_CACHE_BACKEND: "file",
        ASC_WEB_DONT_STORE_PASSWORD: "1",
        ASC_BYPASS_KEYCHAIN: "1",
        ASC_TELEMETRY_DISABLED: "1",
        ASC_SPINNER_DISABLED: "1",
      });
    }
  });

  it("creates the key in the team chooseTeam picks", async () => {
    const seen: unknown[] = [];
    const key = await issue(
      {},
      {
        chooseTeam: async (team) => {
          seen.push(team);
          return "OTHERTEAM";
        },
      },
    );
    expect(seen).toEqual([
      expect.objectContaining({ developerTeamId: "ABCDE12345" }),
    ]);
    expect(key.team).toEqual({
      appleId: "dev@example.com",
      teamId: "OTHERTEAM",
    });
    const [, create] = await calls();
    expect(create!.args[create!.args.indexOf("--public-provider-id") + 1]).toBe(
      "OTHERTEAM",
    );
  });

  it("creates the key in teamId without asking", async () => {
    const chooseTeam = vi.fn();
    await issue({}, { teamId: "TEAMID", chooseTeam });
    expect(chooseTeam).not.toHaveBeenCalled();
    const [, create] = await calls();
    expect(create!.args[create!.args.indexOf("--public-provider-id") + 1]).toBe(
      "TEAMID",
    );
  });

  it("revokes the key in the session it was issued in", async () => {
    const key = await issue();
    await expect(key.revoke()).resolves.toBe(true);
    const all = await calls();
    expect(all[2]!.args).toEqual([
      "web",
      "api-keys",
      "revoke",
      "--key-id",
      "KEY1234567",
      "--type",
      "team",
      "--confirm",
      "--apple-id",
      "dev@example.com",
      "--output",
      "json",
    ]);
    expect(all[2]!.env.ASC_WEB_SESSION_CACHE_DIR).toBe(
      all[0]!.env.ASC_WEB_SESSION_CACHE_DIR,
    );
  });

  it("answers false when the revoke fails", async () => {
    const key = await issue({ revoke: "App Store Connect answered 500" });
    await expect(key.revoke()).resolves.toBe(false);
  });

  it.each([
    [
      "a .p8 that is no private key",
      { p8: "not a key" },
      "asc saved a .p8 that is not a private key.",
    ],
    [
      "no issuer ID",
      { noIssuer: true },
      "asc printed no issuer ID for the key.",
    ],
  ])(
    "never hands out a key it got %s for, and revokes it",
    async (_, scenario, reason) => {
      const error = await issue(scenario).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        `${reason} The App Store Connect API key KEY1234567 was revoked again.`,
      );
      expect((await calls()).at(-1)!.args.slice(0, 3)).toEqual([
        "web",
        "api-keys",
        "revoke",
      ]);
      expect(existsSync(await workDirectory())).toBe(false);
    },
  );

  it("revokes a key whose .p8 asc saved outside its output directory", async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "elsewhere-"));
    try {
      const error = await issue({ p8Dir: elsewhere }).catch(
        (caught: unknown) => caught,
      );
      expect((error as Error).message).toContain(
        "asc saved the key's .p8 outside its output directory.",
      );
      expect((await calls()).at(-1)!.args[2]).toBe("revoke");
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("names the key to revoke by hand when the revoke of an unusable key fails", async () => {
    const error = await issue({ noIssuer: true, revoke: "500" }).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toBe(
      "asc printed no issuer ID for the key. Revoking the App Store Connect API key KEY1234567 failed too: revoke it at https://appstoreconnect.apple.com/access/integrations/api.",
    );
  });

  it("asks for the password and the two-factor code in Hot Updater's prompts, and passes neither as an argument", async () => {
    const signIn = prompts();
    await issue({}, {}, signIn.prompts);
    expect(signIn.asked).toEqual(["password dev@example.com", "code 1"]);
    expect((await lines()).find((line) => line.codes)?.codes).toEqual([
      "123456",
    ]);
    for (const call of await calls()) {
      expect(call.args.join(" ")).not.toContain("correct horse");
      expect(call.args.join(" ")).not.toContain("123456");
    }
  });

  it("asks again when asc wants another code, as after Apple texts one", async () => {
    let attempts = 0;
    const signIn = prompts({
      twoFactorCode: async (attempt) => {
        attempts = attempt;
        return attempt === 1 ? "000000" : "123456";
      },
    });
    await issue({ codeRounds: 2 }, {}, signIn.prompts);
    expect(attempts).toBe(2);
    expect((await lines()).find((line) => line.codes)?.codes).toEqual([
      "000000",
      "123456",
    ]);
  });

  it("starts nothing when the password prompt is cancelled", async () => {
    const error = await issue(
      {},
      {},
      prompts({ password: async () => undefined }).prompts,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AscCommandError);
    expect((error as Error).message).toBe("Signing in was cancelled.");
    expect(await calls()).toEqual([]);
  });

  it("stops the sign-in, creates nothing, and deletes its state when the code prompt is cancelled", async () => {
    const error = await issue(
      {},
      {},
      prompts({ twoFactorCode: async () => undefined }).prompts,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AscCommandError);
    expect((error as Error).message).toBe("Signing in was cancelled.");
    expect((await calls()).map((call) => call.args[2])).toEqual(["login"]);
    expect(existsSync(await workDirectory())).toBe(false);
  });

  it("reports a wrong password as asc does", async () => {
    const error = await issue(
      {},
      {},
      prompts({ password: async () => "wrong" }).prompts,
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      "Signing in with asc web auth login failed: Error: incorrect Apple Account email or password",
    );
  });

  it("passes asc's sign-in failure through, creates nothing, and deletes its state", async () => {
    const error = await issue({
      login: "incorrect Apple Account email or password",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AscCommandError);
    expect((error as Error).message).toBe(
      "Signing in with asc web auth login failed: Error: incorrect Apple Account email or password",
    );
    expect((await calls()).map((call) => call.args[2])).toEqual(["login"]);
    expect(existsSync(await workDirectory())).toBe(false);
  });

  it.each([
    [
      "a role that cannot create keys",
      "403 Forbidden: you do not have permission to create API keys",
      "needs the Account Holder or Admin role",
    ],
    [
      "the team's key limit",
      "You have reached the maximum number of active API keys",
      "Revoke one at:\nhttps://appstoreconnect.apple.com/access/integrations/api",
    ],
    [
      "a pending Program License Agreement",
      "A required agreement is missing or has expired",
      "Agreement at https://developer.apple.com/account",
    ],
  ])("says what to do about %s", async (_, stderr, hint) => {
    const error = await issue({ create: stderr }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AscCommandError);
    expect((error as Error).message).toContain(`Error: ${stderr}`);
    expect((error as Error).message).toContain(hint);
    // Nothing was created, so nothing is revoked.
    expect((await calls()).map((call) => call.args[2])).toEqual([
      "login",
      "create",
    ]);
  });
});

describe("ascEnvironment", () => {
  it("keeps the caller's other variables", () => {
    const env = ascEnvironment("/tmp/x", {
      PATH: "/usr/bin",
      ASC_WEB_PASSWORD: "secret",
      DO_NOT_TRACK: "0",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ASC_WEB_PASSWORD).toBeUndefined();
    expect(env.DO_NOT_TRACK).toBeUndefined();
  });
});
