// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import type {
  AnyHotUpdaterPlugin,
  EngineDatabase,
  HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { insights, vault, type VaultApi } from "@hot-updater/server/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRuntime } from "./server/runtime.server";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  // The access middleware runs in the server; these specs call handlers
  // directly, through their validators.
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => {
    let validate = (data: unknown) => data;
    return {
      middleware() {
        return this;
      },
      validator(validator: (data: unknown) => unknown) {
        validate = validator;
        return this;
      },
      handler(handler: (input: { data: unknown }) => unknown) {
        return async (input: { data?: unknown } = {}) =>
          handler({ data: validate(input.data) });
      },
    };
  },
}));
vi.mock("./server/config.server", () => ({ prepareConfig: mocks.prepare }));

import {
  getVaultStatusRpc,
  issueVaultTokenRpc,
  listVaultSecretsRpc,
  listVaultTokensRpc,
  putVaultSecretRpc,
  removeVaultSecretRpc,
  revokeVaultTokenRpc,
} from "./vault-rpc";

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const KEYSTORE = {
  keystore: btoa("\u0000keystore"),
  storePassword: "store-secret",
  keyAlias: "upload",
  keyPassword: "key-secret",
};

/** The console over `database`, running `plugins` as the server does. */
const databaseRuntime = (
  database: EngineDatabase,
  plugins: readonly AnyHotUpdaterPlugin[],
) => {
  const hotUpdater = createHotUpdater({
    database,
    storage: mockStorage({}),
    plugins,
    clientAccess: "public",
  } as unknown as Parameters<typeof createHotUpdater>[0]);
  return {
    runtime: createConsoleRuntime({ database, plugins, api: hotUpdater.api }),
    api: hotUpdater.api as { readonly vault: VaultApi },
  };
};

const console_ = (options: { readonly masterKey?: string } = {}) => {
  const opened = databaseRuntime(
    { name: "memory", adapter: createMemoryAdapter() },
    [vault(options)],
  );
  mocks.prepare.mockResolvedValue({ runtime: opened.runtime });
  return opened;
};

afterEach(() => vi.resetAllMocks());

