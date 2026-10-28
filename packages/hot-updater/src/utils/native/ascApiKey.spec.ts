import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, text, confirm, select, isCancel, git } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn((_answer: unknown) => false),
  /** What `git` and `gh` answer the GitHub offer's lookups with. */
  git: {
    remote: "git@github.com:acme/app.git" as string | undefined,
    token: "gho_specToken" as string | undefined,
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log, text, confirm, select, isCancel },
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
  p,
  getCwd,
  getLocalKeyFile,
  maskSecretValues,
  readLocalKey,
  setConfiguredSecrets,
  withCredentialResolver,
  resolveSecretsAdapter,
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
    team: { appleId: request.appleId, teamId: "team-1", name: "Acme" },
    revoke: issued.revoke,
    dispose: issued.dispose,
  }),
);

/** ensureAscApiKey with the stand-in sign-in. */
const ensure = (options: Parameters<typeof ensureAscApiKey>[0]) =>
  ensureAscApiKey({ issue, ...options });

/** A directory of the spec's own; `home` in it is `localSecrets()`'s store's home. */
let tmp: string;

/** Where `localSecrets()`'s store keeps `name` for the project. */
const keyFile = (name: string) => getLocalKeyFile(name, getCwd());

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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-asc-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(tmp, "home"));
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
  await fs.rm(tmp, { recursive: true, force: true });
  setConfiguredSecrets(resolveSecretsAdapter());
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
    expect(stripVTControlCharacters(String(log.error.mock.calls[0]![0]))).toBe(
      [
        "widget-asc (asc-api-key) is not in the spec-store secrets adapter.",
        "Can't sign in to your Apple Account without a terminal.",
        "Run once in a terminal: npx hot-updater secrets issue asc-api-key widget-asc",
      ].join("\n"),
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
      expect.stringContaining(
        "Can't sign in to your Apple Account in CI (CI is set).",
      ),
    );
    expect(calls).toEqual(["get asc-api-key"]);
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("never signs in in CI with the default store, writing nothing", async () => {
    vi.stubEnv("CI", "true");
    setConfiguredSecrets(resolveSecretsAdapter());
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(issue).not.toHaveBeenCalled();
    await expect(fs.readdir(tmp)).resolves.toEqual([]);
  });

  it("says before signing in that this machine has no key, stores the issued key in `localSecrets()`'s store, and names where to prune old keys", async () => {
    setConfiguredSecrets(resolveSecretsAdapter());
    git.remote = undefined;
    const result = await withTTY(true, () => ensure({ name: "asc-api-key" }));

    expect(result).toMatchObject({ status: "issued", keyId: "KEY1234567" });
    const file = keyFile("asc-api-key");
    expect(file.startsWith(path.join(tmp, "home", "secrets") + path.sep)).toBe(
      true,
    );
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({
      keyId: "KEY1234567",
      issuerId: "issuer-1",
      p8: P8,
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);

    // The notice comes before the Apple prompt and the sign-in.
    const notice = log.info.mock.calls.findIndex(([message]) =>
      String(message).startsWith(
        "No App Store Connect API key on this machine",
      ),
    );
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(log.info.mock.calls[notice]![0]).toBe(
      "No App Store Connect API key on this machine: signing in issues one.",
    );
    expect(log.info.mock.invocationCallOrder[notice]!).toBeLessThan(
      text.mock.invocationCallOrder[0]!,
    );
    const stored = stripVTControlCharacters(
      String(log.success.mock.calls[0]![0]),
    );
    expect(stored).toMatch(
      /^App Store Connect API key stored\nKey ID  KEY1234567\nSource  \S*asc-api-key\.json$/u,
    );
    // The key is in the file alone: nothing printed or asked holds it.
    expect(printed()).not.toContain("MIGHAgEA");
    expect(printed()).not.toContain("BEGIN PRIVATE KEY");
    // No GitHub remote, no offer.
    expect(confirm).not.toHaveBeenCalled();
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);

    // The next build on this machine reuses it, with no sign-in.
    vi.clearAllMocks();
    await expect(
      withTTY(false, () => ensure({ name: "asc-api-key" })),
    ).resolves.toEqual({ status: "stored" });
    expect(issue).not.toHaveBeenCalled();
    const resolved = await withCredentialResolver(async (credentials) => {
      const key = await credentials.resolve({ kind: "asc-api-key" });
      return { ...key, p8: await fs.readFile(key.keyPath, "utf-8") };
    });
    expect(resolved).toMatchObject({
      keyId: "KEY1234567",
      issuerId: "issuer-1",
      p8: P8,
    });
  });

  it("gives no per-machine notice when the config's adapter shares the key", async () => {
    fakeStore();
    await withTTY(true, () => ensure({ name: "asc-api-key" }));
    expect(printed()).not.toContain("on this machine. Signing in issues");
  });

  it("refuses a read-only adapter before any Apple prompt or sign-in", async () => {
    const { calls } = fakeStore({ writable: false });
    await expect(
      withTTY(true, () => ensure({ name: "widget-asc" })),
    ).rejects.toThrow(
      "The spec-store secrets adapter is read-only: store widget-asc there.",
    );
    expect(calls).toEqual(["get widget-asc"]);
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    await expect(readLocalKey("widget-asc", getCwd())).resolves.toBeUndefined();
  });

  it("revokes the key when `localSecrets()`'s store can't be written", async () => {
    setConfiguredSecrets(resolveSecretsAdapter());
    // A file where `localSecrets()`'s store's home goes.
    await fs.writeFile(path.join(tmp, "home"), "");
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toBeInstanceOf(AscApiKeyNotStoredError);
    expect(issued.revoke).toHaveBeenCalledTimes(1);
  });

  it("stores the key as a GitHub Actions secret too, once, when the developer agrees", async () => {
    setConfiguredSecrets(resolveSecretsAdapter());
    const set = vi.fn(async () => {});
    const githubSecrets = vi.fn(() => ({ name: "github", get: vi.fn(), set }));
    confirm.mockResolvedValue(true);

    await withTTY(true, () => ensure({ name: "asc-api-key", githubSecrets }));

    expect(confirm).toHaveBeenLastCalledWith({
      message:
        "Store it as the GitHub Actions secret HOT_UPDATER_ASC_API_KEY in acme/app?",
      initialValue: true,
    });
    expect(githubSecrets).toHaveBeenCalledWith({
      repo: "acme/app",
      token: "gho_specToken",
    });
    expect(set).toHaveBeenCalledExactlyOnceWith(
      "asc-api-key",
      await fs.readFile(keyFile("asc-api-key"), "utf-8"),
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
    "keeps the key on this machine alone when the developer %s the GitHub Actions offer",
    async (_, answer, cancelled) => {
      setConfiguredSecrets(resolveSecretsAdapter());
      const set = vi.fn(async () => {});
      confirm.mockResolvedValue(answer);
      isCancel.mockImplementation((value) => cancelled && value === answer);

      await expect(
        withTTY(true, () =>
          ensure({
            name: "asc-api-key",
            githubSecrets: () => ({ name: "github", get: vi.fn(), set }),
          }),
        ),
      ).resolves.toMatchObject({ status: "issued" });
      expect(confirm).toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(issued.revoke).not.toHaveBeenCalled();
      isCancel.mockImplementation(() => false);
    },
  );

  it("reports a failed GitHub Actions write, keeping the key on this machine", async () => {
    setConfiguredSecrets(resolveSecretsAdapter());
    confirm.mockResolvedValue(true);
    await expect(
      withTTY(true, () =>
        ensure({
          name: "asc-api-key",
          githubSecrets: () => ({
            name: "github",
            get: vi.fn(),
            set: vi.fn(async () => {
              throw new Error("HTTP 403");
            }),
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: "issued" });
    expect(String(log.warn.mock.calls.at(-1)![0])).toMatch(
      /^Couldn't store the GitHub Actions secret HOT_UPDATER_ASC_API_KEY in acme\/app\.\nHTTP 403\nStore this file's contents as that secret:\n[^…\s]*asc-api-key\.json$/u,
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ["no GitHub remote", { remote: undefined }],
    ["no GitHub token", { token: undefined }],
    ["a remote elsewhere", { remote: "https://gitlab.com/acme/app.git" }],
  ])("offers nothing with %s", async (_, lookup) => {
    setConfiguredSecrets(resolveSecretsAdapter());
    Object.assign(git, lookup);
    const githubSecrets = vi.fn();
    await withTTY(true, () => ensure({ name: "asc-api-key", githubSecrets }));
    expect(confirm).not.toHaveBeenCalled();
    expect(githubSecrets).not.toHaveBeenCalled();
  });

  it("issues a key after the checks, stores it as one JSON value, and reads it back", async () => {
    const { calls, held } = fakeStore();

    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).resolves.toMatchObject({ status: "issued", keyId: "KEY1234567" });

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
      "Couldn't store the App Store Connect API key KEY1234567, so it was revoked.\nAccessDenied: PutSecretValue",
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
    expect((error as Error).message).toBe(
      "Couldn't store the App Store Connect API key KEY1234567, or revoke it.\nAccessDenied\nRevoke it at https://appstoreconnect.apple.com/access/integrations/api",
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
    ).resolves.toMatchObject({ status: "issued", keyId: "KEY1234567" });
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another value",
      async () => '{"keyId":"OTHER"}',
      "reads back another value for asc-api-key.",
    ],
    [
      "nothing, as a write-only store does",
      async () => undefined,
      "reads back nothing for asc-api-key.",
    ],
    [
      "an error",
      async () => {
        throw new Error("ThrottlingException");
      },
      "can't read back asc-api-key: ThrottlingException",
    ],
  ])(
    "revokes the key when the adapter reads back %s, and copies it nowhere",
    async (_, readBack, reason) => {
      fakeStore({ readBack });
      // A key planted where localSecrets() keeps keys is neither read nor written.
      await fs.mkdir(path.dirname(keyFile("asc-api-key")), { recursive: true });
      await fs.writeFile(keyFile("asc-api-key"), '{"keyId":"OLDKEY0001"}');

      const error = await withTTY(true, () =>
        ensure({ name: "asc-api-key" }),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AscApiKeyNotStoredError);
      expect((error as Error).message).toBe(
        `Couldn't store the App Store Connect API key KEY1234567, so it was revoked.\nThe spec-store secrets adapter ${reason}`,
      );
      expect(issued.revoke).toHaveBeenCalledTimes(1);
      expect(issued.dispose).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(keyFile("asc-api-key"), "utf-8")).resolves.toBe(
        '{"keyId":"OLDKEY0001"}',
      );
      expect(printed()).not.toContain("copied to this machine");
    },
  );

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
      "Couldn't confirm the spec-store secrets adapter stored asc-api-key.\nsocket hang up\n",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("reads the issued key from memory for the rest of the run, and every other name from the adapter", async () => {
    const { calls } = fakeStore({ values: { other: "kept" } });
    const result = await withTTY(true, () => ensure({ name: "asc-api-key" }));
    const { secrets } = result as { secrets: SecretsAdapter };
    calls.length = 0;

    const read = await secrets.get(["asc-api-key", "other"], { cwd: tmp });

    expect(JSON.parse(read["asc-api-key"]!)).toMatchObject({
      keyId: "KEY1234567",
      p8: P8,
    });
    expect(read["other"]).toBe("kept");
    expect(calls).toEqual(["get other"]);
    await expect(fs.access(keyFile("asc-api-key"))).rejects.toThrow();
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
    ).resolves.toMatchObject({ status: "issued", keyId: "KEY1234567" });
    expect(
      JSON.parse((await store.get(["asc-api-key"]))["asc-api-key"]!),
    ).toMatchObject({
      keyId: "KEY1234567",
    });
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("asks which team when the Apple Account is in several", async () => {
    fakeStore();
    text.mockResolvedValueOnce("dev@example.com");
    select.mockResolvedValueOnce("team-2");
    let chosen: string | undefined;
    issue.mockImplementationOnce(async (request) => {
      chosen = await request.chooseTeam?.(
        [
          { teamId: "team-1", name: "Acme" },
          { teamId: "team-2", name: "Acme Labs" },
        ],
        { teamId: "team-1", name: "Acme" },
      );
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
    expect(select).toHaveBeenCalledWith({
      message: "Team to create the key in",
      initialValue: "team-1",
      options: [
        { value: "team-1", label: "Acme" },
        { value: "team-2", label: "Acme Labs" },
      ],
    });
    expect(chosen).toBe("team-2");
  });

  it("keeps the team the sign-in landed in without asking when it is the only one", async () => {
    fakeStore();
    text.mockResolvedValueOnce("dev@example.com");
    let chosen: string | undefined = "unset";
    issue.mockImplementationOnce(async (request) => {
      chosen = await request.chooseTeam?.([{ teamId: "team-1" }], {
        teamId: "team-1",
      });
      return {
        p8: P8,
        keyId: "KEY1234567",
        issuerId: "issuer-1",
        name: request.name,
        team: { teamId: "team-1" },
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    await withTTY(true, () => ensure({ name: "asc-api-key" }));
    expect(select).not.toHaveBeenCalled();
    expect(chosen).toBeUndefined();
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
    ).resolves.toMatchObject({ status: "issued", keyId: "KEY1234567" });
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
      "Couldn't confirm the spec-store secrets adapter stored asc-api-key.\nlatest still resolves to the old version\nIf spec://asc-api-key lacks key KEY1234567",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
