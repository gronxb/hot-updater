// @vitest-environment node

import { mockStorage } from "@hot-updater/mock";
import {
  type AnyHotUpdaterPlugin,
  createEngine,
  createMemoryAdapter,
  type DatabaseAdapter,
  type HotUpdaterCoreApi,
  type RemoteDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  type ApiKeyManagementAPI,
  apiKeys,
  type VaultApi,
  vault,
  type VaultTokenScope,
} from "@hot-updater/server/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRuntime } from "./runtime.server";
import {
  type LoadConsole,
  listVaultSecrets,
  resolveVaultSecrets,
} from "./vaultRoutes";

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const ASC_KEY = { p8: "-----BEGIN PRIVATE KEY-----", keyId: "ABC" };
const KEYSTORE = { keystore: "AAAA", storePassword: "store" };

/**
 * The console over one in-memory database, running `vault()` with the
 * console's master key beside `apiKeys()`, and the secrets it seeds.
 */
const start = async (options: { readonly masterKey?: string | null } = {}) => {
  const adapter: DatabaseAdapter = createMemoryAdapter();
  const masterKey =
    options.masterKey === undefined ? MASTER_KEY : options.masterKey;
  const plugin = vault(masterKey === null ? {} : { masterKey });
  const plugins: AnyHotUpdaterPlugin[] = [apiKeys(), plugin];
  const database = { name: "memory", adapter };
  const server = createHotUpdater({
    database,
    storage: mockStorage({}),
    plugins,
  } as Parameters<typeof createHotUpdater>[0]);
  const runtime = createConsoleRuntime({ database, plugins, api: server.api });
  // Seeds through a vault that holds the key, whatever the console holds.
  const seeding = createHotUpdater({
    database,
    storage: mockStorage({}),
    plugins: [apiKeys(), vault({ masterKey: MASTER_KEY })],
  } as Parameters<typeof createHotUpdater>[0]).api.vault as VaultApi;
  const asc = await seeding.put({
    name: "asc-api-key",
    kind: "asc-api-key",
    value: ASC_KEY,
    metadata: { keyId: "ABC" },
  });
  const keystore = await seeding.put({
    name: "release-keystore",
    kind: "android-keystore",
    value: KEYSTORE,
  });
  const signing = await seeding.put({
    name: "ota-signing",
    kind: "bundle-signing-key",
    value: "-----BEGIN RSA PRIVATE KEY-----",
  });
  const auditDb = createEngine(database, { plugins: [plugin] }).database(
    plugin,
  );
  const load = vi.fn<LoadConsole>(async () => ({ runtime }));
  return {
    load,
    vault: seeding,
    apiKeys: server.api.apiKeys as ApiKeyManagementAPI,
    secrets: { asc, keystore, signing },
    issue: async (scope: VaultTokenScope, expiresAtMs?: number) =>
      (
        await seeding.issueToken({
          name: "ci",
          scope,
          ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
        })
      ).token,
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

const list = (load: LoadConsole, headers: HeadersInit = {}) =>
  listVaultSecrets(
    new Request("https://console.example.com/_hot-updater/vault/v1/secrets", {
      headers,
    }),
    load,
  );

const resolve = (
  load: LoadConsole,
  token: string | undefined,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  resolveVaultSecrets(
    new Request("https://console.example.com/_hot-updater/vault/v1/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    load,
  );

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const READ_KEYSTORE: VaultTokenScope = {
  secrets: { names: ["release-keystore"] },
  actions: ["read"],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("vault routes: authentication", () => {
  it("refuses a request without a vault token before reading anything, whatever session it carries", async () => {
    const { load } = await start();

    for (const response of [
      await list(load),
      await list(load, { cookie: "better-auth.session_token=session" }),
      await list(load, { authorization: "Basic dXNlcjpwYXNz" }),
      await resolve(load, undefined, { names: ["release-keystore"] }),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="hot-updater-vault"',
      );
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "unauthorized" },
      });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses unknown, revoked, and expired tokens, and client API keys, with 401", async () => {
    // The server takes its clock when it assembles: fake it first.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000_000_000_000);
    const { load, vault: api, apiKeys: keys, issue } = await start();
    const revoked = await api.issueToken({ name: "ci", scope: READ_KEYSTORE });
    await api.revokeToken({ id: revoked.metadata.id });
    const expiring = await issue(READ_KEYSTORE, Date.now() + 1_000);
    const { apiKey } = await keys.create({ name: "app" });
    vi.setSystemTime(Date.now() + 1_000);

    for (const [token, message] of [
      [`hu_vault_${"A".repeat(43)}`, "not one this console issued"],
      [apiKey, "not one this console issued"],
      [`hu_${apiKey}`, "not one this console issued"],
      [revoked.token, "was revoked"],
      [expiring, "expired"],
    ] as const) {
      for (const response of [
        await list(load, bearer(token)),
        await resolve(load, token, { names: ["release-keystore"] }),
      ]) {
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "unauthorized",
            message: expect.stringContaining(message),
          },
        });
      }
    }
  });
});

describe("GET /_hot-updater/vault/v1/secrets", () => {
  it("lists the secrets the token's scope reaches, without values, and logs the list", async () => {
    const { load, issue, secrets, audit } = await start();
    const token = await issue({
      secrets: { names: ["asc-api-key"], kinds: ["bundle-signing-key"] },
      actions: ["read", "sign"],
    });

    const response = await list(load, {
      ...bearer(token),
      "x-hot-updater-ci-run": "github/123",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ secrets: [secrets.asc, secrets.signing] });
    expect(JSON.stringify(body)).not.toContain(ASC_KEY.p8);
    await expect(audit()).resolves.toEqual([
      expect.objectContaining({
        action: "list",
        outcome: "allowed",
        secret_id: null,
        context: { ciRun: "github/123" },
      }),
    ]);
  });
});

