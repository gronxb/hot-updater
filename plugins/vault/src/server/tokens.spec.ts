import {
  createEngine,
  createMemoryAdapter,
  type DatabaseJson,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  authorizeVaultToken,
  createVaultApi,
  VAULT_SECRET_KINDS,
  VaultInputError,
  type VaultTokenScope,
} from "./api";
import { vault } from "./index";
import { hashVaultToken } from "./token";

const SIGN_ONLY: VaultTokenScope = {
  secrets: { kinds: ["bundle-signing-key"] },
  actions: ["sign"],
};

const RELEASE_KEYSTORE = {
  name: "release-keystore",
  kind: "android-keystore",
} as const;

/**
 * A vault without a master key on one in-memory database, as the CLI opens
 * it, with a clock the test moves and a count of the database's reads.
 */
const start = () => {
  const plugin = vault();
  const db = createEngine(
    { name: "memory", adapter: createMemoryAdapter() },
    { plugins: [plugin] },
  ).database(plugin);
  const clock = { now: 1_000 };
  let reads = 0;
  const counted: typeof db = {
    findOne: (...args) => {
      reads += 1;
      return db.findOne(...args);
    },
    findByKeys: (...args) => db.findByKeys(...args),
    findMany: (...args) => db.findMany(...args),
    findAggregates: (...args) => db.findAggregates(...args),
    transaction: (fn) => db.transaction(fn),
  };
  return {
    api: createVaultApi({ db: counted, now: () => clock.now, options: {} }),
    db,
    clock,
    reads: () => reads,
  };
};

