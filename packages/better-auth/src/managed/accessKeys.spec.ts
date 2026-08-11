import type {
  UniversalComponentDataSource,
  UniversalComponentRow,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  createUniversalComponentManagedAccessKeyStore,
  managedAccessKeyComponentSchema,
  managedAccessKeyId,
  type ManagedAccessKeyRecord,
} from "./accessKeys";

const firstHash = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";
const secondHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const record = (
  hash: string,
  createdAt: number,
  name: string,
): ManagedAccessKeyRecord => ({
  createdAt,
  enabled: true,
  hash,
  id: managedAccessKeyId(hash),
  name,
  prefix: "AAAAAA",
  revokedAt: null,
  role: "client",
});

const createSource = (): UniversalComponentDataSource => {
  const tables = new Map<string, Map<string, UniversalComponentRow>>();
  const table = (name: string) => {
    const existing = tables.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, UniversalComponentRow>();
    tables.set(name, created);
    return created;
  };
  return {
    schema: managedAccessKeyComponentSchema,
    append: async () => undefined,
    assertReady: async () => undefined,
    async create(input) {
      const rows = table(input.table);
      const id = input.row.id;
      if (typeof id !== "string") throw new TypeError("missing fixture id");
      if (rows.has(id)) return "existing";
      rows.set(id, structuredClone(input.row));
      return "created";
    },
    async get(input) {
      const row = table(input.table).get(input.primaryKey);
      return row === undefined ? null : structuredClone(row);
    },
    async orderedScan(input) {
      const rows = [...table("better_auth_managed_access_keys").values()]
        .toSorted(
          (left, right) =>
            (left.created_at_ms as number) - (right.created_at_ms as number) ||
            String(left.id).localeCompare(String(right.id)),
        )
        .filter((row) => {
          if (input.afterExclusive === undefined) return true;
          const [createdAt, id] = input.afterExclusive;
          if (typeof createdAt !== "number") {
            throw new TypeError("invalid fixture cursor");
          }
          return (
            (row.created_at_ms as number) > createdAt ||
            ((row.created_at_ms as number) === createdAt &&
              String(row.id).localeCompare(String(id)) > 0)
          );
        });
      return rows.slice(0, input.limit).map((row) => structuredClone(row));
    },
  };
};

describe("universal component managed access-key store", () => {
  it("owns an immutable canonical component schema", () => {
    expect(managedAccessKeyComponentSchema).toMatchObject({
      id: "better-auth-managed-access-keys",
      versions: [
        {
          version: "1",
          tables: [
            { name: "better_auth_managed_access_keys" },
            { name: "better_auth_managed_access_key_revocations" },
          ],
        },
      ],
    });
    expect(Object.isFrozen(managedAccessKeyComponentSchema)).toBe(true);
  });

  it("creates by deterministic identity without overwriting", async () => {
    const store = createUniversalComponentManagedAccessKeyStore(createSource());
    const original = record(firstHash, 1, "Original");

    await expect(store.create(original)).resolves.toBe("created");
    await expect(
      store.create({ ...original, name: "Replacement" }),
    ).resolves.toBe("existing");
    await expect(store.findByHash(firstHash)).resolves.toEqual(original);
  });

  it("derives revocation records, sorts keys, and invalidates once", async () => {
    const onRevoke = vi.fn(async () => undefined);
    const store = createUniversalComponentManagedAccessKeyStore(
      createSource(),
      {
        onRevoke,
      },
    );
    const first = record(firstHash, 1, "First");
    const second = record(secondHash, 2, "Second");
    await store.create(first);
    await store.create(second);

    const revoked = await store.revoke({ id: first.id, revokedAt: 3 });
    const repeated = await store.revoke({ id: first.id, revokedAt: 4 });

    expect(revoked).toEqual({ ...first, enabled: false, revokedAt: 3 });
    expect(repeated).toEqual(revoked);
    await expect(store.list()).resolves.toEqual([second, revoked]);
    expect(onRevoke).toHaveBeenCalledOnce();
  });

  it("rejects a source bound to a different feature schema", () => {
    expect(() =>
      createUniversalComponentManagedAccessKeyStore({
        ...createSource(),
        schema: { ...managedAccessKeyComponentSchema, id: "other" },
      }),
    ).toThrow("Invalid managed access-key component source");
  });
});
