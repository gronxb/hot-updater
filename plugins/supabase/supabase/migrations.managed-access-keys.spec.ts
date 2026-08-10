import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260810000000_hot-updater_managed_access_keys.sql",
);
const databases: PGlite[] = [];

const createDatabase = (): PGlite => {
  const database = new PGlite();
  databases.push(database);
  return database;
};

const migrate = async (database: PGlite): Promise<void> => {
  await database.exec(await fs.readFile(migrationPath, "utf8"));
};

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

describe("Supabase managed access-key migration", () => {
  it("installs an idempotent RLS-protected table with lookup indexes", async () => {
    const database = createDatabase();

    await migrate(database);
    await migrate(database);

    const table = await database.query<{ readonly relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'managed_access_keys'::regclass",
    );
    expect(table.rows).toEqual([{ relrowsecurity: true }]);
    const indexes = await database.query<{ readonly indexname: string }>(`
      select indexname from pg_indexes
      where tablename = 'managed_access_keys'
      order by indexname
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "managed_access_keys_created_at_idx",
      "managed_access_keys_hash_key",
      "managed_access_keys_pkey",
    ]);
  });

  it("enforces client roles and consistent revocation state", async () => {
    const database = createDatabase();
    await migrate(database);

    await expect(
      database.exec(`
        insert into managed_access_keys
          (id, hash, name, prefix, role, enabled, created_at_ms, revoked_at_ms)
        values ('invalid-role', 'hash-1', 'Invalid', 'AAAAAA', 'admin', true, 1, null)
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        insert into managed_access_keys
          (id, hash, name, prefix, role, enabled, created_at_ms, revoked_at_ms)
        values ('invalid-state', 'hash-2', 'Invalid', 'AAAAAA', 'client', false, 1, null)
      `),
    ).rejects.toThrow();
  });
});
