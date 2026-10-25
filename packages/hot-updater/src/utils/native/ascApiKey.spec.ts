import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { log, text, confirm } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log, text, confirm, isCancel: vi.fn(() => false) },
}));

import type {
  IssueAscApiKeyRequest,
  IssuedAscApiKey,
} from "@hot-updater/apple-helper";
import {
  envSecrets,
  maskSecretValues,
  setConfiguredSecrets,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import {
  AscApiKeyNotStoredError,
  ascApiKeySetupCommand,
  ensureAscApiKey,
} from "./ascApiKey";
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

/** ensureAscApiKey with the stand-in sign-in. */
const ensure = (options: Parameters<typeof ensureAscApiKey>[0]) =>
  ensureAscApiKey({ issue, ...options });

beforeEach(() => {
  vi.clearAllMocks();
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

afterEach(() => {
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
      "widget-asc (asc-api-key) is not in the spec-store secrets adapter (spec://widget-asc). Store it once from a terminal with `npx hot-updater secrets put widget-asc --kind asc-api-key`, which signs in and stores the key Hot Updater issues, and builds, CI's included, read it from there. Hot Updater signs in to your Apple Account to issue it only at a terminal, never without a terminal. Or set HOT_UPDATER_ASC_KEY_PATH (or HOT_UPDATER_ASC_KEY), HOT_UPDATER_ASC_KEY_ID, and HOT_UPDATER_ASC_ISSUER_ID to provide asc-api-key from the environment.",
    );
    expect(ascApiKeySetupCommand("widget-asc")).toBe(
      "npx hot-updater secrets put widget-asc --kind asc-api-key",
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
      withTTY(true, () => ensure({ name: "asc-api-key", read: true })),
    ).rejects.toBeInstanceOf(CredentialSetupRefusedError);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("never in CI (CI is set)"),
    );
    expect(calls).toEqual(["get asc-api-key"]);
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("refuses a read-only adapter before any Apple sign-in", async () => {
    fakeStore({ writable: false });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).rejects.toThrow(
      "asc-api-key is an App Store Connect API key, which Hot Updater issues when you sign in with your Apple Account and stores through the config's secrets adapter, and the spec-store secrets adapter is read-only.",
    );
    expect(text).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("issues a key after the checks, stores it as one JSON value, and reads it back", async () => {
    const { calls, held } = fakeStore();

    await expect(
      withTTY(true, () =>
        ensure({
          name: "asc-api-key",
          bundleIdentifier: "com.example.app",
          read: true,
        }),
      ),
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
        name: expect.stringMatching(
          /^hot-updater com\.example\.app \d{4}-\d{2}-\d{2}$/u,
        ),
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

  it("keeps a key a write-only adapter stored, and says the build can't read it yet", async () => {
    fakeStore({ readBack: async () => undefined });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", read: true })),
    ).rejects.toThrow(
      "asc-api-key is stored, but the spec-store secrets adapter does not read it back, which the build signs and uploads with.",
    );
    expect(issued.revoke).not.toHaveBeenCalled();
    expect(issued.dispose).toHaveBeenCalledTimes(1);
  });

  it("stores in a write-only adapter for secrets put, which reads nothing back", async () => {
    fakeStore({ readBack: async () => undefined });
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key" })),
    ).resolves.toEqual({ status: "issued", keyId: "KEY1234567" });
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
      withTTY(true, () => ensure({ name: "asc-api-key", read: true })),
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

  it("stores through the adapter for secrets put even when the environment overrides the key", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_KEY_ID", "ENVKEY");
    fakeStore();
    await expect(
      withTTY(true, () => ensure({ name: "asc-api-key", environment: false })),
    ).resolves.toMatchObject({ status: "issued" });
  });
});
