import {
  createEngine,
  createMemoryAdapter,
  generateEngineSql,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VAULT_KEPT_VERSIONS,
  VAULT_MAX_VALUE_BYTES,
  VaultConflictError,
  VaultInputError,
  VaultNotFoundError,
} from "./api";
import { createVaultApi } from "./api";
import { VaultIntegrityError, VaultLockedError } from "./crypto";
import { vault, type VaultOptions } from "./index";

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const ASC_KEY = {
  p8: "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n",
  keyId: "ABC123",
  issuerId: "00000000-0000-0000-0000-000000000000",
};

/** The vault's API and its tables on one in-memory database. */
const start = (options: VaultOptions = { masterKey: MASTER_KEY }) => {
  const adapter = createMemoryAdapter();
  let clock = 1_000;
  const plugin = vault();
  const db = createEngine(
    { name: "memory", adapter },
    { plugins: [plugin] },
  ).database(plugin);
  const now = () => clock++;
  return {
    api: createVaultApi({ db, now, options }),
    db,
    /** The same tables seen by a vault with other options. */
    with: (other: VaultOptions) => createVaultApi({ db, now, options: other }),
  };
};

describe("vault", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a put's audit entry in the write's transaction, and none for a refused put", async () => {
    const { api, db } = start();
    const auditRows = async () =>
      (await db.findMany("audit", { index: "byTime", where: {}, limit: 10 }))
        .rows;

    const secret = await api.put({
      name: "n",
      kind: "generic",
      value: { A: "1" },
      expectedVersion: 0,
      audit: { actor: "tok-ci", context: { name: "n" } },
    });
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        actor: "tok-ci",
        action: "write",
        secret_id: secret.id,
        outcome: "allowed",
        context: { name: "n" },
      }),
    ]);

    await expect(
      api.put({
        name: "n",
        kind: "generic",
        value: { A: "2" },
        expectedVersion: 0,
        audit: { actor: "tok-ci" },
      }),
    ).rejects.toBeInstanceOf(VaultConflictError);
    await expect(
      api.put({
        name: "n",
        kind: "generic",
        value: { A: "2" },
        audit: { actor: "" },
      }),
    ).rejects.toBeInstanceOf(VaultInputError);
    expect(await auditRows()).toHaveLength(1);
  });

  it("seals a value and reveals it, storing only ciphertext", async () => {
    const { api, db } = start();

    const secret = await api.put({
      name: "asc-api-key",
      kind: "asc-api-key",
      value: ASC_KEY,
      metadata: { keyId: ASC_KEY.keyId },
    });

    expect(secret).toMatchObject({
      name: "asc-api-key",
      kind: "asc-api-key",
      version: 1,
      metadata: { keyId: "ABC123" },
    });
    await expect(api.reveal({ id: secret.id, actor: "test" })).resolves.toEqual(
      ASC_KEY,
    );
    const sealed = await db.findOne("secret_versions", {
      secret_id: secret.id,
      version: 1,
    });
    expect(sealed).toMatchObject({ kid: "default" });
    expect(JSON.stringify(sealed)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(sealed)).not.toContain(ASC_KEY.issuerId);
  });

  it("opens only the version a caller authorized, refusing one rotated or replaced since", async () => {
    const { api } = start();
    const first = await api.put({ name: "key", kind: "generic", value: "v1" });
    await expect(
      api.reveal({ id: first.id, actor: "test", version: 1 }),
    ).resolves.toBe("v1");

    await api.put({ name: "key", kind: "generic", value: "v2" });
    await expect(
      api.reveal({ id: first.id, actor: "test", version: 1 }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);

    // Removed and stored again under its id, as another kind: a new version.
    await api.remove({ id: first.id });
    const replaced = await api.put({
      name: "key",
      kind: "bundle-signing-key",
      value: "pem",
    });
    expect(replaced).toMatchObject({ id: first.id, version: 3 });
    await expect(
      api.reveal({ id: first.id, actor: "test", version: 2 }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  it("refuses a version whose ciphertext was swapped in from another row", async () => {
    const { api, db } = start();
    const first = await api.put({
      name: "release-keystore",
      kind: "android-keystore",
      value: { storePassword: "first" },
    });
    const second = await api.put({
      name: "widget-keystore",
      kind: "android-keystore",
      value: { storePassword: "second" },
    });
    const sealed = (secretId: string, version: number) =>
      db.findOne("secret_versions", { secret_id: secretId, version });
    const { kid, wrapped_dek, iv, ciphertext } = (await sealed(second.id, 1))!;

    // Another secret's sealed value: the AAD names the other secret's id.
    await db.transaction(async (tx) => {
      const row = await tx.findOne("secret_versions", {
        secret_id: first.id,
        version: 1,
      });
      tx.update("secret_versions", row!, { kid, wrapped_dek, iv, ciphertext });
    });
    await expect(api.reveal({ id: first.id, actor: "test" })).rejects.toThrow(
      VaultIntegrityError,
    );

    // The same secret's older version: the AAD names the other version.
    await api.put({
      name: "widget-keystore",
      kind: "android-keystore",
      value: { storePassword: "third" },
    });
    await db.transaction(async (tx) => {
      const row = await tx.findOne("secret_versions", {
        secret_id: second.id,
        version: 2,
      });
      tx.update("secret_versions", row!, { kid, wrapped_dek, iv, ciphertext });
    });
    await expect(api.reveal({ id: second.id, actor: "test" })).rejects.toThrow(
      VaultIntegrityError,
    );
  });

  it("lists and removes without a master key, and refuses to seal or reveal", async () => {
    const { api, with: withOptions } = start();
    const secret = await api.put({
      name: "deploy",
      kind: "deploy-credentials",
      value: { HOT_UPDATER_S3_SECRET: "secret" },
    });
    const locked = withOptions({});

    await expect(locked.list()).resolves.toEqual([secret]);
    await expect(
      locked.reveal({ id: secret.id, actor: "test" }),
    ).rejects.toThrow(VaultLockedError);
    await expect(
      locked.put({ name: "other", kind: "generic", value: {} }),
    ).rejects.toThrow(VaultLockedError);
    await expect(
      locked.reveal({ id: secret.id, actor: "test" }),
    ).rejects.toThrow("HOT_UPDATER_VAULT_MASTER_KEY");
    await expect(locked.remove({ id: secret.id })).resolves.toMatchObject({
      id: secret.id,
    });
    await expect(locked.list()).resolves.toEqual([]);
  });

  it("writes only at the version a caller expects", async () => {
    const { api } = start();
    const add = (value: string) =>
      api.put({ name: "n", kind: "generic", value, expectedVersion: 0 });

    // Two adds under one name: one stores, the other refuses instead of
    // becoming its next version.
    const added = await Promise.allSettled([add("a"), add("b")]);
    expect(added.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(added.find(({ status }) => status === "rejected")).toMatchObject({
      reason: expect.any(VaultConflictError),
    });
    const [secret] = await api.list();
    expect(secret?.version).toBe(1);

    await expect(
      api.put({ name: "n", kind: "generic", value: "c", expectedVersion: 2 }),
    ).rejects.toThrow('The secret "n" is at version 1 now, not 2.');
    await expect(
      api.put({ name: "n", kind: "generic", value: "c", expectedVersion: 1 }),
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      api.remove({ id: secret!.id, expectedVersion: 1 }),
    ).rejects.toThrow('The secret "n" is at version 2 now, not 1.');
    await api.remove({ id: secret!.id, expectedVersion: 2 });
    await expect(
      api.put({ name: "n", kind: "generic", value: "d", expectedVersion: 2 }),
    ).rejects.toThrow('No secret is named "n" anymore.');
    await expect(api.list()).resolves.toEqual([]);
    await expect(
      api.put({ name: "n", kind: "generic", value: "d", expectedVersion: -1 }),
    ).rejects.toThrow(VaultInputError);
  });

  it("tells whether it is locked, and which keys the vault knows", async () => {
    const { api, with: withOptions, db } = start();
    const findOne = vi.spyOn(db, "findOne");
    const findMany = vi.spyOn(db, "findMany");

    await expect(withOptions({}).status()).resolves.toEqual({
      locked: true,
      message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEY"),
      knownKeys: [],
    });
    await expect(
      withOptions({ masterKey: btoa("short") }).status(),
    ).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining("32 bytes in base64"),
    });
    // Without a keys row, it also looks for a version under `default` and
    // for a live secret.
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledTimes(4);
    // An empty vault takes any well-formed key.
    await expect(api.status()).resolves.toEqual({ locked: false });
    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEY", MASTER_KEY);
    await expect(withOptions({}).status()).resolves.toEqual({ locked: false });

    // Once it sealed a value, only its key opens it.
    await api.put({ name: "a", kind: "generic", value: 1 });
    vi.unstubAllEnvs();
    await expect(withOptions({}).status()).resolves.toEqual({
      locked: true,
      message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEY"),
      knownKeys: ["default"],
    });
  });

  it("is locked under a well-formed key that did not seal the secrets, reading one row", async () => {
    const { api, with: withOptions, db } = start();
    await api.put({ name: "a", kind: "generic", value: 1 });
    const findOne = vi.spyOn(db, "findOne");
    const findMany = vi.spyOn(db, "findMany");

    await expect(api.status()).resolves.toEqual({ locked: false });
    await expect(
      withOptions({ masterKey: OTHER_KEY }).status(),
    ).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining(
        'the master key "default" in HOT_UPDATER_VAULT_MASTER_KEY or HOT_UPDATER_VAULT_MASTER_KEYS is not the key',
      ),
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it("stays locked to its first key once every secret is removed", async () => {
    const { api, with: withOptions } = start();
    const first = await api.put({ name: "a", kind: "generic", value: 1 });
    await api.remove({ id: first.id });
    await expect(api.list()).resolves.toEqual([]);

    const other = withOptions({ masterKey: OTHER_KEY });
    await expect(other.status()).resolves.toMatchObject({ locked: true });
    await expect(
      other.put({ name: "b", kind: "generic", value: 2 }),
    ).rejects.toThrow(VaultLockedError);
    await expect(
      api.put({ name: "b", kind: "generic", value: 2 }),
    ).resolves.toMatchObject({ version: 1 });
  });

  it("lets one of two Consoles with different keys seal into an empty vault, and locks the other", async () => {
    const { api, with: withOptions } = start();
    const other = withOptions({ masterKey: OTHER_KEY });

    const results = await Promise.allSettled([
      api.put({ name: "a", kind: "generic", value: "a" }),
      other.put({ name: "b", kind: "generic", value: "b" }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: expect.any(VaultLockedError),
    });
    const winner = results[0].status === "fulfilled" ? api : other;
    const loser = winner === api ? other : api;
    const [secret] = await winner.list();
    await expect(
      winner.reveal({ id: secret!.id, actor: "test" }),
    ).resolves.toBeTypeOf("string");
    await expect(loser.status()).resolves.toMatchObject({ locked: true });
  });

  it("keeps its master key checks out of the secrets it lists, reveals, and removes", async () => {
    const { api } = start();
    await api.put({ name: "a", kind: "generic", value: 1 });

    expect((await api.list()).map(({ name }) => name)).toEqual(["a"]);
    await expect(
      api.reveal({ id: ".master-keys", actor: "test" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
    await expect(api.remove({ id: ".master-keys" })).resolves.toBeNull();
    await expect(
      api.put({ name: ".master-keys", kind: "generic", value: 1 }),
    ).rejects.toBeInstanceOf(VaultInputError);
    await expect(api.status()).resolves.toEqual({ locked: false });
  });

  it("reads the master key from HOT_UPDATER_VAULT_MASTER_KEY when it is not given", async () => {
    const { with: withOptions } = start();
    const fromEnv = withOptions({});
    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEY", MASTER_KEY);

    const secret = await fromEnv.put({
      name: "generic",
      kind: "generic",
      value: "value",
    });
    await expect(
      withOptions({ masterKey: MASTER_KEY }).reveal({
        id: secret.id,
        actor: "test",
      }),
    ).resolves.toBe("value");
  });

  it("refuses a master key that is not 32 bytes, or not the one that sealed the value", async () => {
    const { api, with: withOptions } = start();
    const secret = await api.put({ name: "a", kind: "generic", value: 1 });

    await expect(
      withOptions({ masterKey: btoa("short") }).reveal({
        id: secret.id,
        actor: "test",
      }),
    ).rejects.toThrow(VaultLockedError);
    await expect(
      withOptions({ masterKey: OTHER_KEY }).reveal({
        id: secret.id,
        actor: "test",
      }),
    ).rejects.toThrow(VaultIntegrityError);
  });

  it("writes each value as a new version and keeps the last ones", async () => {
    const { api, db } = start();
    let secret = await api.put({ name: "n", kind: "generic", value: 1 });
    const id = secret.id;
    for (let value = 2; value <= VAULT_KEPT_VERSIONS + 2; value++) {
      secret = await api.put({ name: "n", kind: "generic", value });
    }

    expect(secret).toMatchObject({ id, version: VAULT_KEPT_VERSIONS + 2 });
    await expect(api.reveal({ id, actor: "test" })).resolves.toBe(
      VAULT_KEPT_VERSIONS + 2,
    );
    const versions = await Promise.all(
      Array.from({ length: VAULT_KEPT_VERSIONS + 2 }, (_, index) =>
        db.findOne("secret_versions", { secret_id: id, version: index + 1 }),
      ),
    );
    expect(versions.map((row) => row !== null)).toEqual([
      false,
      false,
      ...Array<boolean>(VAULT_KEPT_VERSIONS).fill(true),
    ]);
  });

  it("makes concurrent puts of one name consecutive versions", async () => {
    const { api } = start();
    await api.put({ name: "n", kind: "generic", value: 0 });

    const versions = await Promise.all(
      [1, 2, 3].map((value) =>
        api.put({ name: "n", kind: "generic", value }).then((s) => s.version),
      ),
    );

    expect(versions.toSorted()).toEqual([2, 3, 4]);
    const [secret] = await api.list();
    expect(secret).toMatchObject({ version: 4 });
  });

  it("keeps metadata unless a put replaces it", async () => {
    const { api } = start();
    await api.put({
      name: "n",
      kind: "generic",
      value: 1,
      metadata: { label: "a" },
    });
    await expect(
      api.put({ name: "n", kind: "generic", value: 2 }),
    ).resolves.toMatchObject({ metadata: { label: "a" } });
    await expect(
      api.put({ name: "n", kind: "generic", value: 3, metadata: {} }),
    ).resolves.toMatchObject({ metadata: {} });
  });

  it("removes values with the secret, and continues its versions when the name comes back", async () => {
    const { api, db } = start();
    const first = await api.put({ name: "n", kind: "generic", value: 1 });
    await api.put({ name: "n", kind: "generic", value: 2 });

    await expect(api.remove({ id: first.id })).resolves.toMatchObject({
      id: first.id,
      version: 2,
    });
    await expect(api.remove({ id: first.id })).resolves.toBeNull();
    await expect(api.remove({ id: "missing" })).resolves.toBeNull();
    for (const version of [1, 2]) {
      await expect(
        db.findOne("secret_versions", { secret_id: first.id, version }),
      ).resolves.toBeNull();
    }
    await expect(api.reveal({ id: first.id, actor: "test" })).rejects.toThrow(
      VaultNotFoundError,
    );
    await expect(api.list()).resolves.toEqual([]);

    // Back under another kind: a new version, so no id and version pair is sealed twice.
    const again = await api.put({
      name: "n",
      kind: "deploy-credentials",
      value: { KEY: "3" },
    });
    expect(again).toMatchObject({
      id: first.id,
      kind: "deploy-credentials",
      version: 3,
      metadata: {},
    });
    await expect(api.reveal({ id: first.id, actor: "test" })).resolves.toEqual({
      KEY: "3",
    });
  });

  it("lists secrets by name", async () => {
    const { api } = start();
    for (const name of ["b", "a", "c"]) {
      await api.put({ name, kind: "generic", value: name });
    }

    expect((await api.list()).map(({ name }) => name)).toEqual(["a", "b", "c"]);
  });

  it("refuses invalid names, kinds, values, and metadata", async () => {
    const { api } = start();
    await api.put({ name: "keystore", kind: "android-keystore", value: {} });
    const invalid = [
      { name: "", kind: "generic", value: 1 },
      { name: "has space", kind: "generic", value: 1 },
      { name: "x".repeat(65), kind: "generic", value: 1 },
      { name: "n", kind: "password", value: 1 },
      { name: "n", kind: "generic", value: undefined },
      { name: "n", kind: "generic", value: "x".repeat(VAULT_MAX_VALUE_BYTES) },
      { name: "n", kind: "generic", value: 1, metadata: [] },
      { name: "keystore", kind: "generic", value: {} },
    ];

    for (const input of invalid) {
      await expect(
        api.put(input as Parameters<typeof api.put>[0]),
      ).rejects.toThrow(VaultInputError);
    }
    await expect(api.list()).resolves.toHaveLength(1);
  });

  it("declares columns every SQL database can create, MySQL's varchar limit included", () => {
    const { schema, settings } = toolingTargetOf([vault()]);
    const lengths = generateEngineSql("mysql", schema, settings).flatMap(
      (sql) =>
        [...sql.matchAll(/varchar\((\d+)\)/gu)].map(([, n]) => Number(n)),
    );

    // utf8mb4 varchar holds up to 16,383 characters.
    expect(Math.max(...lengths)).toBeLessThanOrEqual(16_383);
  });
});
