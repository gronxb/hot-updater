// @vitest-environment node

import { generateKeyPairSync, verify } from "node:crypto";

import { mockStorage } from "@hot-updater/mock";
import {
  type AnyHotUpdaterPlugin,
  createEngine,
  createMemoryAdapter,
  type DatabaseAdapter,
  type HotUpdaterCoreApi,
  type RemoteDatabase,
  REMOTE_BUNDLE_SIGNING_TOKEN_HEADER,
  remoteSigning,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  apiKeys,
  type VaultApi,
  vault,
  type VaultTokenScope,
} from "@hot-updater/server/plugins";
import { describe, expect, it, vi } from "vitest";

import { createConsoleRuntime } from "./runtime.server";
import {
  type LoadConsole,
  resolveVaultSecrets,
  serveVaultSigning,
} from "./vaultRoutes";

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const CONSOLE = "https://console.example.com";
const SIGNING_URL = `${CONSOLE}/_hot-updater/signing`;

const rsaKeys = (modulusLength = 2048, type: "pkcs8" | "pkcs1" = "pkcs8") => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
  });
  return {
    privateKey,
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    /** The value a `bundle-signing-key` holds: the PEM file in base64. */
    value: {
      privateKey: Buffer.from(
        privateKey.export({ format: "pem", type }).toString(),
      ).toString("base64"),
    },
  };
};

const KEY = rsaKeys();
const message = new Uint8Array(32).fill(7);

/**
 * The console over one in-memory database, running `vault()` with the
 * console's master key, and a bundle signing key in its vault.
 */
const start = async (options: { readonly masterKey?: string | null } = {}) => {
  const adapter: DatabaseAdapter = createMemoryAdapter();
  const masterKey =
    options.masterKey === undefined ? MASTER_KEY : options.masterKey;
  const plugin = vault(masterKey === null ? {} : { masterKey });
  const plugins: AnyHotUpdaterPlugin[] = [apiKeys(), plugin];
  const database = { name: "memory", adapter };
  const runtime = createConsoleRuntime({
    database,
    plugins,
    api: createHotUpdater({
      database,
      storage: mockStorage({}),
      plugins,
    } as Parameters<typeof createHotUpdater>[0]).api,
  });
  const seeding = createHotUpdater({
    database,
    storage: mockStorage({}),
    plugins: [apiKeys(), vault({ masterKey: MASTER_KEY })],
  } as Parameters<typeof createHotUpdater>[0]).api.vault as VaultApi;
  const signing = await seeding.put({
    name: "bundle-signing-key",
    kind: "bundle-signing-key",
    value: KEY.value,
  });
  const auditDb = createEngine(database, { plugins: [plugin] }).database(
    plugin,
  );
  return {
    load: vi.fn<LoadConsole>(async () => ({ runtime })),
    vault: seeding,
    signing,
    issue: async (scope: VaultTokenScope) =>
      (await seeding.issueToken({ name: "ci", scope })).token,
    audit: async () =>
      (
        await auditDb.findMany("audit", {
          index: "byTime",
          where: {},
          limit: 100,
        })
      ).rows,
  };
};

const SIGN_KEY: VaultTokenScope = {
  secrets: { names: ["bundle-signing-key"] },
  actions: ["sign"],
};

/** The fetch `remoteSigning` sends through, answered by the console's route. */
const consoleFetch = (load: LoadConsole) =>
  vi.fn<typeof globalThis.fetch>(async (input, init) =>
    serveVaultSigning(new Request(input, init), load),
  );

const request = (
  load: LoadConsole,
  headers: Record<string, string>,
  init: RequestInit = {},
) =>
  serveVaultSigning(
    new Request(SIGNING_URL, { ...init, headers: { ...headers } }),
    load,
  );

const signingToken = (token: string) => ({
  [REMOTE_BUNDLE_SIGNING_TOKEN_HEADER]: token,
});

