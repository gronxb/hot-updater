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

const { log, text, select, open } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  select: vi.fn(),
  open: vi.fn(async () => {}),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log, text, select, isCancel: vi.fn(() => false) },
}));
vi.mock("open", () => ({ default: open }));
// The GitHub Actions offer has its own specs: here it finds nothing to offer.
vi.mock("./githubSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./githubSecret")>()),
  offerGitHubSecret: vi.fn(async () => "unavailable"),
}));

import type {
  IssuedPlayServiceAccount,
  IssuePlayServiceAccountRequest,
} from "@hot-updater/android-helper";
import {
  p,
  getCwd,
  getLocalKeyFile,
  maskSecretValues,
  setConfiguredSecrets,
  resolveSecretsAdapter,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { CredentialSetupRefusedError } from "./issuedCredential";
import { ensurePlayServiceAccount } from "./playServiceAccount";

const EMAIL = "hot-updater-play@my-app.iam.gserviceaccount.com";
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "my-app",
  client_email: EMAIL,
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
});

/**
 * A secrets adapter, made the config's, that records each call: `set`
 * stores unless `setError` is given, and `readBack` replaces what `get`
 * returns after a write.
 */
const fakeStore = ({
  values = {},
  setError,
  readBack,
}: {
  values?: Record<string, string>;
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
    set: async (name: string, value: string) => {
      calls.push(`set ${name}`);
      written = true;
      if (setError) throw setError;
      held.set(name, value);
    },
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

const INVITE_URL = `https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=${encodeURIComponent(EMAIL)}`;

/**
 * An `IssuePlayServiceAccount` that issues EMAIL's key: what
 * ensurePlayServiceAccount depends on, whichever sign-in implements it
 * (android-helper's specs cover Google's).
 */
const issued = {
  revoke: vi.fn(async () => true),
  dispose: vi.fn(async () => {}),
};
const issue = vi.fn(
  async (
    request: IssuePlayServiceAccountRequest,
  ): Promise<IssuedPlayServiceAccount> => {
    await request.askPackageName();
    await request.onInvite(INVITE_URL, EMAIL);
    return {
      json: KEY_FILE,
      email: EMAIL,
      projectId: "my-app",
      keyId: "abc123",
      revoke: issued.revoke,
      dispose: issued.dispose,
    };
  },
);

/** A directory of the spec's own; `home` in it is `localSecrets()`'s store's home. */
let tmp: string;

/** Where `localSecrets()`'s store keeps `name` for the project. */
const keyFile = (name: string) => getLocalKeyFile(name, getCwd());

/** ensurePlayServiceAccount with the stand-in sign-in. */
const ensure = (options: Parameters<typeof ensurePlayServiceAccount>[0]) =>
  ensurePlayServiceAccount({ issue, ...options });

beforeEach(async () => {
  vi.clearAllMocks();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-play-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(tmp, "home"));
  // The terminal these specs simulate takes a sign-in only outside CI, and
  // CI runners set CI.
  vi.stubEnv("CI", "");
  for (const name of [
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
  ]) {
    vi.stubEnv(name, "");
  }
  text.mockResolvedValue("com.example.app");
  select.mockResolvedValue("my-app");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  setConfiguredSecrets(resolveSecretsAdapter());
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ensurePlayServiceAccount", () => {
  it("uses an environment override as it is, without the secrets adapter", async () => {
    vi.stubEnv("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON", KEY_FILE);
    const { calls } = fakeStore();

    await expect(ensure({ name: "play-service-account" })).resolves.toEqual({
      status: "environment",
    });
    expect(calls).toEqual([]);
    expect(issue).not.toHaveBeenCalled();
  });

  it("uses a stored key without a terminal or a sign-in, as CI does", async () => {
    const { calls } = fakeStore({
      values: { "play-service-account": KEY_FILE },
    });

    await expect(
      withTTY(false, () => ensure({ name: "play-service-account" })),
    ).resolves.toEqual({ status: "stored" });
    expect(calls).toEqual(["get play-service-account"]);
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses without a terminal, with the command that signs in once, and no sign-in", async () => {
    const { calls } = fakeStore();

    await expect(
      withTTY(false, () => ensure({ name: "widget-play" })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    // Too long for the line, the command goes on its own.
    expect(stripVTControlCharacters(String(log.error.mock.calls[0]![0]))).toBe(
      [
        "widget-play (play-service-account) is not in the spec-store secrets adapter.",
        "Can't sign in to your Google Account without a terminal.",
        "Run once in a terminal:",
        "npx hot-updater secrets issue play-service-account widget-play",
      ].join("\n"),
    );
    expect(calls).toEqual(["get widget-play"]);
    expect(issue).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("never signs in in CI, even on a terminal", async () => {
    const { calls } = fakeStore();
    vi.stubEnv("CI", "true");

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Can't sign in to your Google Account in CI (CI is set).",
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual(["get play-service-account"]);
    expect(issue).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("says this machine has no key, stores the issued key in `localSecrets()`'s store, names where to delete old keys, and the next run reuses it", async () => {
    setConfiguredSecrets(resolveSecretsAdapter());

    const result = await withTTY(true, () =>
      ensure({ name: "play-service-account" }),
    );
    const file = keyFile("play-service-account");
    expect(result).toMatchObject({ status: "issued", email: EMAIL });
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(KEY_FILE);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);

    const notice = log.info.mock.calls.findIndex(([message]) =>
      String(message).startsWith("No Play service account on this machine"),
    );
    expect(log.info.mock.calls[notice]![0]).toBe(
      "No Play service account on this machine: signing in issues one.",
    );
    expect(log.info.mock.invocationCallOrder[notice]!).toBeLessThan(
      issue.mock.invocationCallOrder[0]!,
    );
    const stored = stripVTControlCharacters(
      String(log.success.mock.calls[0]![0]),
    );
    expect(stored).toMatch(
      new RegExp(
        `^Play service account stored\\nService account {2}${EMAIL.replaceAll(".", "\\.")}\\nKey ID {11}abc123\\nSource {11}\\S*play-service-account\\.json$`,
        "u",
      ),
    );
    const printed = [...Object.values(log), text, select]
      .flatMap((fn) => fn.mock.calls.flat())
      .map(String)
      .join("\n");
    expect(printed).not.toContain("MIIB");
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await expect(
      withTTY(false, () => ensure({ name: "play-service-account" })),
    ).resolves.toEqual({ status: "stored" });
    expect(issue).not.toHaveBeenCalled();
  });

  it("never signs in in CI with the default store, writing nothing", async () => {
    vi.stubEnv("CI", "true");
    setConfiguredSecrets(resolveSecretsAdapter());
    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(issue).not.toHaveBeenCalled();
    await expect(fs.readdir(tmp)).resolves.toEqual([]);
  });

  it("checks in order, signs in, stores the key's own JSON, and reads it back", async () => {
    const { calls, held } = fakeStore();

    await expect(
      withTTY(true, () =>
        ensure({
          name: "play-service-account",
          packageNames: ["com.example.app"],
        }),
      ),
    ).resolves.toMatchObject({ status: "issued", email: EMAIL });

    expect(calls).toEqual([
      "get play-service-account",
      "set play-service-account",
      "get play-service-account",
    ]);
    expect(held.get("play-service-account")).toBe(KEY_FILE);
    expect(maskSecretValues(KEY_FILE)).not.toContain("MIIB");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "com.example.app" }),
    );
    // Only Play Console's invite opens: gcloud signs in on its own, and no
    // developer account ID is asked for.
    expect(open.mock.calls).toEqual([[INVITE_URL]]);
    expect(text).toHaveBeenCalledTimes(1);
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("names the service account to invite, with the app, and prints the invite link", async () => {
    fakeStore();

    await withTTY(true, () =>
      ensure({
        name: "play-service-account",
        packageNames: ["com.example.app"],
      }),
    );

    expect(log.info).toHaveBeenCalledWith(
      `In Play Console, invite with release access to com.example.app:\n${EMAIL}`,
    );
    expect(
      log.message.mock.calls.map(([message]) =>
        stripVTControlCharacters(String(message)),
      ),
    ).toContain(`If the browser doesn't open, open:\n${INVITE_URL}`);
  });

  it("asks for the package name only once the issuer has found its sign-in tool", async () => {
    fakeStore();
    const gcloudMissing = new Error("gcloud CLI is not installed.");
    issue.mockImplementationOnce(async () => {
      throw gcloudMissing;
    });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toBe(gcloudMissing);
    expect(text).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("offers the account's projects, those with the Play API first, and a new project", async () => {
    fakeStore();
    const picks: (string | null)[] = [];
    issue.mockImplementationOnce(async (request) => {
      await request.askPackageName();
      picks.push(
        await request.chooseProject([
          { projectId: "web", displayName: "Web", playApiEnabled: false },
          { projectId: "my-app", displayName: "My App", playApiEnabled: true },
          { projectId: "shop", playApiEnabled: true },
        ]),
        await request.chooseProject([
          { projectId: "web", displayName: "web", playApiEnabled: false },
        ]),
      );
      return {
        json: KEY_FILE,
        email: EMAIL,
        projectId: "my-app",
        keyId: "abc123",
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    select.mockResolvedValueOnce("shop").mockResolvedValueOnce("");

    await withTTY(true, () => ensure({ name: "play-service-account" }));

    expect(select).toHaveBeenNthCalledWith(1, {
      message: "Google Cloud project for the service account",
      options: [
        { value: "my-app", label: "my-app", hint: "My App, Play API enabled" },
        { value: "shop", label: "shop", hint: "Play API enabled" },
        { value: "web", label: "web", hint: "Web" },
        { value: "", label: "Create a new project" },
      ],
      initialValue: "my-app",
    });
    // Without a project that has the API, a new one is the default.
    expect(select).toHaveBeenNthCalledWith(2, {
      message: "Google Cloud project for the service account",
      options: [
        { value: "web", label: "web" },
        { value: "", label: "Create a new project" },
      ],
      initialValue: "",
    });
    expect(picks).toEqual(["shop", null]);
  });

  it("offers gcloud's Google Accounts, the active one marked, and another account", async () => {
    fakeStore();
    const picks: (string | null)[] = [];
    const accounts = [
      { email: "dev@example.com", active: true },
      { email: "play@example.com", active: false },
    ];
    issue.mockImplementationOnce(async (request) => {
      await request.askPackageName();
      picks.push(
        await request.chooseGoogleAccount(accounts),
        await request.chooseGoogleAccount(accounts),
      );
      return {
        json: KEY_FILE,
        email: EMAIL,
        projectId: "my-app",
        keyId: "abc123",
        revoke: issued.revoke,
        dispose: issued.dispose,
      };
    });
    select.mockResolvedValueOnce("play@example.com").mockResolvedValueOnce("");

    await withTTY(true, () => ensure({ name: "play-service-account" }));

    expect(select).toHaveBeenNthCalledWith(1, {
      message: "Google Account to use",
      options: [
        {
          value: "dev@example.com",
          label: "dev@example.com",
          hint: "gcloud active",
        },
        { value: "play@example.com", label: "play@example.com" },
        { value: "", label: "Sign in with another Google Account" },
      ],
      initialValue: "dev@example.com",
    });
    expect(picks).toEqual(["play@example.com", null]);
  });

  it("goes on when the browser can't open the invite", async () => {
    fakeStore();
    open.mockRejectedValueOnce(new Error("no browser"));

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).resolves.toMatchObject({ status: "issued", email: EMAIL });
  });

  it("deletes the key again when the adapter refuses it, and says what remains", async () => {
    fakeStore({ setError: new Error("PERMISSION_DENIED") });

    const error = await withTTY(true, () =>
      ensure({ name: "play-service-account" }),
    ).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(error?.message).toBe(
      [
        "The spec-store secrets adapter didn't store play-service-account.",
        "PERMISSION_DENIED",
        `The key abc123 was deleted; the next run reuses ${EMAIL}.`,
      ].join("\n"),
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("says where to delete a key the cleanup could not delete", async () => {
    fakeStore({ setError: new Error("PERMISSION_DENIED") });
    issued.revoke.mockResolvedValueOnce(false);

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow(
      "Delete the key abc123 at:\nhttps://console.cloud.google.com/iam-admin/serviceaccounts?project=my-app",
    );
  });

  it("keeps a key the adapter stored though the write failed", async () => {
    fakeStore({
      setError: new Error("socket hang up"),
      readBack: async () => KEY_FILE,
    });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).resolves.toMatchObject({ status: "issued", email: EMAIL });
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("keeps the key, and says what to check, when the adapter cannot say whether it stored it", async () => {
    fakeStore({
      setError: new Error("socket hang up"),
      readBack: async () => {
        throw new Error("socket hang up");
      },
    });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow(
      [
        "Couldn't confirm the spec-store secrets adapter stored play-service-account.",
        "socket hang up",
        "If spec://play-service-account lacks key abc123, delete it at:",
        "https://console.cloud.google.com/iam-admin/serviceaccounts?project=my-app",
      ].join("\n"),
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("deletes a key a write-only adapter doesn't read back, and copies it nowhere", async () => {
    fakeStore({ readBack: async () => undefined });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).rejects.toThrow(
      [
        "The spec-store secrets adapter didn't store play-service-account.",
        "The spec-store secrets adapter reads back nothing for play-service-account.",
        `The key abc123 was deleted; the next run reuses ${EMAIL}.`,
      ].join("\n"),
    );
    expect(issued.revoke).toHaveBeenCalledTimes(1);
    await expect(fs.access(keyFile("play-service-account"))).rejects.toThrow();
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
