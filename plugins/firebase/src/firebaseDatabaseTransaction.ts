import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import type {
  DatabaseWhere,
  DatabaseImplementationResult,
  DatabaseModel,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import type { Transaction } from "firebase-admin/firestore";

import {
  type FirebaseDatabaseCollections,
  persistFirebaseDatabaseSnapshot,
} from "./firebaseDatabasePersistence";
import { createFirebaseReads } from "./firebaseDatabaseReads";
import {
  cloneFirebaseDatabaseSnapshot,
  FirebaseDatabaseConstraintError,
  type FirebaseDatabaseSnapshot,
} from "./firebaseDatabaseState";

// Stage writes until the callback finishes: Firestore requires all reads before writes.
// Keep only rows addressed by the operation, including its foreign keys and cascades.
export const createFirebaseTransaction = (
  transaction: Transaction,
  collections: FirebaseDatabaseCollections,
) => {
  const before: FirebaseDatabaseSnapshot = {
    bundles: new Map(),
    bundlePatches: new Map(),
    bundleEvents: new Map(),
    channels: new Map(),
    apiKeys: new Map(),
    releases: new Map(),
    releaseCatalogs: new Map(),
  };
  const after = cloneFirebaseDatabaseSnapshot(before);
  const reads = createFirebaseReads(collections, async () => {}, transaction);
  const maps = {
    bundles: "bundles",
    bundle_patches: "bundlePatches",
    bundle_events: "bundleEvents",
    channels: "channels",
    api_keys: "apiKeys",
    releases: "releases",
    release_catalogs: "releaseCatalogs",
  } as const;
  const rows = (snapshot: FirebaseDatabaseSnapshot, model: DatabaseModel) =>
    snapshot[maps[model]] as Map<string, DatabaseImplementationResult>;
  const rowKey = (row: DatabaseImplementationResult): string => {
    const key =
      "id" in row ? row.id : "scope_key" in row ? row.scope_key : undefined;
    if (typeof key !== "string")
      throw new DatabasePluginInputError("invalid-result");
    return key;
  };
  const loaded = new Set<string>();
  const keyOf = (model: DatabaseModel, field: string, value: string) =>
    JSON.stringify([model, field, value]);
  const selector = (
    model: DatabaseModel,
    where:
      | readonly { [M in DatabaseModel]: DatabaseWhere<M> }[DatabaseModel][]
      | undefined,
  ) => {
    const condition = where?.length === 1 ? where[0] : undefined;
    if (
      !condition ||
      typeof condition.value !== "string" ||
      (condition.operator ?? "eq") !== "eq" ||
      ("mode" in condition && condition.mode === "insensitive")
    )
      throw new DatabasePluginInputError("invalid-operation");
    const { field, value } = condition;
    if (
      field === "id" ||
      (model === "release_catalogs" && field === "scope_key") ||
      (model === "channels" && field === "name") ||
      (model === "api_keys" && field === "hash")
    )
      return { field, value };
    throw new DatabasePluginInputError("invalid-operation");
  };
  const lookup = (
    model: DatabaseModel,
    field: "id" | "scope_key" | "name" | "hash",
    value: string,
  ) => {
    if (field === "name") {
      for (const row of after.channels.values())
        if (row.name === value) return row;
      return null;
    }
    if (field === "hash") {
      for (const row of after.apiKeys.values())
        if (row.hash === value) return row;
      return null;
    }
    return rows(after, model).get(value) ?? null;
  };
  const remember = (
    model: DatabaseModel,
    row: DatabaseImplementationResult | null,
  ) => {
    if (row === null) return;
    const key = rowKey(row);
    loaded.add(
      keyOf(model, model === "release_catalogs" ? "scope_key" : "id", key),
    );
    const oldRows = rows(before, model),
      newRows = rows(after, model);
    if (!oldRows.has(key)) {
      oldRows.set(key, row);
      if (!newRows.has(key)) newRows.set(key, row);
    }
  };
  const findReleaseReference = async (
    field: "bundle_id" | "channel_id",
    value: string,
  ) => {
    for (const row of after.releases.values())
      if (row[field] === value) return { id: row.id };
    const deleted = new Set<string>();
    for (const row of before.releases.values())
      if (row[field] === value && after.releases.get(row.id)?.[field] !== value)
        deleted.add(row.id);
    // Staged deletions/replacements can precede the first surviving witness.
    const witnesses = await reads.findMany({
      model: "releases",
      where: [field === "bundle_id" ? { field, value } : { field, value }],
      select: ["id"],
      limit: deleted.size + 1,
      offset: 0,
    });
    // These ID-only witnesses must not enter the full-row staging cache.
    return (
      witnesses.find(
        (row) =>
          "id" in row && typeof row.id === "string" && !deleted.has(row.id),
      ) ?? null
    );
  };
  const findOne: TransactionDatabasePluginImplementation["findOne"] = async (
    input,
  ) => {
    const condition = input.where?.length === 1 ? input.where[0] : undefined;
    if (
      input.model === "releases" &&
      input.select?.length === 1 &&
      input.select[0] === "id" &&
      condition &&
      (condition.field === "bundle_id" || condition.field === "channel_id") &&
      typeof condition.value === "string" &&
      (condition.operator ?? "eq") === "eq" &&
      !("mode" in condition && condition.mode === "insensitive")
    )
      return findReleaseReference(condition.field, condition.value);
    const { field, value } = selector(input.model, input.where);
    const staged = lookup(input.model, field, value);
    const key = keyOf(input.model, field, value);
    if (staged !== null || loaded.has(key)) return staged;
    // Staging must retain complete rows for later updates and persistence.
    remember(input.model, await reads.findOne({ ...input, select: undefined }));
    loaded.add(key);
    return lookup(input.model, field, value);
  };
  const loadPatches = async (
    field: "bundle_id" | "base_bundle_id",
    id: string,
  ) => {
    let cursor: string | undefined;
    while (true) {
      const where: DatabaseWhere<"bundle_patches">[] = [
        field === "bundle_id"
          ? { field: "bundle_id", value: id }
          : { field: "base_bundle_id", value: id },
      ];
      if (cursor !== undefined)
        where.push({ field: "id", operator: "gt", value: cursor });
      const rows = await reads.findMany({
        model: "bundle_patches",
        where,
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      });
      for (const row of rows) remember("bundle_patches", row);
      if (rows.length < 100) break;
      const last = rows.at(-1);
      if (last === undefined || !("id" in last))
        throw new DatabasePluginInputError("invalid-result");
      cursor = last.id;
    }
  };
  const database: TransactionDatabasePluginImplementation = {
    findOne,
    async findMany() {
      throw new DatabasePluginInputError("invalid-operation");
    },
    async count(input) {
      // Keep cardinality exact. Bounded reference witnesses use findOne above.
      const condition = input.where?.length === 1 ? input.where[0] : undefined;
      if (
        input.model !== "releases" ||
        input.distinct !== undefined ||
        !condition ||
        (condition.field !== "bundle_id" && condition.field !== "channel_id") ||
        (condition.operator ?? "eq") !== "eq" ||
        typeof condition.value !== "string"
      )
        throw new DatabasePluginInputError("invalid-operation");
      const { field, value } = condition;
      const count = (snapshot: FirebaseDatabaseSnapshot) =>
        [...snapshot.releases.values()].filter((row) => row[field] === value)
          .length;
      return (await reads.count(input)) - count(before) + count(after);
    },
    async create(input) {
      if (input.model === "release_catalogs") {
        await findOne({
          model: input.model,
          where: [{ field: "scope_key", value: input.data.scope_key }],
        });
      } else if (input.model !== "bundle_events") {
        await findOne({
          model: input.model,
          where: [{ field: "id", value: input.data.id }],
        });
      }
      if (input.model === "channels")
        await findOne({
          model: "channels",
          where: [{ field: "name", value: input.data.name }],
        });
      if (input.model === "api_keys")
        await findOne({
          model: "api_keys",
          where: [{ field: "hash", value: input.data.hash }],
        });
      if (input.model === "bundle_patches") {
        await findOne({
          model: "bundles",
          where: [{ field: "id", value: input.data.bundle_id }],
        });
        await findOne({
          model: "bundles",
          where: [{ field: "id", value: input.data.base_bundle_id }],
        });
      }
      if (input.model === "releases") {
        await findOne({
          model: "channels",
          where: [{ field: "id", value: input.data.channel_id }],
        });
        if (input.data.bundle_id !== null)
          await findOne({
            model: "bundles",
            where: [{ field: "id", value: input.data.bundle_id }],
          });
      }
      const current = rows(after, input.model);
      if (input.model === "channels") {
        const existing = after.channels.get(input.data.id);
        if (existing && existing.name !== input.data.name)
          throw new FirebaseDatabaseConstraintError("channels.id.unique");
      }
      if (input.model === "channels" || input.model === "api_keys") {
        const field = input.model === "channels" ? "name" : "hash";
        const value =
          input.model === "channels" ? input.data.name : input.data.hash;
        const existing = lookup(input.model, field, value);
        if (existing !== null && input.onConflict === "ignore") return existing;
        if (existing !== null)
          throw new FirebaseDatabaseConstraintError(
            `${input.model}.${field}.unique`,
          );
      }
      if (current.has(rowKey(input.data)))
        throw new FirebaseDatabaseConstraintError(`${input.model}.id.unique`);
      if (input.model === "bundle_patches") {
        for (const id of [input.data.bundle_id, input.data.base_bundle_id])
          if (!after.bundles.has(id))
            throw new FirebaseDatabaseConstraintError(
              "bundle_patches.bundle.foreign-key",
            );
      }
      if (
        input.model === "releases" &&
        (!after.channels.has(input.data.channel_id) ||
          (input.data.bundle_id !== null &&
            !after.bundles.has(input.data.bundle_id)))
      )
        throw new FirebaseDatabaseConstraintError("releases.foreign-key");
      current.set(rowKey(input.data), input.data);
      return input.data;
    },
    async update(input) {
      const current = await findOne(input);
      if (current === null) return null;
      const updated = { ...current, ...input.update };
      rows(after, input.model).set(rowKey(current), updated);
      return updated;
    },
    async delete(input) {
      if (input.model === "bundle_patches") {
        const owner = input.where?.length === 1 ? input.where[0] : undefined;
        if (
          owner?.field !== "bundle_id" ||
          typeof owner.value !== "string" ||
          (owner.operator ?? "eq") !== "eq"
        )
          throw new DatabasePluginInputError("invalid-operation");
        await loadPatches("bundle_id", owner.value);
        for (const [id, row] of after.bundlePatches)
          if (row.bundle_id === owner.value) after.bundlePatches.delete(id);
        return;
      }
      const row = await findOne(input);
      if (row === null) return;
      const id = rowKey(row);
      if (input.model === "bundles") {
        await loadPatches("bundle_id", id);
        await loadPatches("base_bundle_id", id);
        for (const [patchId, patch] of after.bundlePatches)
          if (patch.bundle_id === id || patch.base_bundle_id === id)
            after.bundlePatches.delete(patchId);
      }
      rows(after, input.model).delete(id);
    },
  };
  return {
    database,
    persist: () =>
      persistFirebaseDatabaseSnapshot({
        transaction,
        collections,
        before,
        after,
      }),
  };
};
