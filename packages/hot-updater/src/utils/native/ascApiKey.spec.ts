import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, text, confirm, isCancel, git } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn((_answer: unknown) => false),
  /** What `git` and `gh` answer the GitHub offer's lookups with. */
  git: {
    remote: "git@github.com:acme/app.git" as string | undefined,
    token: "gho_specToken" as string | undefined,
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log, text, confirm, isCancel },
}));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(async (file: string, args: readonly string[]) => {
    const command = [file, ...args].join(" ");
    if (command === "git remote") {
      return { exitCode: 0, stdout: git.remote ? "origin" : "" };
    }
    if (command === "git remote get-url origin") {
      return { exitCode: 0, stdout: git.remote ?? "" };
    }
    if (command === "gh auth token --hostname github.com") {
      return git.token
        ? { exitCode: 0, stdout: `${git.token}\n` }
        : { exitCode: 1, stdout: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  }),
}));

import type {
  IssueAscApiKeyRequest,
  IssuedAscApiKey,
} from "@hot-updater/apple-helper";
import {
  envSecrets,
  maskSecretValues,
  setConfiguredSecrets,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { AscApiKeyNotStoredError, ensureAscApiKey } from "./ascApiKey";
import { CredentialSetupRefusedError } from "./issuedCredential";

const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----";

/**
 * A secrets adapter, made the config's, that records each call: `set`
 * stores unless `setError` is given, and `readBack` replaces what `get`
 * returns after a write, such as a write-only store's nothing.
 */
const fakeStore = ({
  values = {},
  writable = true,
  setError,
  readBack,
}: {
  values?: Record<string, string>;
  writable?: boolean;
  setError?: Error;
  readBack?: () => Promise<string | undefined>;
} = {}) => {
  const held = new Map(Object.entries(values));
  const calls: string[] = [];
  let written = false;
  const store: SecretsAdapter = {
    name: "spec-store",
    describe: (name) => `spec://${name}`,
    get: async (names) => {
      calls.push(`get ${names.join(",")}`);
      return Object.fromEntries(
        await Promise.all(
          names.map(async (name) => [
            name,
            written && readBack ? await readBack() : held.get(name),
          ]),
        ),
      );
    },
    ...(writable
      ? {
          set: async (name: string, value: string) => {
            calls.push(`set ${name}`);
            written = true;
            if (setError) throw setError;
            held.set(name, value);
          },
        }
      : {}),
  };
  setConfiguredSecrets(store);
  return { store, held, calls };
};

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

/**
 * An `IssueAscApiKey` that issues KEY1234567: what ensureAscApiKey depends
 * on, whichever sign-in implements it (apple-helper's specs cover asc's).
 */
const issued = {
  revoke: vi.fn(async () => true),
  dispose: vi.fn(async () => {}),
};
const issue = vi.fn(
  async (request: IssueAscApiKeyRequest): Promise<IssuedAscApiKey> => ({
    p8: P8,
    keyId: "KEY1234567",
    issuerId: "issuer-1",
    name: request.name,
    team: { appleId: request.appleId, developerTeamId: "ABCDE12345" },
    revoke: issued.revoke,
    dispose: issued.dispose,
  }),
);

/** ensureAscApiKey with the stand-in sign-in, and a cacheDir of its own. */
const ensure = (options: Parameters<typeof ensureAscApiKey>[0]) =>
  ensureAscApiKey({ issue, cacheDir, ...options });

let cacheDir: string;

/** Every argument the log and the prompts were given, as one text. */
const printed = () =>
  stripVTControlCharacters(
    [
      ...Object.values(log).flatMap((fn) => fn.mock.calls),
      ...text.mock.calls,
      ...confirm.mock.calls,
    ]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n"),
  );

beforeEach(async () => {
  vi.clearAllMocks();
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-asc-"));
  git.remote = "git@github.com:acme/app.git";
  git.token = "gho_specToken";
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("CI", "");
  for (const name of [
    "HOT_UPDATER_ASC_KEY_PATH",
    "HOT_UPDATER_ASC_KEY",
    "HOT_UPDATER_ASC_KEY_ID",
    "HOT_UPDATER_ASC_ISSUER_ID",
  ]) {
    vi.stubEnv(name, "");
  }
  text.mockResolvedValue("dev@example.com");
  confirm.mockResolvedValue(true);
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
  setConfiguredSecrets(envSecrets());
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ensureAscApiKey", () => {
  it("uses an environment override as it is, without the secrets adapter", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY");
    const { calls } = fakeStore();
    await expect(ensure({ name: "asc-api-key" })).resolves.toEqual({
      status: "environment",
    });
    expect(calls).toEqual([]);
    expect(issue).not.toHaveBeenCalled();
  });

  it("uses a stored key without a terminal or a sign-in, as CI does", async () => {
    const { calls } = fakeStore({ values: { "asc-api-key": "{}" } });
    await expect(
      withTTY(false, () => ensure({ name: "asc-api-key" })),
    ).resolves.toEqual({ status: "stored" });
    expect(calls).toEqual(["get asc-api-key"]);
    expect(issue).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses without a terminal, with the command that signs in once", async () => {
    const { calls } = fakeStore();
    await expect(
      withTTY(false, () => ensure({ name: "widget-asc" })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(log.error).toHaveBeenCalledWith(
      "widget-asc (asc-api-key) is not in the spec-store secrets adapter (spec://widget-asc). Store it once from a terminal with `npx hot-updater secrets issue asc-api-key widget-asc`, which signs in and stores the key Hot Updater issues, and builds, CI's included, read it from there. Hot Updater signs in to your Apple Account to issue it only at a terminal, never without a terminal. Or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key from the environment.",
    );
    expect(process.exitCode).toBe(1);
    // Nothing is written, and no Apple prompt.
    expect(calls).toEqual(["get widget-asc"]);
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("never signs in in CI, even on a terminal the runner allocates", async () => {
    vi.stubEnv("CI", "true");
    const { calls } = fakeStore();
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("never in CI (CI is set)"),
    );
    expect(calls).toEqual(["get asc-api-key"]);
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("never signs in in CI with a read-only adapter, writing no file", async () => {
    vi.stubEnv("CI", "true");
    setConfiguredSecrets(envSecrets());
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", cacheDir })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(issue).not.toHaveBeenCalled();
    await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
  });

  it("writes the key a read-only adapter can't store to a 0600 file, says where to store it, and keeps it", async () => {
    setConfiguredSecrets(envSecrets());
    git.remote = undefined;
    const result = await withTTY(true, () =>
      ensure({ name: "asc-api-key", cacheDir }),
    );

    const file = path.join(cacheDir, "issued", "asc-api-key.json");
    expect(result).toMatchObject({
      status: "saved",
      keyId: "KEY1234567",
      file,
    });
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({
      keyId: "KEY1234567",
      issuerId: "issuer-1",
      p8: P8,
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    await expect(
      fs.readFile(path.join(cacheDir, "issued", ".gitignore"), "utf-8"),
    ).resolves.toBe("*\n");

    const guidance = stripVTControlCharacters(
      String(log.warn.mock.calls[0]![0]),
    );
    expect(guidance).toContain("App Store Connect API key saved to a file");
    expect(guidance).toContain(`File:`);
    expect(guidance).toContain(file);
    expect(guidance).toContain(
      `Set HOT_UPDATER_ASC_API_KEY to the contents of ${file}, as one value, in the environment or .env.hotupdater`,
    );
    expect(guidance).toContain(
      "HOT_UPDATER_ASC_KEY to its p8, HOT_UPDATER_ASC_KEY_ID to its keyId, HOT_UPDATER_ASC_ISSUER_ID to its issuerId",
    );
    expect(guidance).toContain(
      "env: HOT_UPDATER_ASC_API_KEY: ${{ secrets.HOT_UPDATER_ASC_API_KEY }}",
    );
    expect(guidance).toContain("then delete the file");
    // The key is in the file alone: nothing printed or asked holds it.
    expect(printed()).not.toContain("MIGHAgEA");
    expect(printed()).not.toContain("BEGIN PRIVATE KEY");
    // No GitHub remote, no offer.
    expect(confirm).not.toHaveBeenCalled();
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);

    // The adapter the build resolves with reads the key from the file, and
    // every other name from the config's.
    vi.stubEnv("HOT_UPDATER_OTHER_KEY", "other-value");
    const { secrets } = result as Extract<typeof result, { status: "saved" }>;
    await expect(
      secrets.get(["asc-api-key", "other-key"], { cwd: cacheDir }),
    ).resolves.toEqual({
      "asc-api-key": await fs.readFile(file, "utf-8"),
      "other-key": "other-value",
    });
    expect(secrets.describe?.("asc-api-key")).toBe(file);

    // The line the guidance tells the developer to write resolves the key.
    const project = path.join(cacheDir, "project");
    await fs.mkdir(project);
    await fs.writeFile(
      path.join(project, ".env.hotupdater"),
      `HOT_UPDATER_ASC_API_KEY='${await fs.readFile(file, "utf-8")}'\n`,
    );
    const resolved = await withCredentialResolver(
      async (credentials) => {
        const key = await credentials.resolve({ kind: "asc-api-key" });
        return { ...key, p8: await fs.readFile(key.keyPath, "utf-8") };
      },
      { secrets: envSecrets(), cwd: project },
    );
    expect(resolved).toMatchObject({
      keyId: "KEY1234567",
      issuerId: "issuer-1",
      p8: P8,
    });
  });

  it("restricts only the issued directory, not a cacheDir it creates", async () => {
    setConfiguredSecrets(envSecrets());
    git.remote = undefined;
    const custom = path.join(cacheDir, "custom", "cache");
    await withTTY(true, () =>
      ensure({ name: "asc-api-key", cacheDir: custom }),
    );
    const umask = process.umask();
    expect((await fs.stat(custom)).mode & 0o777).toBe(0o777 & ~umask);
    expect((await fs.stat(path.join(custom, "issued"))).mode & 0o777).toBe(
      0o700,
    );
  });

  it("names where a read-only adapter other than env() reads the key", async () => {
    fakeStore({ writable: false });
    const githubSecrets = vi.fn();
    await withTTY(true, () =>
      ensure({ name: "widget-asc", cacheDir, githubSecrets }),
    );
    // CI reads a GitHub Actions secret only through env(): no offer.
    expect(confirm).not.toHaveBeenCalled();
    expect(githubSecrets).not.toHaveBeenCalled();
    const file = path.join(cacheDir, "issued", "widget-asc.json");
    const guidance = stripVTControlCharacters(
      String(log.warn.mock.calls[0]![0]),
    );
    expect(guidance).toContain(
      `Store the contents of ${file} as one value at spec://widget-asc, so builds read it.`,
    );
    expect(guidance).toContain(
      "In CI, the job reads it from the spec-store secrets adapter, or from those variables.",
    );
  });

  it("never replaces a key an earlier sign-in left in its file, and signs in no more", async () => {
    setConfiguredSecrets(envSecrets());
    const file = path.join(cacheDir, "issued", "asc-api-key.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "earlier key", { mode: 0o600 });

    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", cacheDir })),
    ).rejects.toThrow(
      `${file} holds an App Store Connect API key Hot Updater issued earlier, which builds here do not read yet.`,
    );
    expect(issue).not.toHaveBeenCalled();
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("earlier key");
  });

  it("refuses before any Apple sign-in when cacheDir can't hold the file", async () => {
    setConfiguredSecrets(envSecrets());
    const notADirectory = path.join(cacheDir, "file");
    await fs.writeFile(notADirectory, "");
    await expect(
      withTTY(true, () =>
        ensure({ name: "asc-api-key", cacheDir: notADirectory }),
      ),
    ).rejects.toThrow("whose directory Hot Updater can't write");
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("revokes the key when its file can't be written after the sign-in", async () => {
    setConfiguredSecrets(envSecrets());
    const file = path.join(cacheDir, "issued", "asc-api-key.json");
    const signIn = issue.getMockImplementation()!;
    issue.mockImplementationOnce(async (request) => {
      // Something writes the file during the sign-in.
      await fs.writeFile(file, "other");
      return signIn(request);
    });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", cacheDir })),
    ).rejects.toBeInstanceOf(AscApiKeyNotStoredError);
    expect(issued.revoke).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(file, "utf-8")).resolves.toBe("other");
  });

  it("stores the saved key as a GitHub Actions secret once when the developer agrees", async () => {
    setConfiguredSecrets(envSecrets());
    const set = vi.fn(async () => {});
    const githubSecrets = vi.fn(() => ({ name: "github", get: vi.fn(), set }));
    confirm.mockResolvedValue(true);

    await withTTY(true, () =>
      ensure({ name: "asc-api-key", cacheDir, githubSecrets }),
    );

    expect(confirm).toHaveBeenLastCalledWith({
      message:
        "Store it as the GitHub Actions secret HOT_UPDATER_ASC_API_KEY of acme/app, which CI builds read?",
      initialValue: true,
    });
    expect(githubSecrets).toHaveBeenCalledWith({
      repo: "acme/app",
      token: "gho_specToken",
    });
    const file = path.join(cacheDir, "issued", "asc-api-key.json");
    expect(set).toHaveBeenCalledExactlyOnceWith(
      "asc-api-key",
      await fs.readFile(file, "utf-8"),
      expect.anything(),
    );
    expect(
      stripVTControlCharacters(String(log.success.mock.calls.at(-1)![0])),
    ).toContain("GitHub Actions secret stored");
    expect(printed()).not.toContain("gho_specToken");
    expect(printed()).not.toContain("MIGHAgEA");
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ["declines", false, false],
    ["cancels", Symbol("cancel"), true],
  ])(
    "keeps the file alone when the developer %s the GitHub Actions offer",
    async (_, answer, cancelled) => {
      setConfiguredSecrets(envSecrets());
      const set = vi.fn(async () => {});
      confirm.mockResolvedValue(answer);
      isCancel.mockImplementation((value) => cancelled && value === answer);

      await expect(
        withTTY(true, () =>
          ensure({
            name: "asc-api-key",
            cacheDir,
            githubSecrets: () => ({ name: "github", get: vi.fn(), set }),
          }),
        ),
      ).resolves.toMatchObject({ status: "saved" });
      expect(confirm).toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(issued.revoke).not.toHaveBeenCalled();
      isCancel.mockImplementation(() => false);
    },
  );

  it("reports a failed GitHub Actions write, keeping the key in its file", async () => {
    setConfiguredSecrets(envSecrets());
    confirm.mockResolvedValue(true);
    await expect(
      withTTY(true, () =>
        ensure({
          name: "asc-api-key",
          cacheDir,
          githubSecrets: () => ({
            name: "github",
            get: vi.fn(),
            set: vi.fn(async () => {
              throw new Error("HTTP 403");
            }),
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: "saved" });
    const file = path.join(cacheDir, "issued", "asc-api-key.json");
    expect(log.warn).toHaveBeenLastCalledWith(
      `Storing HOT_UPDATER_ASC_API_KEY in acme/app's GitHub Actions secrets failed: HTTP 403\nStore the contents of ${file} as that secret yourself.`,
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ["no GitHub remote", { remote: undefined }],
    ["no GitHub token", { token: undefined }],
    ["a remote elsewhere", { remote: "https://gitlab.com/acme/app.git" }],
  ])("offers nothing with %s", async (_, lookup) => {
    setConfiguredSecrets(envSecrets());
    Object.assign(git, lookup);
    const githubSecrets = vi.fn();
    await withTTY(true, () =>
      ensure({ name: "asc-api-key", cacheDir, githubSecrets }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(githubSecrets).not.toHaveBeenCalled();
  });

  it("issues a key after the checks, stores it as one JSON value, and reads it back", async () => {
    const { calls, held } = fakeStore();

    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).resolves.toEqual({ status: "issued", keyId: "KEY1234567" });

    expect(calls).toEqual([
      "get asc-api-key",
      "set asc-api-key",
      "get asc-api-key",
    ]);
    const stored = held.get("asc-api-key")!;
    expect(JSON.parse(stored)).toEqual({
      keyId: "KEY1234567",
      issuerId: "issuer-1",
      p8: P8,
    });
    expect(maskSecretValues(`${stored}\n${P8}`)).not.toContain("MIGHAgEA");
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "ADMIN",
        appleId: "dev@example.com",
        // App Store Connect refuses a long key name (TOO_LONG at 48
        // characters), so it carries only the date.
        name: expect.stringMatching(/^hot-updater \d{4}-\d{2}-\d{2}$/u),
      }),
    );
    // Hot Updater asks only for the Apple Account's email.
    expect(text).toHaveBeenCalledTimes(1);
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("revokes the key with its session when the adapter does not keep it", async () => {
    fakeStore({ setError: new Error("AccessDenied: PutSecretValue") });
    const error = await withTTY(true, () =>
      ensure({ name: "asc-api-key" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AscApiKeyNotStoredError);
    expect(error).toMatchObject({ keyId: "KEY1234567", revoked: true });
    expect((error as Error).message).toBe(
      "The App Store Connect API key KEY1234567 was not stored, so it was revoked again: AccessDenied: PutSecretValue",
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
    // Revoked before the session ends.
    expect(issued.revoke.mock.invocationCallOrder[0]!).toBeLessThan(
      issued.dispose.mock.invocationCallOrder[0]!,
    );
  });

  it("names the key to revoke by hand when the revoke fails too", async () => {
    fakeStore({ setError: new Error("AccessDenied") });
    issued.revoke.mockResolvedValueOnce(false);
    const error = await withTTY(true, () =>
      ensure({ name: "asc-api-key" }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ revoked: false });
    expect((error as Error).message).toContain(
      "was not stored, and revoking it failed: revoke KEY1234567 at https://appstoreconnect.apple.com/access/integrations/api.",
    );
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the key when a failed write still landed", async () => {
    let stored: string | undefined;
    fakeStore({
      setError: new Error("socket hang up"),
      readBack: async () => stored,
    });
    issue.mockImplementationOnce(async (request) => {
      stored = JSON.stringify({
        keyId: "KEY1234567",
        issuerId: "issuer-1",
        p8: P8,
      });
      return {
        p8: P8,
        keyId: "KEY1234567",
        issuerId: "issuer-1",
        name: request.name,
        team: {},
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).resolves.toEqual({ status: "issued", keyId: "KEY1234567" });
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("keeps the key when the adapter reads back another value", async () => {
    fakeStore({ readBack: async () => '{"keyId":"OTHER"}' });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toThrow(
      "Hot Updater could not confirm that the spec-store secrets adapter stored asc-api-key: the spec-store secrets adapter stored asc-api-key, and reads back another value.\nThe key KEY1234567 is kept. Check spec://asc-api-key",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("keeps the key when nothing confirms whether the adapter stored it", async () => {
    fakeStore({
      setError: new Error("socket hang up"),
      readBack: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toThrow(
      "Hot Updater could not confirm that the spec-store secrets adapter stored asc-api-key: socket hang up",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("keeps a copy of a key a write-only adapter stored, which this run reads, and never revokes it", async () => {
    const { held } = fakeStore({ readBack: async () => undefined });
    const result = await withTTY(true, () => ensure({ name: "asc-api-key" }));

    const file = path.join(cacheDir, "issued", "asc-api-key.json");
    expect(result).toMatchObject({ status: "issued", keyId: "KEY1234567" });
    const copy = await fs.readFile(file, "utf-8");
    expect(copy).toBe(held.get("asc-api-key"));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const { secrets } = result as { secrets: SecretsAdapter };
    await expect(
      secrets.get(["asc-api-key"], { cwd: cacheDir }),
    ).resolves.toEqual({ "asc-api-key": copy });

    const guidance = stripVTControlCharacters(
      String(log.warn.mock.calls[0]![0]),
    );
    expect(guidance).toContain("App Store Connect API key copied to a file");
    expect(guidance).toContain(
      "The spec-store secrets adapter stored asc-api-key (spec://asc-api-key), and does not read it back here",
    );
    // Builds read the per-field variables before any adapter; the whole
    // value would go through env(), which is not the config's adapter.
    expect(guidance).toContain(
      "Set HOT_UPDATER_ASC_KEY to its p8, HOT_UPDATER_ASC_KEY_ID to its keyId, HOT_UPDATER_ASC_ISSUER_ID to its issuerId (the file's fields) in the environment or .env.hotupdater",
    );
    expect(guidance).not.toContain("HOT_UPDATER_ASC_API_KEY");
    expect(printed()).not.toContain("MIGHAgEA");
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);

    // The next sign-in for it stops at the copy, issuing no other key.
    vi.clearAllMocks();
    const refusal = await withTTY(true, () =>
      ensure({ name: "asc-api-key" }),
    ).catch((error: unknown) => String(error));
    expect(refusal).toContain("which builds here do not read yet.");
    expect(refusal).toContain("HOT_UPDATER_ASC_KEY_ID to its keyId");
    expect(refusal).not.toContain("HOT_UPDATER_ASC_API_KEY");
    expect(issue).not.toHaveBeenCalled();
  });

  it("uses the key from memory when its copy can't be written", async () => {
    fakeStore({ readBack: async () => undefined });
    const notADirectory = path.join(cacheDir, "file");
    await fs.writeFile(notADirectory, "");
    const result = await withTTY(true, () =>
      ensure({ name: "asc-api-key", cacheDir: notADirectory }),
    );
    const { secrets } = result as { secrets: SecretsAdapter };
    expect(
      JSON.parse(
        (await secrets.get(["asc-api-key"], { cwd: cacheDir }))["asc-api-key"]!,
      ),
    ).toMatchObject({ keyId: "KEY1234567", p8: P8 });
    expect(String(log.warn.mock.calls[0]![0])).toContain("Writing a copy to");
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("stores through a class adapter, keeping its methods and their receiver", async () => {
    class FileStore implements SecretsAdapter {
      readonly name = "class-store";
      #held = new Map<string, string>();
      async get(names: readonly string[]) {
        return Object.fromEntries(
          names.map((name) => [name, this.#held.get(name)]),
        );
      }
      async set(name: string, value: string) {
        this.#held.set(name, value);
      }
    }
    const store = new FileStore();
    setConfiguredSecrets(store);

    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).resolves.toEqual({ status: "issued", keyId: "KEY1234567" });
    expect(
      JSON.parse((await store.get(["asc-api-key"]))["asc-api-key"]!),
    ).toMatchObject({
      keyId: "KEY1234567",
    });
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("asks which team when the sign-in landed in another", async () => {
    fakeStore();
    confirm.mockResolvedValueOnce(false);
    text
      .mockResolvedValueOnce("dev@example.com")
      .mockResolvedValueOnce(" OTHERTEAM ");
    let chosen: string | undefined;
    issue.mockImplementationOnce(async (request) => {
      chosen = await request.chooseTeam?.({ developerTeamId: "ABCDE12345" });
      return {
        p8: P8,
        keyId: "KEY1234567",
        issuerId: "issuer-1",
        name: request.name,
        team: { teamId: chosen },
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    await withTTY(true, () => ensure({ name: "asc-api-key" }));
    expect(confirm).toHaveBeenCalledWith({
      message: "Create the key in the team ABCDE12345?",
    });
    expect(chosen).toBe("OTHERTEAM");
  });

  it("issues a key for secrets issue --replace whatever the adapter holds, without reading it again", async () => {
    const previous = JSON.stringify({
      keyId: "OLDKEY0001",
      issuerId: "i",
      p8: "old",
    });
    const { calls, held } = fakeStore({ values: { "asc-api-key": previous } });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", replace: true })),
    ).resolves.toEqual({ status: "issued", keyId: "KEY1234567" });
    // One write and its read-back: no read before the sign-in.
    expect(calls).toEqual(["set asc-api-key", "get asc-api-key"]);
    expect(JSON.parse(held.get("asc-api-key")!)).toMatchObject({
      keyId: "KEY1234567",
    });
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("keeps the new key when a failed write reads back the key it replaces, as a lagging latest version does", async () => {
    const previous = JSON.stringify({
      keyId: "OLDKEY0001",
      issuerId: "i",
      p8: "old",
    });
    fakeStore({
      values: { "asc-api-key": previous },
      setError: new Error("latest still resolves to the old version"),
      readBack: async () => previous,
    });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", replace: true })),
    ).rejects.toThrow(
      "Hot Updater could not confirm that the spec-store secrets adapter stored asc-api-key: latest still resolves to the old version\nThe key KEY1234567 is kept.",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });
});