describe("vault tokens", () => {
  it("issues a token that verifies, on a vault without a master key", async () => {
    const { api } = start();
    const { token, metadata } = await api.issueToken({
      name: "  ci-ios  ",
      scope: {
        secrets: { names: ["asc-api-key", "asc-api-key"] },
        actions: ["read", "sign", "write", "read"],
      },
      expiresAtMs: 10_000,
    });

    expect(token).toMatch(/^hu_vault_[A-Za-z0-9_-]{43}$/u);
    expect(metadata).toEqual({
      id: expect.stringMatching(/^tok-/u),
      name: "ci-ios",
      prefix: token.slice(0, 13),
      scope: {
        secrets: { names: ["asc-api-key"], kinds: [] },
        actions: ["read", "sign", "write"],
      },
      expiresAtMs: 10_000,
      createdAtMs: 1_000,
      revokedAtMs: null,
    });
    await expect(api.verifyToken({ token })).resolves.toEqual({
      ok: true,
      token: metadata,
    });
  });

  it("stores only the token's digest, and never lists it", async () => {
    const { api, db } = start();
    const { token, metadata } = await api.issueToken({
      name: "ci",
      scope: SIGN_ONLY,
    });

    const row = await db.findOne("tokens", { id: metadata.id });
    expect(row).toMatchObject({ hash: await hashVaultToken(token) });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(13));

    const listed = await api.listTokens();
    expect(listed).toEqual([metadata]);
    expect(Object.keys(listed[0]!)).not.toContain("hash");
    expect(JSON.stringify(listed)).not.toContain(row!.hash);
  });

  it("refuses a revoked token from the next verification", async () => {
    const { api, clock } = start();
    const { token, metadata } = await api.issueToken({
      name: "ci",
      scope: SIGN_ONLY,
    });
    await expect(api.verifyToken({ token })).resolves.toMatchObject({
      ok: true,
    });

    clock.now = 2_000;
    await expect(api.revokeToken({ id: metadata.id })).resolves.toEqual({
      ...metadata,
      revokedAtMs: 2_000,
    });
    await expect(api.verifyToken({ token })).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });

    // Revoking again keeps the first time; an unknown id is null.
    clock.now = 3_000;
    await expect(api.revokeToken({ id: metadata.id })).resolves.toMatchObject({
      revokedAtMs: 2_000,
    });
    await expect(api.revokeToken({ id: "tok-missing" })).resolves.toBeNull();
    await expect(api.listTokens()).resolves.toEqual([
      { ...metadata, revokedAtMs: 2_000 },
    ]);
  });

  it("refuses a token at its expiry, and a revoked one as revoked", async () => {
    const { api, clock } = start();
    const { token } = await api.issueToken({
      name: "ci",
      scope: SIGN_ONLY,
      expiresAtMs: 5_000,
    });
    const { token: revoked, metadata } = await api.issueToken({
      name: "old",
      scope: SIGN_ONLY,
      expiresAtMs: 5_000,
    });
    await api.revokeToken({ id: metadata.id });

    clock.now = 4_999;
    await expect(api.verifyToken({ token })).resolves.toMatchObject({
      ok: true,
    });
    clock.now = 5_000;
    await expect(api.verifyToken({ token })).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
    await expect(api.verifyToken({ token: revoked })).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("verifies with one digest read, and reads nothing for a malformed token", async () => {
    const { api, reads } = start();
    const { token } = await api.issueToken({ name: "ci", scope: SIGN_ONLY });

    let before = reads();
    await api.verifyToken({ token });
    expect(reads() - before).toBe(1);

    before = reads();
    for (const malformed of [
      "",
      "hu_vault_short",
      `hu_vault_${"A".repeat(44)}`,
      token.replace("hu_vault_", "hu_vlt_"),
      `${token} `,
    ]) {
      await expect(api.verifyToken({ token: malformed })).resolves.toEqual({
        ok: false,
        reason: "unknown",
      });
    }
    await expect(
      api.verifyToken({ token: null as unknown as string }),
    ).resolves.toEqual({ ok: false, reason: "unknown" });
    expect(reads() - before).toBe(0);

    // Well-formed, but never issued.
    await expect(
      api.verifyToken({ token: `hu_vault_${"A".repeat(43)}` }),
    ).resolves.toEqual({ ok: false, reason: "unknown" });
  });

  it("lists tokens newest first", async () => {
    const { api, clock } = start();
    const first = await api.issueToken({ name: "first", scope: SIGN_ONLY });
    clock.now = 2_000;
    const second = await api.issueToken({ name: "second", scope: SIGN_ONLY });

    await expect(api.listTokens()).resolves.toEqual([
      second.metadata,
      first.metadata,
    ]);
  });

  it.each([
    ["no scope", undefined],
    ["a scope that is not an object", "read"],
    ["no secrets", { actions: ["read"] }],
    ["neither names nor kinds", { secrets: {}, actions: ["read"] }],
    [
      "empty names and kinds",
      { secrets: { names: [], kinds: [] }, actions: ["read"] },
    ],
    ["no actions", { secrets: { names: ["play"] } }],
    ["empty actions", { secrets: { names: ["play"] }, actions: [] }],
    [
      "the register action",
      { secrets: { names: ["play"] }, actions: ["read", "register"] },
    ],
    ["an unknown action", { secrets: { names: ["play"] }, actions: ["delete"] }],
    [
      "an apps scope",
      { secrets: { names: ["play"] }, actions: ["read"], apps: ["widget"] },
    ],
    [
      "an apps entry in secrets",
      { secrets: { names: ["play"], apps: ["widget"] }, actions: ["read"] },
    ],
    ["a wildcard name", { secrets: { names: ["*"] }, actions: ["read"] }],
    ["an unknown kind", { secrets: { kinds: ["ssh-key"] }, actions: ["read"] }],
    [
      "names that are not a list",
      { secrets: { names: "play" }, actions: ["read"] },
    ],
    [
      "too many names",
      {
        secrets: { names: Array.from({ length: 101 }, (_, n) => `s${n}`) },
        actions: ["read"],
      },
    ],
  ])("refuses %s", async (_, scope) => {
    const { api } = start();
    await expect(
      api.issueToken({ name: "ci", scope: scope as VaultTokenScope }),
    ).rejects.toThrow(VaultInputError);
    await expect(api.listTokens()).resolves.toEqual([]);
  });

  it("refuses a bad name or an expiry that is not after now", async () => {
    const { api } = start();
    for (const name of ["", "   ", "a".repeat(65), "ci\u0000"]) {
      await expect(api.issueToken({ name, scope: SIGN_ONLY })).rejects.toThrow(
        VaultInputError,
      );
    }
    for (const expiresAtMs of [999, 1_000, 1_500.5, Number.NaN]) {
      await expect(
        api.issueToken({ name: "ci", scope: SIGN_ONLY, expiresAtMs }),
      ).rejects.toThrow(VaultInputError);
    }
    await expect(api.listTokens()).resolves.toEqual([]);
  });
});