describe("POST /_hot-updater/vault/v1/resolve", () => {
  it("returns the values of every secret named, opened with the console's master key", async () => {
    const { load, issue, secrets, audit } = await start();
    const token = await issue({
      secrets: { names: ["release-keystore"], kinds: ["asc-api-key"] },
      actions: ["read"],
    });

    const response = await resolve(
      load,
      token,
      { names: ["release-keystore", "asc-api-key", "release-keystore"] },
      { "x-hot-updater-ci-run": "run-7" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      secrets: [
        {
          name: "release-keystore",
          kind: "android-keystore",
          version: 1,
          value: KEYSTORE,
        },
        {
          name: "asc-api-key",
          kind: "asc-api-key",
          version: 1,
          value: ASC_KEY,
        },
      ],
      errors: [],
    });
    const rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        [secrets.keystore, secrets.asc].map((secret) =>
          expect.objectContaining({
            action: "read",
            outcome: "allowed",
            secret_id: secret.id,
            context: { ciRun: "run-7", name: secret.name },
          }),
        ),
      ),
    );
  });

  it("reports a name the scope lists but no secret has as not found", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { names: ["release-keystore", "play-account"] },
      actions: ["read"],
    });

    const response = await resolve(load, token, {
      names: ["play-account", "release-keystore"],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      secrets: [expect.objectContaining({ name: "release-keystore" })],
      errors: [
        {
          name: "play-account",
          code: "not_found",
          message: "No secret is named play-account.",
        },
      ],
    });
  });

  it("refuses the whole request with 403 when any name is out of scope, whether or not it exists", async () => {
    const { load, issue, secrets, audit } = await start();
    const token = await issue({
      secrets: { kinds: ["android-keystore"] },
      actions: ["read"],
    });

    for (const outside of ["asc-api-key", "no-such-secret"]) {
      const response = await resolve(load, token, {
        names: ["release-keystore", outside],
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        error: {
          code: "forbidden",
          message: `The vault token's scope does not allow reading ${outside}.`,
        },
      });
      expect(JSON.stringify(body)).not.toContain(KEYSTORE.storePassword);
    }
    await expect(audit()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "read",
          outcome: "denied",
          secret_id: secrets.asc.id,
          context: { name: "asc-api-key" },
        }),
        expect.objectContaining({
          action: "read",
          outcome: "denied",
          secret_id: null,
          context: { name: "no-such-secret" },
        }),
      ]),
    );
  });

  it("refuses a token whose scope allows only sign", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { names: ["release-keystore"] },
      actions: ["sign"],
    });

    const response = await resolve(load, token, {
      names: ["release-keystore"],
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "The vault token's scope does not allow read.",
      },
    });
  });

  it("never resolves a bundle-signing-key, even in scope", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { kinds: ["bundle-signing-key", "android-keystore"] },
      actions: ["read", "sign"],
    });

    const response = await resolve(load, token, {
      names: ["release-keystore", "ota-signing"],
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "forbidden",
        message: expect.stringContaining("/_hot-updater/signing"),
      },
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(body)).not.toContain(KEYSTORE.storePassword);
  });

  it("refuses a body without 1-100 names", async () => {
    const { load, issue } = await start();
    const token = await issue(READ_KEYSTORE);

    for (const body of [
      "not json",
      {},
      { names: [] },
      { names: "release-keystore" },
      { names: [1] },
      { names: Array.from({ length: 101 }, (_, n) => `secret-${n}`) },
    ]) {
      const response = await resolve(load, token, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }
  });

  it("answers 503 when the console has no master key", async () => {
    const { load, issue, audit } = await start({ masterKey: null });
    const token = await issue(READ_KEYSTORE);

    const response = await resolve(load, token, {
      names: ["release-keystore"],
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "vault_locked",
        message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEY"),
      },
    });
    // Nothing was read, so nothing is logged as read.
    await expect(audit()).resolves.toEqual([]);
  });
});

describe("vault routes where the console serves no vault", () => {
  it("says what to change for a console over a self-hosted server", async () => {
    const fetchAdmin = vi.fn<RemoteDatabase["fetchAdmin"]>();
    const runtime = createConsoleRuntime({
      database: {
        name: "standalone-repository",
        core: {} as HotUpdaterCoreApi,
        fetchAdmin,
      },
      plugins: [apiKeys(), vault()],
    });
    const load: LoadConsole = async () => ({ runtime });
    const token = `hu_vault_${"A".repeat(43)}`;

    for (const response of [
      await list(load, bearer(token)),
      await resolve(load, token, { names: ["release-keystore"] }),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "vault_unavailable",
          message: expect.stringMatching(
            /standaloneRepository.*database adapter.*vault\(\)/u,
          ),
        },
      });
    }
    expect(fetchAdmin).not.toHaveBeenCalled();
  });

  it("says to add vault() when the console's config does not list it", async () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };
    const plugins = [apiKeys()];
    const runtime = createConsoleRuntime({
      database,
      plugins,
      api: createHotUpdater({
        database,
        storage: mockStorage({}),
        plugins,
      } as Parameters<typeof createHotUpdater>[0]).api,
    });
    const load: LoadConsole = async () => ({ runtime });

    const response = await list(load, bearer(`hu_vault_${"A".repeat(43)}`));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "vault_unavailable",
        message: expect.stringContaining("Add vault() to the plugins"),
      },
    });
  });
});
