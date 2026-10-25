// @vitest-environment node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";

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
  type VaultSecret,
  type VaultTokenScope,
} from "@hot-updater/server/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleRuntime } from "./runtime.server";
import {
  type LoadConsole,
  listVaultSecrets,
  putVaultSecret,
  resolveVaultSecrets,
  vaultMethodNotAllowed,
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
    /** A console whose vault runs `change` after each list, as a concurrent write would. */
    loadChanging: (change: () => Promise<void>): LoadConsole => {
      const api = runtime.apis.vault!;
      const changing: VaultApi = {
        ...api,
        list: async () => {
          const listed = await api.list();
          await change();
          return listed;
        },
      };
      return async () => ({
        runtime: { ...runtime, apis: { ...runtime.apis, vault: changing } },
      });
    },
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

const put = (
  load: LoadConsole,
  token: string | undefined,
  name: string,
  body: unknown,
) =>
  putVaultSecret(
    new Request(
      `https://console.example.com/_hot-updater/vault/v1/secrets/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    name,
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
      await put(load, undefined, "release-keystore", {}),
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
        await put(load, token, "release-keystore", {}),
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

  it("authorizes again a secret replaced after the list, never opening what it was not authorized for", async () => {
    const { loadChanging, vault: api, issue, secrets } = await start();
    const token = await issue({
      secrets: { kinds: ["android-keystore"] },
      actions: ["read"],
    });
    let replaced = false;
    const load = loadChanging(async () => {
      if (replaced) return;
      replaced = true;
      // Removed and stored again under its name and id, as a signing key.
      await api.remove({ id: secrets.keystore.id });
      await api.put({
        name: "release-keystore",
        kind: "bundle-signing-key",
        value: "-----BEGIN RSA PRIVATE KEY-----",
      });
    });

    const response = await resolve(load, token, {
      names: ["release-keystore"],
    });

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE KEY");
  });

  it("returns a value rotated after the list at its new version, and gives up on one that keeps changing", async () => {
    const { loadChanging, vault: api, issue } = await start();
    const token = await issue(READ_KEYSTORE);
    let rotations = 0;
    const rotate = async () => {
      rotations += 1;
      await api.put({
        name: "release-keystore",
        kind: "android-keystore",
        value: { storePassword: `rotated-${rotations}` },
      });
    };

    let once = false;
    const rotatedOnce = await resolve(
      loadChanging(async () => {
        if (once) return;
        once = true;
        await rotate();
      }),
      token,
      { names: ["release-keystore"] },
    );
    expect(rotatedOnce.status).toBe(200);
    await expect(rotatedOnce.json()).resolves.toMatchObject({
      secrets: [{ version: 2, value: { storePassword: "rotated-1" } }],
    });

    const alwaysRotating = await resolve(loadChanging(rotate), token, {
      names: ["release-keystore"],
    });
    expect(alwaysRotating.status).toBe(409);
    await expect(alwaysRotating.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
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
      { names: ["x".repeat(5_000)] },
      { names: ["release-keystore", "../etc"] },
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

const base64 = (text: string) => btoa(text);
const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49writeRouteSpecKey\n-----END PRIVATE KEY-----\n";
const ASC_VALUE = { p8: base64(P8), keyId: "KEY1", issuerId: "issuer-1" };
const SIGNING_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

describe("PUT /_hot-updater/vault/v1/secrets/:name", () => {
  it("stores a new secret sealed with the console's master key, answering only its metadata", async () => {
    const { load, issue, vault: api, audit } = await start();
    const token = await issue({
      secrets: { names: ["widget-asc"] },
      actions: ["write"],
    });

    const response = await put(load, token, "widget-asc", {
      kind: "asc-api-key",
      value: ASC_VALUE,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      secret: {
        id: expect.stringMatching(/^sec-/u),
        name: "widget-asc",
        kind: "asc-api-key",
        version: 1,
        metadata: { keyId: "KEY1", issuerId: "issuer-1" },
        createdAtMs: expect.any(Number),
        updatedAtMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(body)).not.toContain(ASC_VALUE.p8);
    // Sealed under the master key the console holds, and opened with it.
    await expect(
      api.reveal({ id: body.secret.id, actor: "spec" }),
    ).resolves.toEqual(ASC_VALUE);
    await expect(audit()).resolves.toEqual([
      expect.objectContaining({
        action: "write",
        outcome: "allowed",
        secret_id: body.secret.id,
        context: { name: "widget-asc" },
      }),
    ]);
  });

  it("stores the next version of a secret the scope reaches by kind", async () => {
    const { load, issue, vault: api, secrets } = await start();
    const token = await issue({
      secrets: { kinds: ["android-keystore"] },
      actions: ["write"],
    });
    const value = {
      keystore: base64("keystore-bytes"),
      storePassword: " store pass ",
      keyAlias: "upload",
      keyPassword: "key-pass",
    };

    const response = await put(load, token, "release-keystore", {
      kind: "android-keystore",
      value,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      secret: {
        id: secrets.keystore.id,
        version: 2,
        metadata: { keyAlias: "upload" },
      },
    });
    await expect(
      api.reveal({ id: secrets.keystore.id, actor: "spec" }),
    ).resolves.toEqual(value);
  });

  it("stores only at the version a write expects: 0 never replaces a secret", async () => {
    const { load, issue, vault: api, secrets } = await start();
    const token = await issue({
      secrets: { kinds: ["bundle-signing-key"] },
      actions: ["write"],
    });
    const value = { privateKey: base64(SIGNING_PEM) };

    const replacing = await put(load, token, "ota-signing", {
      kind: "bundle-signing-key",
      value,
      expectedVersion: 0,
    });
    expect(replacing.status).toBe(409);
    await expect(replacing.json()).resolves.toEqual({
      error: {
        code: "conflict",
        message:
          'The secret "ota-signing" is at version 1, and the write expected no secret under its name.',
      },
    });
    await expect(
      api.reveal({ id: secrets.signing.id, actor: "spec" }),
    ).resolves.toBe("-----BEGIN RSA PRIVATE KEY-----");

    const created = await put(load, token, "widget-signing", {
      kind: "bundle-signing-key",
      value,
      expectedVersion: 0,
    });
    expect(created.status).toBe(201);

    const malformed = await put(load, token, "widget-signing", {
      kind: "bundle-signing-key",
      value,
      expectedVersion: -1,
    });
    expect(malformed.status).toBe(400);
  });

  // The CLI asks this before an Apple Account sign-in, so a token that
  // cannot store the key it issues fails before anything is issued.
  it("answers a write of an empty asc-api-key by the token's scope alone, storing nothing", async () => {
    const { load, issue, vault: api } = await start();
    const writer = await issue({
      secrets: { names: ["widget-asc"] },
      actions: ["read", "write"],
    });
    const reader = await issue({
      secrets: { names: ["widget-asc"] },
      actions: ["read"],
    });
    const probe = { kind: "asc-api-key", value: {}, expectedVersion: 0 };

    const allowed = await put(load, writer, "widget-asc", probe);
    expect(allowed.status).toBe(400);
    await expect(allowed.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    const refused = await put(load, reader, "widget-asc", probe);
    expect(refused.status).toBe(403);
    expect(
      (await api.list()).some((secret) => secret.name === "widget-asc"),
    ).toBe(false);

    // A token scoped by kind may store a key that does not exist yet.
    const byKind = await issue({
      secrets: { kinds: ["asc-api-key"] },
      actions: ["read", "write"],
    });
    expect((await put(load, byKind, "widget-asc", probe)).status).toBe(400);
    expect(
      (await api.list()).some((secret) => secret.name === "widget-asc"),
    ).toBe(false);
  });

  it("never reads a value back with write: a write-only token lists metadata and resolves nothing", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { names: ["release-keystore"] },
      actions: ["write"],
    });

    const resolved = await resolve(load, token, {
      names: ["release-keystore"],
    });
    expect(resolved.status).toBe(403);
    expect(JSON.stringify(await resolved.json())).not.toContain(
      KEYSTORE.storePassword,
    );

    const listed = await list(load, bearer(token));
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body).toEqual({
      secrets: [expect.objectContaining({ name: "release-keystore" })],
    });
    expect(body.secrets[0]).not.toHaveProperty("value");
  });

  it("writes a bundle-signing-key, which is still never resolved", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { kinds: ["bundle-signing-key"] },
      actions: ["read", "write"],
    });

    const response = await put(load, token, "ota-key", {
      kind: "bundle-signing-key",
      value: { privateKey: base64(SIGNING_PEM) },
    });
    expect(response.status).toBe(201);
    // Its public key's SHA-256, as node:crypto computes it from the PEM.
    const spki = createPublicKey(SIGNING_PEM).export({
      format: "der",
      type: "spki",
    });
    expect(((await response.json()) as { secret: VaultSecret }).secret).toEqual(
      expect.objectContaining({
        metadata: {
          bits: 2048,
          publicKeySha256: createHash("sha256").update(spki).digest("hex"),
        },
      }),
    );

    // A PKCS#1 key, as openssl genrsa writes, is the same key.
    const pkcs1 = createPrivateKey(SIGNING_PEM)
      .export({ format: "pem", type: "pkcs1" })
      .toString();
    const again = await put(load, token, "ota-key-pkcs1", {
      kind: "bundle-signing-key",
      value: { privateKey: base64(pkcs1) },
    });
    expect(
      ((await again.json()) as { secret: VaultSecret }).secret.metadata,
    ).toEqual({
      bits: 2048,
      publicKeySha256: createHash("sha256").update(spki).digest("hex"),
    });

    const resolved = await resolve(load, token, { names: ["ota-key"] });
    expect(resolved.status).toBe(403);
    expect(JSON.stringify(await resolved.json())).not.toContain("PRIVATE KEY");
  });

  it("refuses with 403 a name or kind out of scope, or replacing a secret out of scope, whether or not it exists", async () => {
    const { load, issue, vault: api, secrets, audit } = await start();
    const token = await issue({
      secrets: { kinds: ["generic"] },
      actions: ["write"],
    });

    for (const [name, kind, value] of [
      // A generic under the name of an asc-api-key the scope does not reach.
      ["asc-api-key", "generic", { A: "1" }],
      ["new-asc", "asc-api-key", ASC_VALUE],
    ] as const) {
      const response = await put(load, token, name, { kind, value });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "forbidden",
          message: `The vault token's scope does not allow writing ${name} as ${kind}.`,
        },
      });
    }
    // The asc-api-key is as it was.
    await expect(
      api.reveal({ id: secrets.asc.id, actor: "spec" }),
    ).resolves.toEqual(ASC_KEY);
    await expect(audit()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "write",
          outcome: "denied",
          secret_id: secrets.asc.id,
          context: { name: "asc-api-key" },
        }),
        expect.objectContaining({
          action: "write",
          outcome: "denied",
          secret_id: null,
          context: { name: "new-asc" },
        }),
      ]),
    );

    const readOnly = await issue(READ_KEYSTORE);
    const refused = await put(load, readOnly, "release-keystore", {
      kind: "android-keystore",
      value: {},
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "The vault token's scope does not allow write.",
      },
    });
  });

  it("answers 409 for a secret of another kind under the name", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { names: ["release-keystore"] },
      actions: ["write"],
    });

    const response = await put(load, token, "release-keystore", {
      kind: "generic",
      value: { A: "1" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "conflict",
        message: expect.stringContaining(
          "is an android-keystore; remove it in the console before storing a generic",
        ),
      },
    });
  });

  it("answers 409 when the secret changes between the list and the write", async () => {
    const { loadChanging, vault: api, issue } = await start();
    const token = await issue({
      secrets: { names: ["release-keystore"] },
      actions: ["write"],
    });
    const load = loadChanging(async () => {
      await api.put({
        name: "release-keystore",
        kind: "android-keystore",
        value: { storePassword: "rotated" },
      });
    });

    const response = await put(load, token, "release-keystore", {
      kind: "android-keystore",
      value: {
        keystore: base64("keystore-bytes"),
        storePassword: "a",
        keyAlias: "b",
        keyPassword: "c",
      },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("answers 409 when the secret moved on from the expectedVersion the writer read", async () => {
    const { load, vault: api, issue } = await start();
    const token = await issue({
      secrets: { names: ["deploy"] },
      actions: ["write"],
    });
    await api.put({ name: "deploy", kind: "generic", value: { A: "1" } });

    const stale = await put(load, token, "deploy", {
      kind: "generic",
      value: { B: "2" },
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: {
        code: "conflict",
        message: expect.stringContaining(
          "is at version 1, and the write expected no secret under its name",
        ),
      },
    });

    const current = await put(load, token, "deploy", {
      kind: "generic",
      value: { B: "2" },
      expectedVersion: 1,
    });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      secret: { name: "deploy", version: 2 },
    });

    const invalid = await put(load, token, "deploy", {
      kind: "generic",
      value: { B: "2" },
      expectedVersion: -1,
    });
    expect(invalid.status).toBe(400);
  });

  it("refuses a bad name, body, or value with 400", async () => {
    const { load, issue } = await start();
    const token = await issue({
      secrets: { kinds: ["asc-api-key"] },
      actions: ["write"],
    });

    for (const [name, body, message] of [
      ["../etc", { kind: "asc-api-key", value: ASC_VALUE }, "secret name"],
      ["asc", "not json", "kind"],
      ["asc", { kind: "ssh-key", value: {} }, "kind"],
      [
        "asc",
        { kind: "asc-api-key", value: { ...ASC_VALUE, issuerId: "" } },
        "needs issuerId",
      ],
    ] as const) {
      const response = await put(load, token, name, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "invalid_request",
          message: expect.stringContaining(message),
        },
      });
    }
  });

  it("answers 503 when the console has no master key, writing nothing", async () => {
    const { load, issue, vault: api } = await start({ masterKey: null });
    const token = await issue({
      secrets: { names: ["widget-asc"] },
      actions: ["write"],
    });

    const response = await put(load, token, "widget-asc", {
      kind: "asc-api-key",
      value: ASC_VALUE,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "vault_locked",
        message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEY"),
      },
    });
    expect((await api.list()).map((secret) => secret.name)).not.toContain(
      "widget-asc",
    );
  });

  it("tells the vault's errors by name, from a copy of the plugin other than the console's", async () => {
    const { load, issue, secrets } = await start();
    const { runtime } = await load(new Request("https://console.example.com"));
    const api = runtime.apis.vault!;
    // The errors of a vault loaded from the project's own node_modules.
    const foreign = (name: string, message: string) =>
      Object.assign(new Error(message), { name });
    const copied: LoadConsole = async () => ({
      runtime: {
        ...runtime,
        apis: {
          ...runtime.apis,
          vault: {
            ...api,
            reveal: async () => {
              throw foreign("VaultLockedError", "The vault is locked: no key.");
            },
            put: async () => {
              throw foreign("VaultConflictError", "Version 2 now.");
            },
          },
        },
      },
    });
    const token = await issue({
      secrets: { names: [secrets.keystore.name, "widget-asc"] },
      actions: ["read", "write"],
    });

    const resolved = await resolve(copied, token, {
      names: [secrets.keystore.name],
    });
    expect(resolved.status).toBe(503);
    await expect(resolved.json()).resolves.toMatchObject({
      error: { code: "vault_locked" },
    });
    const written = await put(copied, token, "widget-asc", {
      kind: "asc-api-key",
      value: ASC_VALUE,
    });
    expect(written.status).toBe(409);
  });

  it("answers 503 when the console's master key did not seal the stored secrets", async () => {
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const { load, issue } = await start({ masterKey: other });
    const token = await issue({
      secrets: { names: ["widget-asc"] },
      actions: ["write"],
    });

    const response = await put(load, token, "widget-asc", {
      kind: "asc-api-key",
      value: ASC_VALUE,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "vault_locked" },
    });
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
      await put(load, token, "release-keystore", {}),
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

describe("vault routes for another method", () => {
  it.each(["POST", "PUT"] as const)(
    "answers 405 with the method the route takes, %s",
    async (allow) => {
      const response = vaultMethodNotAllowed(allow);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "method_not_allowed",
          message: `This route takes ${allow}.`,
        },
      });
    },
  );
});