describe("authorizeVaultToken", () => {
  const issue = async (scope: VaultTokenScope) => {
    const { api } = start();
    const { token } = await api.issueToken({ name: "ci", scope });
    const verified = await api.verifyToken({ token });
    if (!verified.ok) throw new Error(verified.reason);
    return verified.token;
  };

  it("allows a secret its scope names, for its actions", async () => {
    const token = await issue({
      secrets: { names: ["release-keystore"] },
      actions: ["read"],
    });

    expect(
      authorizeVaultToken(token, { action: "read", secret: RELEASE_KEYSTORE }),
    ).toBe(true);
    // Another secret of the same kind is not in scope.
    expect(
      authorizeVaultToken(token, {
        action: "read",
        secret: { name: "widget-keystore", kind: "android-keystore" },
      }),
    ).toBe(false);
    // Nor is another action.
    expect(
      authorizeVaultToken(token, { action: "sign", secret: RELEASE_KEYSTORE }),
    ).toBe(false);
  });

  it("allows every secret of a kind its scope lists", async () => {
    const token = await issue(SIGN_ONLY);
    const signingKey = { name: "ota-key", kind: "bundle-signing-key" };

    expect(
      authorizeVaultToken(token, { action: "sign", secret: signingKey }),
    ).toBe(true);
    expect(
      authorizeVaultToken(token, { action: "read", secret: signingKey }),
    ).toBe(false);
    expect(
      authorizeVaultToken(token, { action: "sign", secret: RELEASE_KEYSTORE }),
    ).toBe(false);
  });

  it("allows write only on the secrets its scope reaches, and no read with it", async () => {
    const token = await issue({
      secrets: { names: ["release-keystore"], kinds: ["bundle-signing-key"] },
      actions: ["write"],
    });

    expect(
      authorizeVaultToken(token, { action: "write", secret: RELEASE_KEYSTORE }),
    ).toBe(true);
    // A signing key can be written, such as hot-updater keys generate uploads.
    expect(
      authorizeVaultToken(token, {
        action: "write",
        secret: { name: "ota-key", kind: "bundle-signing-key" },
      }),
    ).toBe(true);
    expect(
      authorizeVaultToken(token, {
        action: "write",
        secret: { name: "widget-keystore", kind: "android-keystore" },
      }),
    ).toBe(false);
    for (const action of ["read", "sign"] as const) {
      expect(
        authorizeVaultToken(token, { action, secret: RELEASE_KEYSTORE }),
      ).toBe(false);
    }
  });

  it("allows a secret named or of a listed kind", async () => {
    const token = await issue({
      secrets: { names: ["play"], kinds: ["asc-api-key"] },
      actions: ["read"],
    });
    for (const secret of [
      { name: "play", kind: "play-service-account" },
      { name: "asc", kind: "asc-api-key" },
    ]) {
      expect(authorizeVaultToken(token, { action: "read", secret })).toBe(true);
    }
    expect(
      authorizeVaultToken(token, { action: "read", secret: RELEASE_KEYSTORE }),
    ).toBe(false);
  });

  it("reaches every secret only when the scope lists every kind", async () => {
    const token = await issue({
      secrets: { kinds: [...VAULT_SECRET_KINDS] },
      actions: ["read"],
    });
    for (const kind of VAULT_SECRET_KINDS) {
      expect(
        authorizeVaultToken(token, {
          action: "read",
          secret: { name: `any-${kind}`, kind },
        }),
      ).toBe(true);
    }
  });

  it("allows nothing to a revoked token or a malformed stored scope", async () => {
    const token = await issue({
      secrets: { names: ["release-keystore"] },
      actions: ["read"],
    });
    const request = { action: "read", secret: RELEASE_KEYSTORE } as const;

    expect(authorizeVaultToken({ ...token, revokedAtMs: 1 }, request)).toBe(
      false,
    );

    // Any malformed part, even beside valid entries, empties the whole scope.
    const { api, db } = start();
    const malformed: readonly DatabaseJson[] = [
      { secrets: { names: "release-keystore" }, actions: "read" },
      { secrets: { names: ["release-keystore"] }, actions: ["read", 1] },
      { secrets: { names: ["release-keystore", null] }, actions: ["read"] },
      { secrets: { names: ["release-keystore"] }, actions: ["read", "delete"] },
      {
        secrets: { names: ["release-keystore"], kinds: ["ssh-key"] },
        actions: ["read"],
      },
      {
        secrets: { names: ["release-keystore"] },
        actions: ["read"],
        apps: ["widget"],
      },
    ];
    for (const scope of malformed) {
      const { token: plaintext, metadata } = await api.issueToken({
        name: "ci",
        scope: { secrets: { names: ["release-keystore"] }, actions: ["read"] },
      });
      await db.transaction(async (tx) => {
        const row = await tx.findOne("tokens", { id: metadata.id });
        tx.update("tokens", row!, { scope });
      });
      const verified = await api.verifyToken({ token: plaintext });
      expect(verified).toMatchObject({
        ok: true,
        token: { scope: { secrets: { names: [], kinds: [] }, actions: [] } },
      });
      expect(
        authorizeVaultToken(
          (verified as { readonly token: typeof token }).token,
          request,
        ),
      ).toBe(false);
    }
  });
});
