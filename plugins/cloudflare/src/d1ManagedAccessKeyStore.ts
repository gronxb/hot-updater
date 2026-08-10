import type {
  ManagedAccessKeyRecord,
  ManagedAccessKeyStore,
} from "@hot-updater/better-auth/managed";

import type { D1Executor } from "./d1Implementation";

const parseNumber = (value: unknown, field: string): number => {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new TypeError(`Invalid managed access-key ${field}.`);
  }
  return number;
};

const parseRecord = (value: unknown): ManagedAccessKeyRecord => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Invalid managed access-key row.");
  }
  const id = Reflect.get(value, "id");
  const hash = Reflect.get(value, "hash");
  const name = Reflect.get(value, "name");
  const prefix = Reflect.get(value, "prefix");
  const role = Reflect.get(value, "role");
  const enabled = Reflect.get(value, "enabled");
  const revokedAt = Reflect.get(value, "revoked_at_ms");
  if (
    typeof id !== "string" ||
    typeof hash !== "string" ||
    typeof name !== "string" ||
    typeof prefix !== "string" ||
    role !== "client" ||
    (enabled !== true && enabled !== false && enabled !== 0 && enabled !== 1) ||
    (revokedAt !== null &&
      revokedAt !== undefined &&
      typeof revokedAt !== "number")
  ) {
    throw new TypeError("Invalid managed access-key row.");
  }
  return {
    createdAt: parseNumber(Reflect.get(value, "created_at_ms"), "createdAt"),
    enabled: enabled === true || enabled === 1,
    hash,
    id,
    name,
    prefix,
    revokedAt:
      revokedAt === null || revokedAt === undefined
        ? null
        : parseNumber(revokedAt, "revokedAt"),
    role,
  };
};

export const createD1ManagedAccessKeyStoreFromExecutor = (
  executor: D1Executor,
): ManagedAccessKeyStore => ({
  async create(record) {
    const rows = await executor.query(
      `INSERT INTO managed_access_keys
        (id, hash, name, prefix, role, enabled, created_at_ms, revoked_at_ms)
       VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
       ON CONFLICT(hash) DO NOTHING
       RETURNING id`,
      [
        record.id,
        record.hash,
        record.name,
        record.prefix,
        record.role,
        String(record.createdAt),
      ],
    );
    return rows.length === 0 ? "existing" : "created";
  },
  async findByHash(hash) {
    const rows = await executor.query(
      "SELECT * FROM managed_access_keys WHERE hash = ? LIMIT 1",
      [hash],
    );
    return rows[0] === undefined ? null : parseRecord(rows[0]);
  },
  async list() {
    const rows = await executor.query(
      "SELECT * FROM managed_access_keys ORDER BY created_at_ms DESC, id ASC",
      [],
    );
    return rows.map(parseRecord);
  },
  async revoke({ id, revokedAt }) {
    const rows = await executor.query(
      `UPDATE managed_access_keys
       SET enabled = 0, revoked_at_ms = COALESCE(revoked_at_ms, ?)
       WHERE id = ?
       RETURNING *`,
      [String(revokedAt), id],
    );
    return rows[0] === undefined ? null : parseRecord(rows[0]);
  },
});
