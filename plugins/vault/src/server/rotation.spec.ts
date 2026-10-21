import { createEngine, createMemoryAdapter } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVaultApi, VaultInputError } from "./api";
import { importKeyring, VaultLockedError } from "./crypto";
import { vault, type VaultOptions } from "./index";

const keyOf = (byte: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const KEY_A = keyOf(1);
const KEY_B = keyOf(2);
const KEY_C = keyOf(3);

/** The vault's tables on one in-memory database, opened by Consoles with different keys. */
const start = () => {
  const adapter = createMemoryAdapter();
  let clock = 1_000;
  const plugin = vault();
  const db = createEngine(
    { name: "memory", adapter },
    { plugins: [plugin] },
  ).database(plugin);
  const now = () => clock++;
  return {
    db,
    console: (options: VaultOptions) => createVaultApi({ db, now, options }),
  };
};

describe("vault master keys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads HOT_UPDATER_VAULT_MASTER_KEYS in order, then HOT_UPDATER_VAULT_MASTER_KEY as default", async () => {
    const keyring = await importKeyring({
      keys: ` next:${KEY_B} , older:${KEY_C}`,
      key: KEY_A,
    });
    expect(keyring?.active.kid).toBe("next");
    expect(keyring?.keys.map(({ kid }) => kid)).toEqual([
      "next",
      "older",
      "default",
    ]);
    // The same default in both is one key.
    await expect(
      importKeyring({ keys: `next:${KEY_B},default:${KEY_A}`, key: KEY_A }),
    ).resolves.toMatchObject({
      keys: [{ kid: "next" }, { kid: "default" }],
    });
    await expect(importKeyring({ keys: " ", key: "" })).resolves.toBeNull();
  });

  it("refuses malformed, duplicate, and conflicting master keys, naming the variable", async () => {
    const refusals: [string | undefined, string | undefined, string][] = [
      [KEY_A, undefined, "kid:key pairs"],
      [`:${KEY_A}`, undefined, "kid:key pairs"],
      [`a:${KEY_A},`, undefined, "kid:key pairs"],
      [`a,b:${KEY_B}`, undefined, "kid:key pairs"],
      [`${"k".repeat(33)}:${KEY_A}`, undefined, "kid:key pairs"],
      [`a:${KEY_A},a:${KEY_B}`, undefined, 'the master key "a" twice'],
      [`a:${btoa("short")}`, undefined, 'master key "a" must be 32 bytes'],
      [`default:${KEY_B}`, KEY_A, 'a master key "default" other than'],
      [undefined, btoa("short"), "HOT_UPDATER_VAULT_MASTER_KEY: the master"],
    ];
    for (const [keys, key, message] of refusals) {
      const refused = importKeyring({ keys, key });
      await expect(refused).rejects.toBeInstanceOf(VaultLockedError);
      await expect(refused).rejects.toThrow(message);
    }
    await expect(
      importKeyring({ keys: `a:${KEY_A},a:${KEY_B}`, key: undefined }),
    ).rejects.toThrow("HOT_UPDATER_VAULT_MASTER_KEYS lists");
  });

  it("takes one key in two encodings as the same default", async () => {
    const urlSafe = KEY_B.replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    await expect(
      importKeyring({ keys: `default:${urlSafe}`, key: KEY_B }),
    ).resolves.toMatchObject({ keys: [{ kid: "default" }] });
  });

  it("records a check for a kid named like an object property", async () => {
    const { console } = start();
    const own = console({ masterKeys: `constructor:${KEY_A}` });
    await own.put({ name: "s1", kind: "generic", value: "v1" });

    const other = console({ masterKeys: `constructor:${KEY_B}` });
    await expect(other.status()).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining('the master key "constructor"'),
    });
    await expect(
      other.put({ name: "s2", kind: "generic", value: "x" }),
    ).rejects.toThrow(VaultLockedError);
    await expect(own.keys()).resolves.toMatchObject({
      keys: [{ kid: "constructor", known: true, versions: 1 }],
    });
  });

  it("takes the options' keys over the environment's", async () => {
    const { console } = start();
    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEYS", "broken");
    await expect(console({}).status()).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining("HOT_UPDATER_VAULT_MASTER_KEYS lists"),
    });
    await expect(
      console({ masterKeys: `b:${KEY_B}` }).status(),
    ).resolves.toEqual({ locked: false });
    await expect(
      console({ masterKeys: "broken" }).status(),
    ).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining("vault({ masterKeys }) lists"),
    });
  });

  it("seals new values under the first key and opens values under every key", async () => {
    const { console, db } = start();
    const before = console({ masterKey: KEY_A });
    const old = await before.put({ name: "old", kind: "generic", value: "A" });

    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEYS", `next:${KEY_B}`);
    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEY", KEY_A);
    const rotating = console({});
    await expect(rotating.status()).resolves.toEqual({ locked: false });
    const fresh = await rotating.put({
      name: "new",
      kind: "generic",
      value: "B",
    });
    await expect(
      db.findOne("secret_versions", { secret_id: fresh.id, version: 1 }),
    ).resolves.toMatchObject({ kid: "next" });
    await expect(rotating.reveal({ id: old.id, actor: "t" })).resolves.toBe(
      "A",
    );
    await expect(rotating.reveal({ id: fresh.id, actor: "t" })).resolves.toBe(
      "B",
    );
    // A Console that holds only the old key still opens the old value.
    await expect(before.reveal({ id: old.id, actor: "t" })).resolves.toBe("A");
    await expect(before.reveal({ id: fresh.id, actor: "t" })).rejects.toThrow(
      'sealed under the master key "next", which the Console does not hold',
    );
    await expect(rotating.keys()).resolves.toEqual({
      keys: [
        { kid: "next", active: true, held: true, known: true, versions: 1 },
        { kid: "default", active: false, held: true, known: true, versions: 1 },
      ],
      remaining: 1,
    });
  });

  it("rewraps in batches to the active key, and opens everything once the old key is gone", async () => {
    const { console, db } = start();
    const before = console({ masterKey: KEY_A });
    const ids: string[] = [];
    for (let n = 1; n <= 4; n += 1) {
      const secret = await before.put({
        name: `s${n}`,
        kind: "generic",
        value: `v${n}`,
      });
      ids.push(secret.id);
    }
    // Two more versions of s1: seven versions in all.
    await before.put({ name: "s1", kind: "generic", value: "v1b" });
    await before.put({ name: "s1", kind: "generic", value: "v1c" });
    const sealedBefore = await db.findOne("secret_versions", {
      secret_id: ids[0]!,
      version: 3,
    });

    const rotating = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });
    await expect(rotating.keys()).resolves.toMatchObject({ remaining: 6 });
    await expect(rotating.rewrap({ batch: 4 })).resolves.toEqual({
      rewrapped: 4,
      remaining: 2,
    });
    await expect(rotating.rewrap({ batch: 4 })).resolves.toEqual({
      rewrapped: 2,
      remaining: 0,
    });
    // Idempotent: nothing is left to move.
    await expect(rotating.rewrap()).resolves.toEqual({
      rewrapped: 0,
      remaining: 0,
    });
    await expect(rotating.keys()).resolves.toEqual({
      keys: [
        { kid: "next", active: true, held: true, known: true, versions: 6 },
        // Forgotten by the vault: it can leave the environment.
        {
          kid: "default",
          active: false,
          held: true,
          known: false,
          versions: 0,
        },
      ],
      remaining: 0,
    });

    // Only the data key was wrapped again; the value's ciphertext is as it was.
    const sealedAfter = await db.findOne("secret_versions", {
      secret_id: ids[0]!,
      version: 3,
    });
    expect(sealedAfter).toMatchObject({
      kid: "next",
      iv: sealedBefore!.iv,
      ciphertext: sealedBefore!.ciphertext,
    });
    expect(sealedAfter!.wrapped_dek).not.toBe(sealedBefore!.wrapped_dek);

    // The old key is removed from the environment: everything still opens.
    const after = console({ masterKeys: `next:${KEY_B}` });
    await expect(after.status()).resolves.toEqual({ locked: false });
    const values = await Promise.all(
      ids.map((id) => after.reveal({ id, actor: "t" })),
    );
    expect(values).toEqual(["v1c", "v2", "v3", "v4"]);
    await expect(after.keys()).resolves.toEqual({
      keys: [
        { kid: "next", active: true, held: true, known: true, versions: 6 },
      ],
      remaining: 0,
    });

    // The vault forgot the old key: a Console that still holds only it is locked.
    await expect(before.status()).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining(
        'its secrets are saved under the master key "next", which the Console does not hold. List it in HOT_UPDATER_VAULT_MASTER_KEYS as "next:<key>"',
      ),
    });
    await expect(
      before.put({ name: "s5", kind: "generic", value: "v5" }),
    ).rejects.toThrow(VaultLockedError);
  });

  it("checks each key the vault knows, and refuses a wrong one under a known kid", async () => {
    const { console } = start();
    await console({ masterKey: KEY_A }).put({
      name: "a",
      kind: "generic",
      value: 1,
    });

    const wrongOld = console({ masterKeys: `next:${KEY_B},default:${KEY_C}` });
    await expect(wrongOld.status()).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining('the master key "default"'),
    });
    await expect(wrongOld.rewrap()).rejects.toThrow(VaultLockedError);
    await expect(
      wrongOld.put({ name: "b", kind: "generic", value: 2 }),
    ).rejects.toThrow(VaultLockedError);

    // A new key alone, without the old one to vouch for it, is refused too.
    const newOnly = console({ masterKeys: `next:${KEY_B}` });
    await expect(newOnly.status()).resolves.toMatchObject({
      locked: true,
      message: expect.stringContaining(
        'saved under the master key "default", which the Console does not hold. Set it in HOT_UPDATER_VAULT_MASTER_KEY,',
      ),
    });
  });

  it("leaves versions under a key the Console does not hold, and counts them", async () => {
    const { console } = start();
    const a = console({ masterKey: KEY_A });
    const old = await a.put({ name: "old", kind: "generic", value: "A" });
    const b = console({ masterKeys: `b:${KEY_B},default:${KEY_A}` });
    const middle = await b.put({ name: "middle", kind: "generic", value: "B" });

    // Rotating on to c without the first key: b's versions move, a's stay.
    const c = console({ masterKeys: `c:${KEY_C},b:${KEY_B}` });
    await expect(c.rewrap()).resolves.toEqual({ rewrapped: 1, remaining: 1 });
    await expect(c.keys()).resolves.toEqual({
      keys: [
        { kid: "c", active: true, held: true, known: true, versions: 1 },
        // Forgotten by the vault, still configured: nothing under it.
        { kid: "b", active: false, held: true, known: false, versions: 0 },
        {
          kid: "default",
          active: false,
          held: false,
          known: true,
          versions: 1,
        },
      ],
      remaining: 1,
    });
    await expect(c.reveal({ id: middle.id, actor: "t" })).resolves.toBe("B");
    await expect(c.reveal({ id: old.id, actor: "t" })).rejects.toThrow(
      VaultLockedError,
    );

    // With the first key back, the rest moves and that key is forgotten.
    const all = console({ masterKeys: `c:${KEY_C},default:${KEY_A}` });
    await expect(all.rewrap()).resolves.toEqual({ rewrapped: 1, remaining: 0 });
    await expect(
      console({ masterKeys: `c:${KEY_C}` }).reveal({ id: old.id, actor: "t" }),
    ).resolves.toBe("A");
  });

  it("keeps a key a write sealed under while the rewrap counted it empty", async () => {
    const { console, db } = start();
    const a = console({ masterKey: KEY_A });
    await a.put({ name: "s1", kind: "generic", value: "v1" });
    const rotating = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });

    // A Console that still holds only the old key writes right after the
    // rewrap counts the old key empty, before the rewrap forgets it.
    const findMany = db.findMany.bind(db);
    let wrote = false;
    vi.spyOn(db, "findMany").mockImplementation(async (model, options) => {
      const page = await findMany(model, options as never);
      if (
        !wrote &&
        model === "secret_versions" &&
        (options as { readonly where: { readonly kid?: string } }).where.kid ===
          "default" &&
        page.rows.length === 0
      ) {
        wrote = true;
        await a.put({ name: "s2", kind: "generic", value: "v2" });
      }
      return page as never;
    });

    // Counted before the late write: it reports none left, but keeps the
    // key the write used.
    await expect(rotating.rewrap()).resolves.toEqual({
      rewrapped: 1,
      remaining: 0,
    });
    expect(wrote).toBe(true);
    await expect(a.status()).resolves.toEqual({ locked: false });
    await expect(rotating.keys()).resolves.toMatchObject({ remaining: 1 });
    vi.mocked(db.findMany).mockRestore();

    await expect(rotating.rewrap()).resolves.toEqual({
      rewrapped: 1,
      remaining: 0,
    });
    const after = console({ masterKeys: `next:${KEY_B}` });
    const values = await Promise.all(
      (await after.list()).map(({ id }) => after.reveal({ id, actor: "t" })),
    );
    expect(values).toEqual(["v1", "v2"]);
    await expect(a.status()).resolves.toMatchObject({ locked: true });
  });

  it("keeps a key another Console's rewrap moves versions into while this one counts it empty", async () => {
    const { console, db } = start();
    const a = console({ masterKey: KEY_A });
    await a.put({ name: "s1", kind: "generic", value: "v1" });
    await a.put({ name: "s2", kind: "generic", value: "v2" });
    const next = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });
    // The vault knows "next" with nothing under it yet.
    const draft = await next.put({
      name: "draft",
      kind: "generic",
      value: "x",
    });
    await next.remove({ id: draft.id });

    // During a rolling deployment, the old Console rewraps too: right after
    // it counts "next" empty, the new Console moves one version into "next"
    // and, with one left under "default", forgets nothing.
    const findMany = db.findMany.bind(db);
    let moved = false;
    vi.spyOn(db, "findMany").mockImplementation(async (model, options) => {
      const page = await findMany(model, options as never);
      if (
        !moved &&
        model === "secret_versions" &&
        (options as { readonly where: { readonly kid?: string } }).where.kid ===
          "next" &&
        page.rows.length === 0
      ) {
        moved = true;
        await expect(next.rewrap({ batch: 1 })).resolves.toEqual({
          rewrapped: 1,
          remaining: 1,
        });
      }
      return page as never;
    });
    await a.rewrap().catch(() => undefined);
    expect(moved).toBe(true);
    vi.mocked(db.findMany).mockRestore();

    // The vault still knows "next", which holds a version now.
    const after = console({ masterKeys: `next:${KEY_B}` });
    await expect(after.status()).resolves.toEqual({ locked: false });
    const [underNext] = (
      await db.findMany("secret_versions", {
        index: "byKid",
        where: { kid: "next" },
        limit: 1,
      })
    ).rows;
    await expect(
      after.reveal({ id: underNext!.secret_id, actor: "t" }),
    ).resolves.toMatch(/^v[12]$/u);
  });

  it("rewraps while new versions are written and old ones pruned", async () => {
    const { console } = start();
    const a = console({ masterKey: KEY_A });
    for (let n = 1; n <= 5; n += 1) {
      await a.put({ name: "s", kind: "generic", value: `v${n}` });
    }
    const rotating = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });

    // Each write deletes the oldest kept version while the rewrap moves them.
    await Promise.all([
      rotating.rewrap({ batch: 2 }),
      rotating
        .put({ name: "s", kind: "generic", value: "v6" })
        .then(() => rotating.put({ name: "s", kind: "generic", value: "v7" })),
      rotating.rewrap({ batch: 2 }),
    ]);
    while ((await rotating.rewrap()).remaining > 0);

    const after = console({ masterKeys: `next:${KEY_B}` });
    const [secret] = await after.list();
    expect(secret?.version).toBe(7);
    await expect(after.reveal({ id: secret!.id, actor: "t" })).resolves.toBe(
      "v7",
    );
    await expect(after.keys()).resolves.toEqual({
      keys: [
        { kid: "next", active: true, held: true, known: true, versions: 5 },
      ],
      remaining: 0,
    });
  });

  it("checks a vault without a keys row against its stored versions, and starts the row", async () => {
    const { console, db } = start();
    const a = console({ masterKey: KEY_A });
    const stored = await a.put({ name: "s1", kind: "generic", value: "v1" });
    // A vault sealed before it kept key checks, or whose row was deleted.
    const dropKeysRow = () =>
      db.transaction(async (tx) => {
        const row = await tx.findOne("secrets", { id: ".master-keys" });
        if (row !== null) await tx.delete("secrets", row);
      });
    await dropKeysRow();

    const other = console({ masterKey: KEY_C });
    await expect(other.status()).resolves.toMatchObject({
      locked: true,
      knownKeys: ["default"],
    });
    await expect(
      other.put({ name: "s2", kind: "generic", value: "x" }),
    ).rejects.toThrow(VaultLockedError);
    await expect(
      console({ masterKeys: `next:${KEY_B}` }).put({
        name: "s2",
        kind: "generic",
        value: "x",
      }),
    ).rejects.toThrow('saved under the master key "default"');
    await expect(a.status()).resolves.toEqual({ locked: false });

    // Rotating starts the row from the key that opens what is stored.
    const rotating = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });
    await expect(rotating.keys()).resolves.toMatchObject({ remaining: 1 });
    await expect(rotating.rewrap()).resolves.toEqual({
      rewrapped: 1,
      remaining: 0,
    });
    const after = console({ masterKeys: `next:${KEY_B}` });
    await expect(after.reveal({ id: stored.id, actor: "t" })).resolves.toBe(
      "v1",
    );
    await expect(a.status()).resolves.toMatchObject({ locked: true });

    // A kid neither configured nor `default` is found through a live
    // secret, so an unrelated key is refused rather than taken.
    await dropKeysRow();
    const unrelated = console({ masterKey: KEY_C });
    await expect(unrelated.status()).resolves.toMatchObject({
      locked: true,
      knownKeys: ["next"],
    });
    await expect(
      unrelated.put({ name: "s3", kind: "generic", value: "x" }),
    ).rejects.toThrow('saved under the master key "next"');

    // A write starts it too, with the stored versions' key.
    await after.put({ name: "s3", kind: "generic", value: "v3" });
    await expect(unrelated.status()).resolves.toMatchObject({
      locked: true,
      knownKeys: ["next"],
    });
  });

  it("needs every key a vault without a keys row has versions under", async () => {
    const { console, db } = start();
    const a = console({ masterKey: KEY_A });
    const old = await a.put({ name: "old", kind: "generic", value: "A" });
    const rotating = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });
    const fresh = await rotating.put({
      name: "new",
      kind: "generic",
      value: "B",
    });
    // Deleted midway through the rotation: versions under two kids.
    await db.transaction(async (tx) => {
      const row = await tx.findOne("secrets", { id: ".master-keys" });
      if (row !== null) await tx.delete("secrets", row);
    });

    // Holding one of them is not enough to start the checks again.
    const newOnly = console({ masterKeys: `next:${KEY_B}` });
    await expect(newOnly.status()).resolves.toMatchObject({
      locked: true,
      knownKeys: ["next", "default"],
      message: expect.stringContaining('master key "default"'),
    });
    await expect(
      newOnly.put({ name: "other", kind: "generic", value: "x" }),
    ).rejects.toThrow(VaultLockedError);

    await expect(rotating.keys()).resolves.toMatchObject({ remaining: 1 });
    await expect(rotating.rewrap()).resolves.toEqual({
      rewrapped: 1,
      remaining: 0,
    });
    await expect(newOnly.reveal({ id: old.id, actor: "t" })).resolves.toBe("A");
    await expect(newOnly.reveal({ id: fresh.id, actor: "t" })).resolves.toBe(
      "B",
    );
  });

  it("forgets an old key with nothing under it, once every secret was removed", async () => {
    const { console } = start();
    const a = console({ masterKey: KEY_A });
    const stored = await a.put({ name: "s1", kind: "generic", value: "v1" });
    await a.remove({ id: stored.id });

    const rotating = console({ masterKeys: `next:${KEY_B},default:${KEY_A}` });
    // Nothing to move, but the vault still knows only the old key.
    await expect(rotating.keys()).resolves.toEqual({
      keys: [
        { kid: "next", active: true, held: true, known: false, versions: 0 },
        { kid: "default", active: false, held: true, known: true, versions: 0 },
      ],
      remaining: 0,
    });
    await expect(rotating.rewrap()).resolves.toEqual({
      rewrapped: 0,
      remaining: 0,
    });
    await expect(
      console({ masterKeys: `next:${KEY_B}` }).status(),
    ).resolves.toEqual({ locked: false });
    await expect(a.status()).resolves.toMatchObject({ locked: true });
  });

  it("names the keys a vault was saved with when the Console holds none", async () => {
    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEYS", "");
    vi.stubEnv("HOT_UPDATER_VAULT_MASTER_KEY", "");
    const { console } = start();
    const empty = console({});
    await expect(empty.status()).resolves.toEqual({
      locked: true,
      message:
        "The vault is locked: set HOT_UPDATER_VAULT_MASTER_KEY, or HOT_UPDATER_VAULT_MASTER_KEYS for named keys, where the Console runs to seal and reveal secrets.",
      knownKeys: [],
    });

    const rotated = await console({ masterKeys: `2026-10:${KEY_B}` }).put({
      name: "deploy",
      kind: "generic",
      value: "v",
    });
    const named =
      'The vault is locked: its secrets are saved under the master key "2026-10", which the Console does not hold. List it in HOT_UPDATER_VAULT_MASTER_KEYS as "2026-10:<key>", after the new key to rotate to the new one.';
    await expect(empty.status()).resolves.toEqual({
      locked: true,
      message: named,
      knownKeys: ["2026-10"],
    });
    // Writes, reveals, and rewraps say the same, as the Console routes'
    // 503 does, and keep the name the routes match.
    for (const refused of [
      empty.put({ name: "other", kind: "generic", value: "x" }),
      empty.reveal({ id: rotated.id, actor: "tok-ci" }),
      empty.rewrap(),
    ]) {
      await expect(refused).rejects.toMatchObject({
        name: "VaultLockedError",
        message: named,
      });
    }

    // A vault on the single key still points at its variable.
    const single = start().console;
    await single({ masterKey: KEY_A }).put({
      name: "deploy",
      kind: "generic",
      value: "v",
    });
    await expect(single({}).status()).resolves.toMatchObject({
      message: expect.stringContaining(
        'master key "default", which the Console does not hold. Set it in HOT_UPDATER_VAULT_MASTER_KEY',
      ),
    });
  });

  it("refuses a rewrap without a key or with a batch out of range", async () => {
    const { console } = start();
    await expect(console({}).rewrap()).rejects.toThrow(VaultLockedError);
    for (const batch of [0, 1001, 1.5]) {
      await expect(
        console({ masterKey: KEY_A }).rewrap({ batch }),
      ).rejects.toBeInstanceOf(VaultInputError);
    }
    // An empty vault has nothing to move.
    await expect(console({ masterKey: KEY_A }).rewrap()).resolves.toEqual({
      rewrapped: 0,
      remaining: 0,
    });
  });
});
