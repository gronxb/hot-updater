import type { ApiKeyModel, ApiKeyRow } from "@hot-updater/plugin-core";

import type { HotUpdaterDatabase } from "../../database/database";
import { DatabaseConstraintError } from "../../database/errors";
import type { ApiKeysSchema } from "./schema";

const toRow = (row: Readonly<Record<string, unknown>>): ApiKeyRow =>
  ({
    id: row.id,
    hash: row.hash,
    name: row.name,
    prefix: row.prefix,
    role: row.role,
    created_at_ms: row.created_at_ms,
    revoked_at_ms: row.revoked_at_ms,
  }) as ApiKeyRow;

/** Today's `ApiKeyModel` on the engine: one unique read by hash, keyed writes. */
export const createApiKeyModel = (
  db: HotUpdaterDatabase<ApiKeysSchema>,
): ApiKeyModel => ({
  async create(row) {
    try {
      return await db.transaction(async (tx) => {
        if ((await tx.findOne("api_keys", { hash: row.hash })) !== null) {
          return "existing" as const;
        }
        tx.create("api_keys", row);
        return "created" as const;
      });
    } catch (error) {
      if (error instanceof DatabaseConstraintError && error.reason === "unique")
        return "existing";
      throw error;
    }
  },
  async findByHash(hash) {
    const row = await db.findOne("api_keys", { hash });
    return row === null ? null : toRow(row);
  },
  /** Every key, newest first, then by id; the whole list is the result. */
  async list() {
    const rows: ApiKeyRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await db.findMany("api_keys", {
        index: "byCreated",
        where: {},
        order: "desc",
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      rows.push(...page.rows.map(toRow));
      cursor = page.next;
    } while (cursor !== undefined);
    return rows.sort(
      (left, right) =>
        right.created_at_ms - left.created_at_ms ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  },
  revoke: ({ id, revokedAtMs }) =>
    db.transaction(async (tx) => {
      const row = await tx.findOne("api_keys", { id });
      if (row === null) return null;
      tx.update("api_keys", row, { revoked_at_ms: revokedAtMs });
      return toRow({ ...row, revoked_at_ms: revokedAtMs });
    }),
});