describe("vault RPC", () => {
  it("stores a secret write-only: the list and the reply carry its metadata, never its value", async () => {
    const { api } = console_({ masterKey: MASTER_KEY });

    const saved = await putVaultSecretRpc({
      data: {
        name: "release-keystore",
        kind: "android-keystore",
        value: KEYSTORE,
        expectedVersion: 0,
      },
    });
    const listed = await listVaultSecretsRpc();

    expect(saved).toMatchObject({
      name: "release-keystore",
      kind: "android-keystore",
      version: 1,
      metadata: { keyAlias: "upload" },
    });
    expect(listed).toEqual([saved]);
    for (const value of Object.values(KEYSTORE).filter(
      (value) => value !== KEYSTORE.keyAlias,
    )) {
      expect(JSON.stringify([saved, listed])).not.toContain(value);
    }
    await expect(
      api.vault.reveal({ id: saved.id, actor: "spec" }),
    ).resolves.toEqual(KEYSTORE);
  });

  it("stores an overwrite as the next version", async () => {
    console_({ masterKey: MASTER_KEY });
    const input = {
      name: "deploy",
      kind: "deploy-credentials",
      value: { A: "1" },
    };

    await putVaultSecretRpc({ data: { ...input, expectedVersion: 0 } });
    const overwritten = await putVaultSecretRpc({
      data: { ...input, value: { A: "2", B: "3" }, expectedVersion: 1 },
    });

    expect(overwritten).toMatchObject({
      version: 2,
      metadata: { variables: ["A", "B"] },
    });
  });

  it("never lets an add replace a secret, nor an overwrite replace a newer version or a deleted one", async () => {
    console_({ masterKey: MASTER_KEY });
    const input = { name: "deploy", kind: "generic", value: { A: "1" } };
    const saved = await putVaultSecretRpc({
      data: { ...input, expectedVersion: 0 },
    });

    await expect(
      putVaultSecretRpc({
        data: { ...input, value: { A: "2" }, expectedVersion: 0 },
      }),
    ).rejects.toThrow('A secret is already named "deploy".');
    await putVaultSecretRpc({ data: { ...input, expectedVersion: 1 } });
    await expect(
      putVaultSecretRpc({ data: { ...input, expectedVersion: 1 } }),
    ).rejects.toThrow("is at version 2 now, not 1");
    await removeVaultSecretRpc({ data: { id: saved.id } });
    await expect(
      putVaultSecretRpc({ data: { ...input, expectedVersion: 2 } }),
    ).rejects.toThrow('No secret is named "deploy" anymore.');
    await expect(listVaultSecretsRpc()).resolves.toEqual([]);
    await expect(
      putVaultSecretRpc({ data: { ...input } as never }),
    ).rejects.toThrow("expected version");
  });

  it("refuses a value that is not its kind's shape, naming the field", async () => {
    console_({ masterKey: MASTER_KEY });

    await expect(
      putVaultSecretRpc({
        data: {
          name: "asc-api-key",
          kind: "asc-api-key",
          value: { p8: base64("not a key"), keyId: "A", issuerId: "B" },
          expectedVersion: 0,
        },
      }),
    ).rejects.toThrow("has p8 as a .p8 private key");
    await expect(
      putVaultSecretRpc({
        data: { name: "x", kind: "ssh-key", value: {}, expectedVersion: 0 },
      }),
    ).rejects.toThrow("Unknown secret kind.");
    await expect(listVaultSecretsRpc()).resolves.toEqual([]);
  });

  it("passes the vault's 64 KB limit on as its message", async () => {
    console_({ masterKey: MASTER_KEY });

    await expect(
      putVaultSecretRpc({
        data: {
          name: "big",
          kind: "android-keystore",
          value: { ...KEYSTORE, keystore: btoa("x".repeat(64 * 1024)) },
          expectedVersion: 0,
        },
      }),
    ).rejects.toThrow("holds up to 65536 bytes");
  });

  it("reports a locked vault as data, and still deletes and manages tokens", async () => {
    const adapter = createMemoryAdapter();
    const { api } = databaseRuntime({ name: "memory", adapter }, [
      vault({ masterKey: MASTER_KEY }),
    ]);
    const stored = await api.vault.put({
      name: "generic",
      kind: "generic",
      value: { A: "1" },
    });
    // The same tables, opened by a console without the key.
    mocks.prepare.mockResolvedValue({
      runtime: databaseRuntime({ name: "memory", adapter }, [vault()]).runtime,
    });

    await expect(getVaultStatusRpc()).resolves.toEqual({
      locked: true,
      message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEY"),
    });
    await expect(
      putVaultSecretRpc({
        data: {
          name: "generic",
          kind: "generic",
          value: { A: "2" },
          expectedVersion: 1,
        },
      }),
    ).rejects.toThrow("The vault is locked");
    await expect(
      issueVaultTokenRpc({
        data: {
          name: "CI",
          scope: { secrets: { kinds: ["generic"] }, actions: ["read"] },
        },
      }),
    ).resolves.toMatchObject({ token: expect.stringMatching(/^hu_vault_/u) });
    await expect(
      removeVaultSecretRpc({ data: { id: stored.id } }),
    ).resolves.toMatchObject({ id: stored.id });
  });

  it("is unlocked with a master key", async () => {
    console_({ masterKey: MASTER_KEY });

    await expect(getVaultStatusRpc()).resolves.toEqual({ locked: false });
  });

  it("deletes a secret by id", async () => {
    console_({ masterKey: MASTER_KEY });
    const saved = await putVaultSecretRpc({
      data: {
        name: "generic",
        kind: "generic",
        value: { A: "1" },
        expectedVersion: 0,
      },
    });

    await expect(
      removeVaultSecretRpc({ data: { id: saved.id } }),
    ).resolves.toMatchObject({ id: saved.id });
    await expect(listVaultSecretsRpc()).resolves.toEqual([]);
    await expect(
      removeVaultSecretRpc({ data: { id: saved.id } }),
    ).rejects.toThrow("already deleted");
    await expect(
      removeVaultSecretRpc({ data: { id: "tok-aaaaaaaaaaaaaaaaaaaaaa" } }),
    ).rejects.toThrow("Invalid secret id.");
  });

  it("issues a token once, lists it without the token, and revokes it", async () => {
    console_({ masterKey: MASTER_KEY });

    const { token, metadata } = await issueVaultTokenRpc({
      data: {
        name: "CI",
        scope: { secrets: { names: ["asc-api-key"] }, actions: ["read"] },
        expiresAtMs: Date.now() + 60_000,
      },
    });
    const listed = await listVaultTokensRpc();

    expect(listed).toEqual([metadata]);
    expect(JSON.stringify(listed)).not.toContain(token);
    await expect(
      revokeVaultTokenRpc({ data: { id: metadata.id } }),
    ).resolves.toMatchObject({ revokedAtMs: expect.any(Number) });
  });

  it("passes the vault's scope messages on", async () => {
    console_({ masterKey: MASTER_KEY });

    await expect(
      issueVaultTokenRpc({
        data: { name: "CI", scope: { secrets: {}, actions: ["read"] } },
      }),
    ).rejects.toThrow("names at least one secret or kind");
    await expect(
      issueVaultTokenRpc({
        data: {
          name: "CI",
          scope: { secrets: { kinds: ["generic"] }, actions: [] },
        },
      }),
    ).rejects.toThrow("at least one action");
  });

  it.each([
    [
      "without vault()",
      () =>
        databaseRuntime({ name: "memory", adapter: createMemoryAdapter() }, [
          insights(),
        ]).runtime,
      "without the vault() plugin",
    ],
    [
      "for a self-hosted server, whose database it does not open",
      () =>
        createConsoleRuntime({
          database: {
            name: "standalone-repository",
            core: {} as HotUpdaterCoreApi,
            fetchAdmin: vi.fn(),
          },
          plugins: [vault()],
        }),
      "reaches a self-hosted server",
    ],
  ])("refuses the vault %s", async (_case, runtime, message) => {
    mocks.prepare.mockResolvedValue({ runtime: runtime() });
    const refused = {
      name: "ConsoleFeatureUnavailableError",
      feature: "vault",
      message: expect.stringContaining(message),
    };

    await expect(getVaultStatusRpc()).rejects.toMatchObject(refused);
    await expect(listVaultSecretsRpc()).rejects.toMatchObject(refused);
    await expect(listVaultTokensRpc()).rejects.toMatchObject(refused);
  });
});
