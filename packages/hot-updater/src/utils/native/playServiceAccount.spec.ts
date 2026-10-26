import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

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
  envSecrets,
  maskSecretValues,
  setConfiguredSecrets,
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
    await request.onSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?x");
    await request.askDeveloperId();
    await request.chooseProject([{ projectId: "my-app" }]);
    return {
      json: KEY_FILE,
      email: EMAIL,
      projectId: "my-app",
      developerId: "1234",
      keyId: "abc123",
      revoke: issued.revoke,
      dispose: issued.dispose,
    };
  },
);

let cacheDir: string;

/** ensurePlayServiceAccount with the stand-in sign-in, and a cacheDir of its own. */
const ensure = (options: Parameters<typeof ensurePlayServiceAccount>[0]) =>
  ensurePlayServiceAccount({ issue, cacheDir, ...options });

beforeEach(async () => {
  vi.clearAllMocks();
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-play-"));
  // The terminal these specs simulate takes a sign-in only outside CI, and
  // CI runners set CI.
  vi.stubEnv("CI", "");
  for (const name of [
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID",
    "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET",
  ]) {
    vi.stubEnv(name, "");
  }
  text.mockImplementation(async ({ message }: { message: string }) =>
    message.includes("developer account") ? "1234" : "com.example.app",
  );
  select.mockResolvedValue("my-app");
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
  setConfiguredSecrets(envSecrets());
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
    expect(log.error).toHaveBeenCalledWith(
      `widget-play (play-service-account) is not in the spec-store secrets adapter (spec://widget-play). Store it once from a terminal with \`npx hot-updater secrets issue play-service-account widget-play\`, which signs in and stores the key Hot Updater issues, and builds, CI's included, read it from there. Hot Updater signs in to your Google Account to issue it only at a terminal, never without a terminal. Or set HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH (or HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON) to provide play-service-account from the environment.`,
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
      expect.stringContaining("never in CI (CI is set)"),
    );
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual(["get play-service-account"]);
    expect(issue).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("writes the key a read-only adapter can't store to a 0600 file, says where to store it, and keeps it", async () => {
    setConfiguredSecrets(envSecrets());
    const cacheDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-play-"),
    );
    try {
      const result = await withTTY(true, () =>
        ensure({ name: "play-service-account", cacheDir }),
      );
      const file = path.join(cacheDir, "issued", "play-service-account.json");
      expect(result).toMatchObject({ status: "saved", email: EMAIL, file });
      await expect(fs.readFile(file, "utf-8")).resolves.toBe(KEY_FILE);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);

      const guidance = stripVTControlCharacters(
        String(log.warn.mock.calls[0]![0]),
      );
      expect(guidance).toContain("Play service account saved to a file");
      expect(guidance).toContain(EMAIL);
      expect(guidance).toContain(
        `Set HOT_UPDATER_PLAY_SERVICE_ACCOUNT to the contents of ${file}, as one value`,
      );
      expect(guidance).toContain("HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON");
      const printed = [...Object.values(log), text, select]
        .flatMap((fn) => fn.mock.calls.flat())
        .map(String)
        .join("\n");
      expect(printed).not.toContain("MIIB");
      expect(issued.revoke).not.toHaveBeenCalled();
      expect(issued.dispose).toHaveBeenCalledTimes(1);

      const { secrets } = result as Extract<typeof result, { status: "saved" }>;
      await expect(
        secrets.get(["play-service-account"], { cwd: cacheDir }),
      ).resolves.toEqual({ "play-service-account": KEY_FILE });
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("never signs in in CI with a read-only adapter, writing no file", async () => {
    vi.stubEnv("CI", "true");
    setConfiguredSecrets(envSecrets());
    const cacheDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-play-"),
    );
    try {
      await expect(
        withTTY(true, () => ensure({ name: "play-service-account", cacheDir })),
      ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
      expect(issue).not.toHaveBeenCalled();
      await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("checks in order, signs in, stores the key's own JSON, and reads it back", async () => {
    const { calls, held } = fakeStore();

    await expect(
      withTTY(true, () =>
        ensure({
          name: "play-service-account",
          packageName: "com.example.app",
        }),
      ),
    ).resolves.toEqual({ status: "issued", email: EMAIL });

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
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "com.example.app" }),
    );
    expect(open).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?x",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("signs in with the OAuth client the environment names", async () => {
    vi.stubEnv(
      "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID",
      "mine.apps.googleusercontent.com",
    );
    vi.stubEnv("HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET", "GOCSPX-mine");
    fakeStore();

    await withTTY(true, () => ensure({ name: "play-service-account" }));

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthClient: {
          clientId: "mine.apps.googleusercontent.com",
          clientSecret: "GOCSPX-mine",
        },
      }),
    );
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
        "The spec-store secrets adapter did not store play-service-account: PERMISSION_DENIED",
        "The key abc123 was deleted again.",
        `The service account ${EMAIL} and its Play Console access remain, and the next run reuses them.`,
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
      "Deleting the key abc123 failed: delete it under the service account's keys at https://console.cloud.google.com/iam-admin/serviceaccounts?project=my-app.",
    );
  });

  it("keeps a key the adapter stored though the write failed", async () => {
    fakeStore({
      setError: new Error("socket hang up"),
      readBack: async () => KEY_FILE,
    });

    await expect(
      withTTY(true, () => ensure({ name: "play-service-account" })),
    ).resolves.toEqual({ status: "issued", email: EMAIL });
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
      `Hot Updater could not confirm that the spec-store secrets adapter stored play-service-account: socket hang up\nThe key abc123 is kept. Check spec://play-service-account: when it holds the key, run the build again; when it does not, delete the key under the service account ${EMAIL} in Google Cloud, then run this again.`,
    );
    expect(issued.revoke).not.toHaveBeenCalled();
  });

  it("keeps a copy of a key a write-only adapter stored, which this run reads", async () => {
    fakeStore({ readBack: async () => undefined });

    const result = await withTTY(true, () =>
      ensure({ name: "play-service-account" }),
    );
    expect(result).toMatchObject({ status: "issued", email: EMAIL });
    const file = path.join(cacheDir, "issued", "play-service-account.json");
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(KEY_FILE);
    const { secrets } = result as { secrets: SecretsAdapter };
    await expect(
      secrets.get(["play-service-account"], { cwd: cacheDir }),
    ).resolves.toEqual({ "play-service-account": KEY_FILE });
    expect(issued.revoke).not.toHaveBeenCalled();
  });
});