describe("GET and POST /_hot-updater/signing", () => {
  it("signs for remoteSigning with a vault token whose scope allows sign, and logs the signature", async () => {
    const { load, issue, signing, audit } = await start();
    const token = await issue(SIGN_KEY);
    const fetch = consoleFetch(load);
    const signer = remoteSigning({
      endpoint: CONSOLE,
      fetch,
      signingToken: token,
    });

    await expect(signer.getPublicKey()).resolves.toEqual({
      publicKey: KEY.publicKey,
    });
    const { signature } = await signer.sign({ message });

    expect(String(fetch.mock.calls[0]![0])).toBe(SIGNING_URL);
    expect(verify("RSA-SHA256", message, KEY.publicKey, signature)).toBe(true);
    await expect(audit()).resolves.toEqual([
      expect.objectContaining({
        action: "sign",
        outcome: "allowed",
        secret_id: signing.id,
        context: { name: "bundle-signing-key" },
      }),
    ]);
  });

  it("signs with a PKCS#1 key, as openssl genrsa writes one", async () => {
    const { load, vault: api, issue } = await start();
    const pkcs1 = rsaKeys(3072, "pkcs1");
    await api.put({
      name: "bundle-signing-key",
      kind: "bundle-signing-key",
      value: pkcs1.value,
    });
    const signer = remoteSigning({
      endpoint: CONSOLE,
      fetch: consoleFetch(load),
      signingToken: await issue(SIGN_KEY),
    });

    await expect(signer.getPublicKey()).resolves.toEqual({
      publicKey: pkcs1.publicKey,
    });
    const { signature } = await signer.sign({ message });
    expect(verify("RSA-SHA256", message, pkcs1.publicKey, signature)).toBe(
      true,
    );
  });

  it("refuses a request without the signing token before loading the console", async () => {
    const { load, issue } = await start();
    const token = await issue(SIGN_KEY);

    for (const headers of [{}, { authorization: `Bearer ${token}` }] as Record<
      string,
      string
    >[]) {
      const response = await request(load, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "unauthorized",
          message: expect.stringContaining(REMOTE_BUNDLE_SIGNING_TOKEN_HEADER),
        },
      });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses unknown and revoked tokens, and the dedicated static tokens the protocol also takes", async () => {
    const { load, vault: api, audit } = await start();
    const revoked = await api.issueToken({ name: "ci", scope: SIGN_KEY });
    await api.revokeToken({ id: revoked.metadata.id });

    for (const [token, message] of [
      [`hu_vault_${"A".repeat(43)}`, "not one this console issued"],
      ["dedicated-signing-token", "not one this console issued"],
      [revoked.token, "was revoked"],
    ] as const) {
      const response = await request(load, signingToken(token));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "unauthorized",
          message: expect.stringContaining(message),
        },
      });
    }
    await expect(audit()).resolves.toEqual([]);
  });

  it("refuses a token whose scope does not allow sign, such as a read token, and logs it", async () => {
    const { load, issue, audit } = await start();
    const read = await issue({
      secrets: { kinds: ["bundle-signing-key"] },
      actions: ["read", "write"],
    });
    const otherKey = await issue({
      secrets: { names: ["another-key"] },
      actions: ["sign"],
    });

    for (const [token, message] of [
      [read, "does not allow sign"],
      [otherKey, "allows sign on no bundle-signing-key"],
    ] as const) {
      for (const method of ["GET", "POST"]) {
        const response = await request(load, signingToken(token), { method });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "forbidden",
            message: expect.stringContaining(message),
          },
        });
      }
    }
    const rows = await audit();
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({
          action: "sign",
          outcome: "denied",
          secret_id: null,
        }),
      ),
    );
  });

  it("picks the key a token's scope names, and refuses one that reaches several", async () => {
    const { load, vault: api, issue, audit } = await start();
    const widget = rsaKeys();
    await api.put({
      name: "widget-signing-key",
      kind: "bundle-signing-key",
      value: widget.value,
    });
    const byKind = await issue({
      secrets: { kinds: ["bundle-signing-key"] },
      actions: ["sign"],
    });

    const ambiguous = await request(load, signingToken(byKind));
    expect(ambiguous.status).toBe(403);
    await expect(ambiguous.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: expect.stringContaining(
          "bundle-signing-key, widget-signing-key: scope a sign token to one",
        ),
      },
    });
    await expect(audit()).resolves.toEqual([
      expect.objectContaining({
        action: "sign",
        outcome: "denied",
        context: { names: ["bundle-signing-key", "widget-signing-key"] },
      }),
    ]);

    const signer = remoteSigning({
      endpoint: CONSOLE,
      fetch: consoleFetch(load),
      signingToken: await issue({
        secrets: { names: ["widget-signing-key"] },
        actions: ["sign"],
      }),
    });
    await expect(signer.getPublicKey()).resolves.toEqual({
      publicKey: widget.publicKey,
    });
  });

  it("never resolves the signing key, even for a token that may sign and read it", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { names: ["bundle-signing-key"] },
      actions: ["read", "sign"],
    });

    const response = await resolveVaultSecrets(
      new Request(`${CONSOLE}/_hot-updater/vault/v1/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ names: ["bundle-signing-key"] }),
      }),
      load,
    );

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("never resolves");
    expect(body).not.toContain(KEY.value.privateKey);
  });

  it("answers 503 when the console has no master key, and logs no signature", async () => {
    const { load, issue, audit } = await start({ masterKey: null });

    const response = await request(load, signingToken(await issue(SIGN_KEY)));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "vault_locked",
        message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEY"),
      },
    });
    await expect(audit()).resolves.toEqual([]);
  });

  it("names a stored key the console cannot sign with", async () => {
    const { load, vault: api, issue } = await start();
    const token = await issue(SIGN_KEY);

    for (const [value, message] of [
      [rsaKeys(1024).value, "is a 1024-bit RSA key"],
      [
        {
          privateKey: Buffer.from(
            generateKeyPairSync("ec", { namedCurve: "P-256" })
              .privateKey.export({ format: "pem", type: "pkcs8" })
              .toString(),
          ).toString("base64"),
        },
        "holds no unencrypted RSA private key",
      ],
    ] as const) {
      await api.put({
        name: "bundle-signing-key",
        kind: "bundle-signing-key",
        value,
      });
      const response = await request(load, signingToken(token));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "invalid_signing_key",
          message: expect.stringContaining(message),
        },
      });
    }
  });

  it("answers the protocol's 405 for another method once the token is accepted", async () => {
    const { load, issue } = await start();

    const response = await request(load, signingToken(await issue(SIGN_KEY)), {
      method: "DELETE",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  it("serves no signing without a vault: over standaloneRepository", async () => {
    const fetchAdmin = vi.fn<RemoteDatabase["fetchAdmin"]>();
    const runtime = createConsoleRuntime({
      database: {
        name: "standalone-repository",
        core: {} as HotUpdaterCoreApi,
        fetchAdmin,
      },
      plugins: [apiKeys(), vault()],
    });

    const response = await request(
      async () => ({ runtime }),
      signingToken(`hu_vault_${"A".repeat(43)}`),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "vault_unavailable" },
    });
    expect(fetchAdmin).not.toHaveBeenCalled();
  });
});
